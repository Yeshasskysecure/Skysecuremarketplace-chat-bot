# Backend Folder — Overall Working (Detailed)

## What this backend is

This folder is a small Node.js + Express service that exposes a chatbot API for **SkySecure Marketplace**. The backend’s core job is:

- Accept a user message + conversation history from the frontend.
- Gather “marketplace context” (products, categories, marketplace signals).
- Build a large system prompt that includes that context.
- Call **Azure OpenAI Chat Completions**.
- Return the model’s answer (plus suggested quick replies + stage metadata) back to the frontend.

The main runtime entrypoint is `server.js:1`.

---

## Folder layout (what each top-level file/folder does)

- `server.js`
  - The Express server and the only HTTP API surface in this repo (`/health`, `/api/chat`).
  - Orchestrates the whole chat flow: validation → context assembly → prompt building → Azure OpenAI call → response.
- `polyfill.js`
  - Adds a minimal `globalThis.File` (and `FileReader`) polyfill for Node 18 compatibility (`server.js:2` imports it first).
- `utils/`
  - All logic is in “utility” modules: data loading, intent mapping, semantic search embeddings, prompt builder, category fetching, etc.
- `utils/data/`
  - Local JSON datasets used as the backend’s primary product catalog and marketplace “signals”.
    - `products_normalized.json`: primary product dataset (loaded into memory and used to answer questions).
    - `marketplace_signals.json`: lists of IDs for “featured”, “bestSelling”, “recentlyAdded”.
    - `category_rankings.json`, `oem_rankings.json`: mappings of category/OEM → productIds.
- `.env.example`
  - Example environment variable file (copy to `.env` for local development).
- `package.json`
  - Declares dependencies and run scripts (`npm start`, `npm run dev`).

---

## HTTP API surface (what the frontend calls)

This backend defines only these endpoints in `server.js`:

- `GET /health` (`server.js:67`)  
  Returns `{"status":"ok","message":"Chatbot backend is running"}`.
- `POST /api/chat` (`server.js:191`)  
  Main chatbot endpoint used by the frontend.
- `OPTIONS /api/chat` (`server.js:73`)  
  Explicit CORS preflight handler for browsers.

Additionally, there is a global CORS middleware (`server.js:28`) that sets:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS, PUT, DELETE`
- `Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Authorization`

This is what allows a separate frontend (different domain/port) to call this backend from the browser.

---

## Request lifecycle: `POST /api/chat`

### 1) Request validation

In `server.js:191`:

- Reads JSON body: `{ message, conversationHistory = [] }`.
- Rejects empty `message` (HTTP 400).
- Rejects missing Azure OpenAI config (HTTP 500).

### 2) Parallel “context fetch” kickoff

The handler immediately starts these tasks in parallel (`server.js:216`):

- `loadProductsFromJSON()` (`utils/productLoader.js:15`)
  - Loads `utils/data/products_normalized.json` once and caches it in memory.
- `loadMarketplaceSignals()` (`utils/marketplaceSignalsLoader.js:20`)
  - Loads marketplace ranking/signal JSON files and caches them in memory.
- `fetchCategoryHierarchy()` (`utils/categoryFetcher.js:25`)
  - Calls an external SkySecure product service API to fetch live categories + OEMs.
- `resolveIntent(message, baseUrl)` (`utils/intentMapper.js:183`)
  - Uses the category/OEM lists to map the user message to a subcategory and/or OEM.

This parallelism reduces perceived latency because the backend is waiting on multiple slow operations at once instead of sequentially.

### 3) Fast-path: greetings and off-topic

After intent resolution returns, the backend checks (`server.js:226`):

- `isGreeting(message)` (`utils/intentMapper.js:293`)
- `isDomainRelated(message, intentInfo)` (`utils/intentMapper.js:263`)

If it’s a greeting or off-topic, it:

- Builds a small “fast” system prompt (`server.js:232`).
- Sends only the last ~3 history messages to Azure (`server.js:238`).
- Returns early with:
  - `success: true`
  - `message: <model response>`
  - `quickReplies` (only for greetings)
  - `conversationStage: "Discovery"`

This keeps “hello” / “not related” responses quick and cheaper.

### 4) Determine conversation stage + quick replies

If not fast-pathed, the backend computes stage in two ways:

- `inferConversationStage(...)` (`utils/intentMapper.js:248`) → simple heuristic stage
- `trackConversationState(...)` (`utils/conversationManager.js:23`) → richer “guided sales” state machine

Then it derives:

- `stagePrompt = getStagePrompt(stage, context)` (`utils/conversationManager.js:117`)
- `quickReplies = suggestQuickReplies(stage, intentInfo)` (`utils/conversationManager.js:238`)

### 5) Load products and (optionally) build an in-memory semantic index

Products are loaded from JSON (`server.js:272`):

- First run:
  - Converts products to text chunks: `productsToTextChunks(...)` (`utils/productLoader.js:186`)
  - Calls `indexProductChunks(...)` (`utils/embeddingService.js:217`) to embed and store vectors in memory.
  - Sets `isIndexed = true` in `server.js:22` so it only happens once per server process.
  - Indexing is bounded by a 30s timeout (`server.js:283`) so it won’t block forever.
- Subsequent runs:
  - Skips indexing; reuses the in-memory vector store.

The vector store is purely in-memory (`utils/embeddingService.js:8`). Restarting the server resets it.

### 6) Semantic search (retrieve “most relevant products”)

If indexing is ready, it tries to retrieve relevant chunks for the user query (`server.js:296`):

- Calls `getRelevantContent(message, 10)` (`utils/embeddingService.js:255`)
- Bounded by a 2s timeout (`server.js:300`)

This produces a string block that looks like:

- `=== MOST RELEVANT CONTENT FOR: "<query>" ===`
- Chunk text + relevance scores

That string is injected into the system prompt to bias the model toward the most relevant products without dumping the entire catalog.

### 7) Enrich products using “marketplace signals”

Marketplace signals are loaded from JSON and then applied to the in-memory product objects (`server.js:316`):

- Sets `product.isTopSelling = true` based on `marketplaceSignals.bestSelling`
- Sets `product.isFeatured = true` based on `marketplaceSignals.featured`
- Sets `product.isLatest = true` based on `marketplaceSignals.recentlyAdded`

This enables special prompt sections like “Featured”, “Best selling”, “Recently added”.

### 8) Fetch and format the live category hierarchy + OEMs

The backend fetches “live” category hierarchy from the external product service (`server.js:450`):

- Uses a 15s timeout (`server.js:454`)
- Formats the hierarchy string via `formatCategoryHierarchyForKnowledgeBase(...)` (`utils/categoryFetcher.js:118`)
  - Includes main categories, sub-categories, and sub-sub-categories.
  - Also includes an OEM list with product counts.

If the live call fails, a fallback “Unable to fetch category hierarchy…” string is used (`server.js:466`).

### 9) Build the “product knowledge base” text block

This backend uses a large “product knowledge base” string as part of the system prompt.

The main builder used in the request is:

- `formatProductsForKnowledgeBase(productsFromJSON, false)` (`server.js:475`)
  - Implementation: `utils/productFetcher.js:875`
  - `includeFullList=false` means it avoids dumping the entire catalog to keep token usage down.
  - Still emits many structured sections, including:
    - A category summary
    - Per-subcategory product listings
    - `=== SQL PRODUCTS ===` section (special handling rules inside the prompt)
    - `=== FEATURED PRODUCTS ===`
    - `=== TOP SELLING / BEST SELLING PRODUCTS ===`
    - `=== RECENTLY ADDED PRODUCTS ===`

Then it optionally augments the knowledge base with category/OEM-specific lists based on the query text using:

- `augmentKnowledgeBaseWithSignals(...)` (`server.js:89`)
  - Uses `category_rankings.json` and `oem_rankings.json` to add targeted sections when the user asks for categories, best sellers, or specific vendors.

### 10) Build the system prompt (prompt engineering layer)

The system prompt is generated by:

- `generateSystemPrompt({ ... })` (`server.js:493`, implemented in `utils/promptBuilder.js:4`)

It combines:

- “Rules” for how the assistant must behave (formatting, out-of-scope handling).
- Conversation stage instructions (`stagePrompt`).
- Semantic search results (`relevantContent`) when available.
- Category hierarchy (`categoryHierarchy`).
- Product knowledge base (`productKnowledgeBase`).

### 11) Build the messages array and call Azure OpenAI

The request to Azure is made using:

- `makeRequest(...)` (`utils/httpClient.js:8`)
  - Uses Node’s built-in `https`/`http` modules and enforces a timeout.

The backend sends:

- System prompt
- Up to last 10 conversation messages (`server.js:511`)
- The new user message (`server.js:520`)

Azure endpoint used:

- `POST {AZURE_OPENAI_ENDPOINT}/openai/deployments/{DEPLOYMENT_NAME}/chat/completions?api-version=2024-02-15-preview` (`server.js:531`)

Timeout behavior:

- HTTP client timeout of 120s (`server.js:560`)
- Additional 120s Promise timeout wrapper (`server.js:548`)

### 12) Response back to frontend

Success response payload (`server.js:575`):

```json
{
  "success": true,
  "message": "<bot markdown response>",
  "quickReplies": [{ "text": "...", "value": "..." }],
  "conversationStage": "Discovery|Narrowing|Recommendation|Conversion"
}
```

Error response payload (`server.js:595`):

```json
{
  "success": false,
  "message": "<error message>",
  "error": "<stack trace only when NODE_ENV=development>"
}
```

---

## How intent mapping works (how it knows “what category is this?”)

The intent mapper is in `utils/intentMapper.js`.

Key idea:

- It fetches live categories/OEMs periodically (10 minute TTL) and builds a keyword map (`utils/intentMapper.js:58`).
- If the live API is down, it falls back to a hardcoded mapping (`utils/intentMapper.js:12`).

Output shape returned by `resolveIntent(...)` (`utils/intentMapper.js:183`):

- `subCategoryId`: matched subcategory id (if detected)
- `categoryName`: matched subcategory label
- `oemId`: matched OEM id (if detected)
- `listingUrls`: marketplace URLs like:
  - `/products?subCategoryId=...`
  - `/products?oemId=...`
- `confidence`: heuristic confidence score

This output is used by the conversation stage logic and is included in the system prompt.

---

## Semantic search / embeddings (why it exists, how it works)

Implemented in `utils/embeddingService.js`.

- Stores `{ chunks, embeddings }` in memory (`utils/embeddingService.js:9`).
- Uses Azure embeddings endpoint:
  - `POST {AZURE_OPENAI_ENDPOINT}/openai/deployments/{AZURE_OPENAI_EMBEDDING_MODEL}/embeddings?api-version=2024-02-15-preview` (`utils/embeddingService.js:41`)
- Embedding calls are batched (5 at a time) and limited to max 100 chunks (`utils/embeddingService.js:28`).
- Uses cosine similarity (`utils/embeddingService.js:133`) to retrieve top-k relevant chunks.

Practical consequence:

- The model gets a “retrieval” block of the most relevant product chunks, improving accuracy and reducing hallucination.
- On cold start (first request after server start), indexing may take time and can be skipped if it times out; subsequent requests improve once `isIndexed` becomes `true`.

---

## Data sources (what is “live” vs “local”)

This backend uses a mix of local JSON files and live API calls:

- Local (checked into this repo):
  - `utils/data/products_normalized.json` → primary product catalog in runtime.
  - `utils/data/marketplace_signals.json` + rankings JSON → “featured/best-selling/recent” and category/vendor groupings.
- Live (external HTTP calls):
  - Category + OEM hierarchy is fetched from `PRODUCT_SERVICE_BACKEND_URL` via `utils/categoryFetcher.js:25`.
- Live (Azure):
  - Chat completions and embeddings depend on Azure OpenAI.

---

## How this backend connects to the frontend

### Connection model

There is no server-side rendering here and the backend does not serve frontend assets. The connection is purely:

- Frontend (browser) → HTTP fetch/XHR → Backend `/api/chat` → Azure OpenAI → Backend → Frontend.

### What the frontend must do

From the backend’s perspective, the frontend must:

- Send `POST` requests to `http://<backend-host>:3001/api/chat`
- With `Content-Type: application/json`
- With JSON body:
  - `message` (string)
  - `conversationHistory` (array of `{ from: "user"|"bot", text: string }`)

Example request:

```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Show me best selling products\",\"conversationHistory\":[]}"
```

### Why the browser is allowed to call it (CORS)

Browsers enforce cross-origin restrictions. This backend explicitly allows it by setting:

- `Access-Control-Allow-Origin: *` (`server.js:30`)

So the frontend can run at (for example) `http://localhost:3000` and still call `http://localhost:3001`.

### Typical frontend configuration

This repo’s setup guides expect the frontend to point at the backend with an env var like:

- `NEXT_PUBLIC_CHATBOT_API_URL=http://localhost:3001/api/chat`

When using a public dev tunnel (or ngrok), that URL becomes the tunnel URL (still ending in `/api/chat`).

---

## Environment variables (what matters at runtime)

The backend reads environment variables in `server.js:19` (via `dotenv.config()`).

Important variables:

- `PORT`
  - Express listen port (defaults to `3001`).
- `AZURE_OPENAI_ENDPOINT`
  - Base Azure OpenAI resource URL (no trailing slash required; code normalizes it).
- `AZURE_OPENAI_API_KEY`
  - Key used for both chat and embeddings calls.
- `AZURE_AI_AGENT_MODEL_DEPLOYMENT_NAME`
  - Chat model deployment name (defaults to `gpt-4o`).
- `AZURE_OPENAI_EMBEDDING_MODEL`
  - Embedding deployment name (defaults to `text-embedding-3-large`).
- `PRODUCT_SERVICE_BACKEND_URL`
  - External SkySecure product API host used for category + OEM hierarchy.
- `KNOWLEDGE_BASE_URL`
  - Base URL used when building listing URLs and intent resolution defaults.

---

## In practice: “one message end-to-end” in one paragraph

When the frontend sends a user message to `POST /api/chat`, the backend loads the product catalog from `products_normalized.json`, enriches it with “featured/best-selling/recently-added” flags from local JSON signals, optionally performs semantic search using Azure embeddings to find the most relevant product chunks, fetches live category/OEM hierarchy from the external product API, builds a large system prompt combining all of that, calls Azure OpenAI chat completions, and returns the generated markdown response plus suggested quick-reply actions back to the frontend.

