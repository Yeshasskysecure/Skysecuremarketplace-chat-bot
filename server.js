// IMPORTANT: Import polyfill FIRST before any other modules
import './polyfill.js';

import express from "express";
import dotenv from "dotenv";
import { makeRequest } from "./utils/httpClient.js";
import { fetchAllProducts, formatProductsForKnowledgeBase } from "./utils/productFetcher.js";
import { fetchCategoryHierarchy, formatCategoryHierarchyForKnowledgeBase } from "./utils/categoryFetcher.js";
import { scrapeAllPages, scrapeListingProducts } from "./utils/websiteScraper.js";
import { resolveIntent, inferConversationStage, isDomainRelated, isGreeting } from "./utils/intentMapper.js";
import { scrapeEntireWebsite } from "./utils/comprehensiveScraper.js";
// Embedding service re-enabled with optimizations
import { indexContent, indexProductChunks, getRelevantContent, needsUpdate } from "./utils/embeddingService.js";
import { trackConversationState, getStagePrompt, generateGuidingQuestion, suggestQuickReplies } from "./utils/conversationManager.js";
import { loadProductsFromJSON, productsToTextChunks } from "./utils/productLoader.js";
import { loadMarketplaceSignals, resolveProductsByIds } from "./utils/marketplaceSignalsLoader.js";

dotenv.config();

// Global flag to track if products have been indexed for semantic search
let isIndexed = false;

const app = express();
const PORT = process.env.PORT || 3001;

// CORS middleware - must be before routes
app.use((req, res, next) => {
  // Set CORS headers on every response
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Max-Age', '3600');

  // Handle preflight requests explicitly
  if (req.method === 'OPTIONS') {
    console.log('OPTIONS preflight request received');
    return res.status(200).end();
  }

  next();
});

app.use(express.json());

// Logging middleware for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const DEPLOYMENT_NAME = process.env.AZURE_AI_AGENT_MODEL_DEPLOYMENT_NAME || "gpt-4o";
const API_VERSION = "2024-02-15-preview";

// Validate configuration
if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
  console.error("Missing Azure OpenAI credentials. Please check your .env file.");
} else {
  console.log(`Azure OpenAI configured with deployment: ${DEPLOYMENT_NAME}`);
  console.log(`Endpoint: ${AZURE_OPENAI_ENDPOINT}`);
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.json({ status: "ok", message: "Chatbot backend is running" });
});

// Explicitly handle OPTIONS for /api/chat
app.options("/api/chat", (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(200).end();
});

/**
 * Augments knowledge base with marketplace signals based on query intent
 * @param {string} queryLower - Lowercase user query
 * @param {Array} products - All products array
 * @param {Object} marketplaceSignals - Marketplace signals object
 * @param {Object} categoryRankings - Category rankings object
 * @param {Object} oemRankings - OEM rankings object
 * @returns {string} - Augmented knowledge base sections or empty string
 */
function augmentKnowledgeBaseWithSignals(queryLower, products, marketplaceSignals, categoryRankings, oemRankings) {
  let augmentedSections = "";

  // aa) POWER BI SPECIFIC SEARCH (CRITICAL)
  if (queryLower.includes('power bi')) {
    const powerBiProducts = products.filter(p => (p.name || '').toLowerCase().includes('power bi'));
    if (powerBiProducts.length > 0) {
      augmentedSections += `\n=== ACCURATE POWER BI PRODUCTS (${powerBiProducts.length} products) ===\n`;
      augmentedSections += `MANDATORY: These are the ONLY Power BI products. Do NOT list Power Automate products for this query.\n\n`;
      powerBiProducts.forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ${product.price ? `₹${product.price.toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}` : "Contact Sales"}\n`;
        const link = product.url || (product.id ? `https://shop.skysecure.ai/product/${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END ACCURATE POWER BI PRODUCTS ===\n\n`;
    }
  }

  // a) BEST SELLING PRODUCTS
  if (queryLower.includes('best selling') || queryLower.includes('top selling') || queryLower.includes('popular products')) {
    if (marketplaceSignals?.bestSelling && Array.isArray(marketplaceSignals.bestSelling)) {
      const bestSellingProducts = resolveProductsByIds(marketplaceSignals.bestSelling, products);
      if (bestSellingProducts.length > 0) {
        augmentedSections += `\n=== TOP SELLING / BEST SELLING PRODUCTS (${bestSellingProducts.length} products) ===\n`;
        augmentedSections += `These are the best selling products in SkySecure Marketplace based on marketplace signals:\n\n`;
        bestSellingProducts.forEach((product, index) => {
          augmentedSections += `${index + 1}. **${product.name}**\n`;
          augmentedSections += `   Vendor: ${product.vendor}\n`;
          augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
          augmentedSections += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
          if (product.description) {
            augmentedSections += `   Description: ${product.description.substring(0, 150)}...\n`;
          }
          augmentedSections += `\n`;
        });
        augmentedSections += `=== END TOP SELLING / BEST SELLING PRODUCTS ===\n\n`;
      }
    }
  }

  // b) CATEGORY OVERVIEW
  if (queryLower.includes('categories') || queryLower.includes('domains') || queryLower.includes('segments') ||
    queryLower.includes('what categories') || queryLower.includes('list categories')) {
    if (categoryRankings && Object.keys(categoryRankings).length > 0) {
      augmentedSections += `\n=== CATEGORY OVERVIEW ===\n`;
      augmentedSections += `SkySecure Marketplace offers Software products under these domains:\n\n`;
      Object.entries(categoryRankings).forEach(([categoryName, productIds]) => {
        const productCount = Array.isArray(productIds) ? productIds.length : 0;
        augmentedSections += `- **${categoryName}**: ${productCount} products\n`;
      });
      augmentedSections += `=== END CATEGORY OVERVIEW ===\n\n`;
    }
  }

  // c) CATEGORY-SPECIFIC QUERIES
  if (categoryRankings) {
    for (const [categoryName, productIds] of Object.entries(categoryRankings)) {
      const categoryLower = categoryName.toLowerCase();
      // Check if query mentions this category (case-insensitive)
      if (queryLower.includes(categoryLower) ||
        queryLower.includes(categoryName.toLowerCase().replace(/\s+/g, '-'))) {
        if (Array.isArray(productIds) && productIds.length > 0) {
          const categoryProducts = resolveProductsByIds(productIds, products);
          if (categoryProducts.length > 0) {
            augmentedSections += `\n=== PRODUCTS IN CATEGORY: ${categoryName} (${categoryProducts.length} products) ===\n`;
            augmentedSections += `These are all products in the ${categoryName} category:\n\n`;
            categoryProducts.forEach((product, index) => {
              augmentedSections += `${index + 1}. **${product.name}**\n`;
              augmentedSections += `   Vendor: ${product.vendor}\n`;
              augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
              if (product.description) {
                augmentedSections += `   Description: ${product.description.substring(0, 150)}...\n`;
              }
              augmentedSections += `\n`;
            });
            augmentedSections += `=== END PRODUCTS IN CATEGORY: ${categoryName} ===\n\n`;
            break; // Only process first matching category
          }
        }
      }
    }
  }

  // d) OEM / VENDOR QUERIES
  if (oemRankings) {
    for (const [oemName, productIds] of Object.entries(oemRankings)) {
      const oemLower = oemName.toLowerCase();
      // Check if query mentions this OEM/vendor (case-insensitive)
      if (queryLower.includes(oemLower) ||
        queryLower.includes(`products by ${oemLower}`) ||
        queryLower.includes(`${oemLower} products`)) {
        if (Array.isArray(productIds) && productIds.length > 0) {
          const oemProducts = resolveProductsByIds(productIds, products);
          if (oemProducts.length > 0) {
            augmentedSections += `\n=== PRODUCTS BY OEM/VENDOR: ${oemName} (${oemProducts.length} products) ===\n`;
            augmentedSections += `These are all products from ${oemName}:\n\n`;
            oemProducts.forEach((product, index) => {
              augmentedSections += `${index + 1}. **${product.name}**\n`;
              augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
              augmentedSections += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
              if (product.description) {
                augmentedSections += `   Description: ${product.description.substring(0, 150)}...\n`;
              }
              augmentedSections += `\n`;
            });
            augmentedSections += `=== END PRODUCTS BY OEM/VENDOR: ${oemName} ===\n\n`;
            break; // Only process first matching OEM
          }
        }
      }
    }
  }

  return augmentedSections;
}

// Chatbot endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message is required",
      });
    }

    if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Azure OpenAI is not configured. Please check your .env file.",
      });
    }

    console.log(`Processing chat request: "${message.substring(0, 50)}..."`);

    // Load products from JSON file instead of scraping/API
    const baseUrl = process.env.KNOWLEDGE_BASE_URL || "https://shop.skysecure.ai/";
    let relevantContent = "";

    // DYNAMIC: Parallelize data fetching and intent resolution for speed
    console.log("🚀 Starting parallel data fetch and intent resolution...");
    const productsPromise = loadProductsFromJSON();
    const signalsPromise = loadMarketplaceSignals();
    const categoryPromise = fetchCategoryHierarchy();
    const intentPromise = resolveIntent(message, baseUrl);

    // Await intent resolution early as it's needed for stage inference
    const intentInfo = await intentPromise;

    // FAST TRACK: Handle greetings and off-topic questions quickly
    const greeting = isGreeting(message);
    const domainRelated = isDomainRelated(message, intentInfo);

    if (greeting || !domainRelated) {
      console.log(`⚡ Fast-tracking ${greeting ? 'greeting' : 'off-topic'} response`);

      const fastSystemPrompt = `You are a helpful virtual assistant for SkySecure Marketplace.
      ${greeting ? 'The user just said hello. Respond with a warm, professional greeting and briefly ask how you can help them with software or IT needs.' : 'The user asked something outside the scope of software and IT. Politely inform them that you specialize in SkySecure Marketplace products and services.'}
      Format your response with markdown and keep it concise.`;

      const fastMessages = [
        { role: "system", content: fastSystemPrompt },
        ...conversationHistory.slice(-3).map(msg => ({
          role: msg.from === "bot" ? "assistant" : "user",
          content: msg.text
        })),
        { role: "user", content: message }
      ];

      const apiUrl = `${AZURE_OPENAI_ENDPOINT}${AZURE_OPENAI_ENDPOINT.endsWith('/') ? '' : '/'}openai/deployments/${DEPLOYMENT_NAME}/chat/completions?api-version=${API_VERSION}`;

      const response = await makeRequest(apiUrl, {
        method: 'POST',
        headers: { "api-key": AZURE_OPENAI_API_KEY, "Content-Type": "application/json" },
        body: { messages: fastMessages, temperature: 0.7, max_tokens: 500 }
      });

      const responseData = await response.json();
      const botResponse = responseData.choices[0]?.message?.content || "How can I help you today?";

      return res.json({
        success: true,
        message: botResponse,
        quickReplies: greeting ? [{ text: "Show Best Sellers", value: "best_selling" }, { text: "Browse Categories", value: "categories" }] : [],
        conversationStage: "Discovery"
      });
    }

    const conversationStage = inferConversationStage(conversationHistory, message, intentInfo);

    // Track conversation state using new conversation manager
    const conversationState = trackConversationState(conversationHistory, message, intentInfo);
    console.log(`Conversation state: Stage=${conversationState.stage}, Confidence=${conversationState.confidence}`);
    const stagePrompt = getStagePrompt(conversationState.stage, conversationState.context);
    const quickReplies = suggestQuickReplies(conversationState.stage, intentInfo);

    // Load products from JSON file
    console.log("Loading products from products_normalized.json...");
    const productsFromJSON = await productsPromise;

    // Index products with embeddings for semantic search - ONLY ONCE
    if (productsFromJSON.length > 0 && !isIndexed) {
      console.log("Indexing products with embeddings for semantic search (First Run)...");
      const productChunks = productsToTextChunks(productsFromJSON);

      // Index in background or wait with timeout
      try {
        await Promise.race([
          indexProductChunks(productChunks),
          new Promise((resolve) => setTimeout(() => resolve(), 30000)) // 30s timeout
        ]);
        isIndexed = true;
        console.log("✅ Semantic search indexing complete");
      } catch (err) {
        console.warn("Product indexing failed, continuing without semantic search:", err.message);
      }
    } else if (productsFromJSON.length > 0) {
      console.log("Using cached product embeddings (already indexed)");
    }

    // Get relevant content using semantic search on products (only if indexed)
    let relevantContentPromise = Promise.resolve("");
    if (productsFromJSON.length > 0 && isIndexed) {
      console.log("Finding relevant products using semantic search...");
      relevantContentPromise = Promise.race([
        getRelevantContent(message, 15), // Increased from 10 to 15 relevant products
        new Promise((resolve) => setTimeout(() => resolve(""), 5000)) // Increased timeout to 5s
      ]).catch(err => {
        console.warn("Semantic search failed:", err.message);
        return "";
      });
    } else {
      if (!isIndexed) console.log("Skipping semantic search - Index not ready yet");
    }

    // Use products loaded from JSON file
    console.log("Using products from JSON file...");
    let products = productsFromJSON || [];
    let productFetchError = null;

    // Load marketplace signals and enrich products
    console.log("Loading marketplace signals...");
    const { marketplaceSignals, categoryRankings, oemRankings } = await signalsPromise;

    // Await semantic search result
    relevantContent = await relevantContentPromise;
    console.log(`Semantic search returned ${relevantContent.length} characters of relevant content`);

    // Enrich products with marketplace signals (set flags)
    if (marketplaceSignals) {
      // Set best selling flag
      if (marketplaceSignals.bestSelling && Array.isArray(marketplaceSignals.bestSelling)) {
        const bestSellingProducts = resolveProductsByIds(marketplaceSignals.bestSelling, products);
        bestSellingProducts.forEach(product => {
          product.isTopSelling = true;
        });
        console.log(`✅ Marked ${bestSellingProducts.length} products as best selling`);
      }

      // Set featured flag
      if (marketplaceSignals.featured && Array.isArray(marketplaceSignals.featured)) {
        const featuredProducts = resolveProductsByIds(marketplaceSignals.featured, products);
        featuredProducts.forEach(product => {
          product.isFeatured = true;
        });
        console.log(`✅ Marked ${featuredProducts.length} products as featured`);
      }

      // Set recently added flag
      if (marketplaceSignals.recentlyAdded && Array.isArray(marketplaceSignals.recentlyAdded)) {
        const recentlyAddedIds = marketplaceSignals.recentlyAdded.map(item =>
          typeof item === 'object' ? item.productId : item
        );
        const recentlyAddedProducts = resolveProductsByIds(recentlyAddedIds, products);
        recentlyAddedProducts.forEach(product => {
          product.isLatest = true;
        });
        console.log(`✅ Marked ${recentlyAddedProducts.length} products as recently added`);
      }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 PRODUCTS RETRIEVED FOR KNOWLEDGE BASE`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Total Products Retrieved: ${products.length}`);

    const featuredCount = products.filter(p => p.isFeatured).length;
    const topSellingCount = products.filter(p => p.isTopSelling).length;
    const recentlyAddedCount = products.filter(p => p.isLatest).length;
    console.log(`Product Breakdown:`);
    console.log(`  - Featured: ${featuredCount}`);
    console.log(`  - Top Selling: ${topSellingCount}`);
    console.log(`  - Recently Added: ${recentlyAddedCount}`);

    // DYNAMIC SEARCH: Analyze user query for specific product searches
    const queryLower = message.toLowerCase();
    const searchTerms = [];

    // Detect SQL-related queries
    if (queryLower.includes('sql') || queryLower.includes('database')) {
      searchTerms.push('SQL/Database');
      const sqlProducts = products.filter(p => {
        const name = (p.name || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();
        return name.includes('sql') || desc.includes('sql') || name.includes('database');
      });
      console.log(`\n🔍 DYNAMIC SEARCH: SQL/Database Products`);
      console.log(`  Found ${sqlProducts.length} SQL/Database products:`);
      sqlProducts.forEach((p, idx) => {
        console.log(`    ${idx + 1}. ${p.name} (${p.vendor}) - ${p.subCategory || p.category}`);
      });
    }

    // Detect Email-related queries
    if (queryLower.includes('email') || queryLower.includes('exchange') || queryLower.includes('outlook')) {
      searchTerms.push('Email');
      const emailProducts = products.filter(p => {
        const name = (p.name || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();
        return name.includes('email') || desc.includes('email') ||
          name.includes('exchange') || name.includes('outlook');
      });
      console.log(`\n🔍 DYNAMIC SEARCH: Email Products`);
      console.log(`  Found ${emailProducts.length} Email products:`);
      emailProducts.forEach((p, idx) => {
        console.log(`    ${idx + 1}. ${p.name} (${p.vendor}) - ${p.subCategory || p.category}`);
      });
    }

    // Detect Power BI-related queries
    if (queryLower.includes('power bi')) {
      searchTerms.push('Power BI');
      const powerBiProducts = products.filter(p => {
        const name = (p.name || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();
        return name.includes('power bi');
      });
      console.log(`\n🔍 DYNAMIC SEARCH: Power BI Products`);
      console.log(`  Found ${powerBiProducts.length} Power BI products:`);
      powerBiProducts.forEach((p, idx) => {
        console.log(`    ${idx + 1}. ${p.name} (${p.vendor}) - ${p.subCategory || p.category}`);
      });
    }

    // Detect Power Automate-related queries
    if (queryLower.includes('power automate')) {
      searchTerms.push('Power Automate');
      const powerAutomateProducts = products.filter(p => {
        const name = (p.name || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();
        return name.includes('power automate');
      });
      console.log(`\n🔍 DYNAMIC SEARCH: Power Automate Products`);
      console.log(`  Found ${powerAutomateProducts.length} Power Automate products:`);
      powerAutomateProducts.forEach((p, idx) => {
        console.log(`    ${idx + 1}. ${p.name} (${p.vendor}) - ${p.subCategory || p.category}`);
      });
    }

    if (searchTerms.length > 0) {
      console.log(`\n🎯 Search Terms Detected: ${searchTerms.join(', ')}`);
    }

    // EXPLICIT LOGGING: If both are found, or if one is found, cross-verify
    if (queryLower.includes('power bi') && !queryLower.includes('power automate')) {
      console.log("⚠️  ALERT: User asked for Power BI. Validating that Power Automate products are NOT being prioritized.");
    }

    // Group products by category for logging
    const productsByCategory = {};
    products.forEach(p => {
      const cat = p.category || 'Uncategorized';
      if (!productsByCategory[cat]) productsByCategory[cat] = [];
      productsByCategory[cat].push(p);
    });

    console.log(`\n📦 Products by Category:`);
    Object.entries(productsByCategory).sort((a, b) => b[1].length - a[1].length).forEach(([cat, catProducts]) => {
      console.log(`  ${cat}: ${catProducts.length} products`);
    });

    console.log(`${'='.repeat(80)}\n`);

    if (products.length === 0 && productFetchError) {
      console.error(`ERROR: Failed to fetch products from API: ${productFetchError}`);
      console.error("This may indicate:");
      console.error("1. PRODUCT_SERVICE_BACKEND_URL is incorrect or unreachable");
      console.error("2. Network connectivity issues");
      console.error("3. API authentication or permission issues");
    }

    // Fetch category hierarchy and OEMs (use promise from start)
    console.log("Fetching category hierarchy and OEMs (awaiting promise)...");
    let categoryHierarchy = "";
    try {
      const categoryData = await Promise.race([
        categoryPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Category API timeout")), 2500)) // 2.5s timeout
      ]);

      categoryHierarchy = formatCategoryHierarchyForKnowledgeBase(
        categoryData.categories || [],
        categoryData.oems || [],
        products
      );
      console.log(`Category hierarchy created: ${categoryHierarchy.length} characters`);
    } catch (error) {
      console.error("Error fetching category hierarchy:", error.message);
      categoryHierarchy = "\n=== MARKETPLACE CATEGORY HIERARCHY ===\nUnable to fetch category hierarchy from API at this time.\n=== END CATEGORY HIERARCHY ===\n\n";
    }

    // Skip website scraping - using products from JSON file instead
    let listingProductsSection = "";
    console.log("✅ Using products from JSON file - skipping website scraping to avoid timeouts");

    // Re-format knowledge base with products from JSON - Use LIMITED version for faster response
    let productKnowledgeBase = formatProductsForKnowledgeBase(productsFromJSON, false);
    console.log(`Product knowledge base created: ${productKnowledgeBase.length} characters (Limited version)`);

    // Augment knowledge base with marketplace signals based on query intent
    const augmentedSections = augmentKnowledgeBaseWithSignals(
      queryLower,
      products,
      marketplaceSignals,
      categoryRankings,
      oemRankings
    );

    if (augmentedSections) {
      productKnowledgeBase += augmentedSections;
      console.log(`✅ Augmented knowledge base with marketplace signals`);
    }

    // Build system prompt with knowledge base
    const systemPrompt = `You are a helpful, friendly, and visually-oriented virtual assistant for SkySecure Marketplace (Official URL: ${baseUrl}), similar to Amazon's Rufus. Your role is to help customers with questions about products, services, pricing, and general inquiries.

⛔ OUT OF SCOPE / OFF-TOPIC QUESTIONS:
If the user asks about topics COMPLETELY UNRELATED to:
- Software products, IT, cloud services, security, or technology
- SkySecure Marketplace features, pricing, or support
- General business/enterprise software inquiries

(Examples of off-topic: "How's the weather?", "Who won the cricket match?", "Write a poem about cats", "Solve this math problem", "politics", "movies", etc.)

YOU MUST RESPOND WITH:
"I am the SkySecure Marketplace assistant. I can only help you with questions about our software products, services, and features. How can I assist you with your IT or software needs today?"

DO NOT attempt to answer the off-topic question. politely decline and pivot back to the marketplace.

IMPORTANT: Format all responses in a visually appealing way using markdown. Use clear headings, bullet points (NO TABLES), bold text, and proper spacing to make responses easy to read and engaging.

⚠️  CRITICAL DATA SOURCE RULES - PRODUCTS FROM JSON FILE ⚠️

All products are loaded from products_normalized.json file. Products DO EXIST and MUST be discovered using semantic search.

MANDATORY DATA FETCH RULES:
1. **PRIMARY SOURCE**: Products loaded from products_normalized.json file
   - All products are available in the product data sections below
   - Use semantic search results to find relevant products
2. **SEMANTIC SEARCH**: Use the "SEMANTIC SEARCH RESULTS" section to find products matching the user's query
3. A category is considered empty ONLY if:
   - No products found in the JSON file for that category
   - AND semantic search returns no relevant products
4. DO NOT assume, infer, or hallucinate products - use only the data from the JSON file

PRODUCT PAGES TO TRAVERSE:
- /products?subCategoryId=* (for subcategories)
- /products?oemId=* (for OEM/vendor products)
- /products?sort=* (for sorted product lists)

BEHAVIOR RULES:
1. PRIORITY ORDER for product data:
   a) "SEMANTIC SEARCH RESULTS" section (most relevant products for the query)
   b) Category-specific sections in product data (e.g., "SQL PRODUCTS", "DATA MANAGEMENT PRODUCTS")
   c) General product listings from JSON file
2. Use semantic search results to find the most relevant products for the user's query
3. If products exist in the JSON file, LIST THEM
4. Say "No products found" ONLY if:
   - Semantic search returns no results
   - AND no products found in category-specific sections
   - AND no products in general listings
5. If a user asks about a specific category (e.g., Data Management), check:
   - First: "SEMANTIC SEARCH RESULTS" section
   - Then: Category-specific sections in product knowledge base
6. Show product name, vendor, pricing model, and license duration from JSON data
7. Keep responses concise, factual, and aligned with the product data from JSON file
8. DO NOT add external explanations, recommendations, or examples unless explicitly asked

RESPONSE FORMAT:
   - Product Name (bold, and YOU MUST MAKE IT A LINK using the "Link:" field from data. E.g., [**Product Name**](Link))
   - Vendor
   - Price / License
   - Category (if relevant)
   - Link (always ensure the name is clickable, or list the link explicitly)

EXAMPLE BEHAVIOR:
- User asks: "What products are in Data Management?"
  → Action: Check the data below for products from /products?subCategoryId=68931f337874310ffca28e96&subCategory=Data-Management
  → If products are listed in the data, respond with the listed products
  → If no products are found in the data, respond: "No products found in the Data Management category on SkySecure Marketplace."
  → DO NOT assume or infer products that are not in the data

CRITICAL: You have access to:

1. REAL product data loaded from products_normalized.json with actual names, prices, categories, vendors, descriptions
2. SEMANTIC SEARCH results that find the most relevant products based on the user's query
3. Complete product information, descriptions, features, pricing, categories from the JSON file

You MUST use this comprehensive data to answer ALL questions accurately. All products are loaded from the products_normalized.json file. DO NOT make up or assume any information that is not in the data provided below.

CONVERSATION STATE: ${conversationStage}
CONVERSATION STAGE (Guided Sales): ${conversationState.stage}
STAGE CONFIDENCE: ${conversationState.confidence}
RESOLVED INTENT: ${intentInfo.categoryName || ''} ${intentInfo.subCategoryId ? `(subCategoryId=${intentInfo.subCategoryId})` : ''} ${intentInfo.oemId ? `(oemId=${intentInfo.oemId})` : ''}
LISTING URLS: ${(intentInfo.listingUrls || []).join(', ')}

${stagePrompt}

${relevantContent ? `SEMANTIC SEARCH RESULTS (Most relevant products for this query):
${relevantContent}
` : ''}

=== MARKETPLACE CATEGORY HIERARCHY AND OEMs ===
${categoryHierarchy}
=== END CATEGORY HIERARCHY ===

=== PRODUCT DATA FROM API ===
${productKnowledgeBase}
=== END PRODUCT DATA ===


IMPORTANT: The product data above contains clearly marked sections:
- "=== RECENTLY ADDED PRODUCTS ===" section lists all recently added products
- "=== TOP SELLING / BEST SELLING PRODUCTS ===" section lists all best selling products  
- "=== FEATURED PRODUCTS ===" section lists all featured products

When users ask about these categories, you MUST look for these specific sections and list the products from them.

CRITICAL INSTRUCTIONS - READ CAREFULLY:

The product data below contains SPECIFIC SECTIONS for:
- FEATURED PRODUCTS
- BEST SELLING / TOP SELLING PRODUCTS  
- RECENTLY ADDED PRODUCTS

When a user asks about these categories, you MUST:
1. Look for the specific section (e.g., "=== RECENTLY ADDED PRODUCTS ===" or "=== FEATURED PRODUCTS ===")
2. Check if the section header shows "(X products)" where X > 0 - this means products EXIST
3. If products exist (X > 0), list ALL products from that section with their names, vendors, prices, and categories
4. DO NOT say "not available", "not provided", or "no products" if the section shows "(X products)" where X > 0
5. Only say "no products" if the section explicitly says "No products" or shows "(0 products)"

CRITICAL: The data below contains REAL information from the SkySecure Marketplace API. You MUST use this data to answer questions.

IMPORTANT: The sections are clearly marked with headers like:
- "=== FEATURED PRODUCTS (X products) ===" - if X > 0, there ARE featured products, list them ALL
- "=== TOP SELLING / BEST SELLING PRODUCTS (X products) ===" - if X > 0, there ARE best selling products, list them ALL
- "=== RECENTLY ADDED PRODUCTS (X products) ===" - if X > 0, there ARE recently added products, list them ALL
- "=== MARKETPLACE CATEGORY HIERARCHY ===" - Shows the FULL hierarchical structure with main categories, sub-categories, and sub-sub-categories

ABSOLUTE REQUIREMENT: When a user asks about categories, sub-categories, featured products, best selling products, or recently added products, you MUST look at the data provided below. If the data shows products exist, you MUST list them. DO NOT say "no products" or "no subcategories" if the data clearly shows they exist.

EXAMPLES:
- User asks "what are the categories in skysecure marketplace" → Look for "=== MARKETPLACE CATEGORY HIERARCHY ===" section. Show the FULL hierarchy:
  * Main categories (e.g., "1. Software (X products)")
  * Sub-categories under each main category (e.g., "   1.1 Cloud services (Y products)", "   1.2 Data Management (Z products)", etc.)
  * Also mention OEMs from "=== ORIGINAL EQUIPMENT MANUFACTURERS (OEMs) ===" section
- User asks "what are the sub categories in software" → Look for "=== MARKETPLACE CATEGORY HIERARCHY ===" section, find "Software" category, and list ALL its sub-categories (1.1, 1.2, 1.3, etc.)
- User asks "what are recently added products" → Look for "=== RECENTLY ADDED PRODUCTS ===" section. If it shows "(X products)" where X > 0, list ALL products from that section with full details (name, vendor, price, category, description).
- User asks "best selling products" → Look for "=== TOP SELLING / BEST SELLING PRODUCTS ===" section. If it shows "(X products)" where X > 0, list ALL products from that section.
- User asks "featured products" → Look for "=== FEATURED PRODUCTS ===" section. If it shows "(X products)" where X > 0, list ALL products from that section.
- User asks "what are the SQL products being sold" or "SQL products" → Look for products in this EXACT order:
  1. **FIRST**: Check "=== SEMANTIC SEARCH RESULTS ===" section - These are the most relevant products found via semantic search
     - This is the PRIMARY source for finding relevant products
     - Filter for products with "SQL" in the name or description
  2. **SECOND**: Check "=== SQL PRODUCTS ===" section (from JSON file)
  3. **THIRD**: Check "=== DATA MANAGEMENT PRODUCTS ===" section (from JSON file)
  
  If ANY of these sections show products, you MUST list ALL of them using the standard point-wise format defined below. DO NOT use separate headers for each section; aggregate them into a single clear list.
  
  CRITICAL: Use semantic search results and product data from JSON file to find all relevant products.

GENERAL INSTRUCTIONS:
1. **DATA PRIORITY**: ALWAYS check "SEMANTIC SEARCH RESULTS" and specific category sections (e.g., SQL, FEATURED) before saying something doesn't exist.
2. **STRICT VISUAL RULES (NO TABLES)**: 
   - NEVER use markdown tables OR pseudo-tables (tab-separated text).
   - NEVER use column-based layouts.
   - ALWAYS use vertical, point-wise lists.
   - For comparisons, use: ## [Product Name] > Bullet points for details.
3. **MANDATORY CLICKABLE LINKS**: Every single time you mention a product name, you MUST make it a clickable markdown link using the EXACT URL from the "Link:" field in the data. Format: [**Product Name**](Direct_URL_From_Data).
4. **PRODUCT LISTING FORMAT**:
   1. [**Product Name**](Direct_URL_From_Data) | 🏢 **Vendor**: [Vendor] | 💰 **Price**: [All Available Prices Joined by " | "]
      - 🏷️ **Category**: [Category]
      - 📝 **Description**: [Brief 1-sentence description]
5. **PRICING**: Format as ₹{amount}/{Cycle}. List ALL available cycles (Monthly, Yearly, 3-Year).
6. **STRICT LINK GUARDRAIL**: ONLY use URLs from the "Link:" field. NEVER guess or use "skysecuremarketplace.com". All official links start with "https://shop.skysecure.ai/".
7. **CATEGORIES**: Organized in the "MARKETPLACE CATEGORY HIERARCHY" section. Use the exact hierarchy (1., 1.1, 1.2, etc.) and product counts provided.
8. **ACCURACY**: Use EXACT names and prices from the provided JSON data.
9. **CONCISE RESPONSES**: To avoid truncation, keep descriptions to 1 sentence. If more than 10 products are found, list the top 10 and offer to show more.

CRITICAL: All data is fetched LIVE from the SkySecure Marketplace API. There are NO hard-coded responses. If data is missing, it means the API returned no data, and you must clearly communicate this to the user.

IMPORTANT: Marketplace Signals Clarification:
"Best selling" and "featured" products are derived marketplace signals based on catalog prominence and heuristics, not real-time sales or order data. These signals are computed from product metadata, category rankings, and marketplace analytics to identify products that are likely to be popular or noteworthy.

ABSOLUTE GUARDRAILS:
1. NEVER say "no products found" unless semantic search returns no results AND no products found in category sections.
2. If the user intent maps to a broad category, ask one clarifying question to narrow to a subcategory or OEM before recommending.
3. If intent is clear, recommend 1–2 products with reasoning and always include a direct Link for each product when available.
4. Treat products parsed from listing pages as authoritative first-class data for availability.
5. **STRICT LINK GUARDRAIL**: ONLY use the direct links provided in the "Link:" field of the product data. NEVER guess, assume, or hallucinate a URL. NEVER use "skysecuremarketplace.com" as a domain unless explicitly seen in the "Link:" field. All official links start with "${baseUrl}".
6. **MANDATORY CLICKABLE NAMES**: Every time you mention a product name, you MUST make it a clickable markdown link using the exact URL from the "Link:" field. E.g., [**Product Name**](Exact_Link_From_Data).

CONVERSATION STAGES:
Discovery → Narrowing → Recommendation → Conversion.
Follow one guiding question at a time. Prefer concise next-step prompts to move the user forward.

MANDATORY CHECKLIST before answering:
- Question about categories? → Check "MARKETPLACE CATEGORY HIERARCHY" section
- Question about sub-categories? → Check "MARKETPLACE CATEGORY HIERARCHY" section for numbered sub-categories (e.g., 1.1, 1.2, etc.)
- Question about featured products? → Check "=== FEATURED PRODUCTS ===" section
- Question about best selling products? → Check "=== TOP SELLING / BEST SELLING PRODUCTS ===" section
- Question about recently added products? → Check "=== RECENTLY ADDED PRODUCTS ===" section
- Question about SQL products? → Check in this order:
  1. "=== SEMANTIC SEARCH RESULTS ===" section FIRST (most relevant products)
  2. "=== SQL PRODUCTS ===" section (from JSON file)
- Question about Power BI products? → Check in this order:
  1. "=== SEMANTIC SEARCH RESULTS ===" section FIRST (most relevant products)
  2. "=== POWER BI PRODUCTS ===" section (from JSON file)
  ⚠️ WARNING: DO NOT list "Power Automate" products when the user asks for "Power BI". Only list products that specifically contain "Power BI" in their name.
- Question about Email or Collaboration products? → Check in this order:
  1. "=== SEMANTIC SEARCH RESULTS ===" section FIRST
  2. "=== EMAIL & COLLABORATION PRODUCTS ===" section (from JSON file)
- Question about Data Management products? → Check "=== DATA MANAGEMENT PRODUCTS ===" section

10. **CONTEXTUAL CONTINUITY**: If a user clicks a button like "Compare Options", "Show Pricing", or "See Features" after you've provided an overview or list, they are referring to those specific products. You MUST use the conversation history to perform the requested action (Compare, Pricing, or Features) for the items you JUST mentioned. DO NOT ask for clarification; use the products from the previous bot message.

The data is comprehensive and accurate - USE IT!

11. **URL INTEGRITY (CRITICAL)**: 
    - NEVER shorten, truncate, or "fix" URLs.
    - Product IDs at the end of URLs (e.g., "...--6895f3b1ef1ca6239ac8b94b") must be 24 characters long.
    - COPY THE EXACT URL from the "Link:" field, character-for-character.
    - If a URL looks long, IT IS CORRECT. Do not cut it off.
    - Truncating a URL breaks the link and is a critical failure.
    - Validate that the URL ends with the full 24-character hex ID if present in the source.
    - Example of CORRECT URL: https://shop.skysecure.ai/...--6895f3c3ef1ca6239ac8d0c5
    - Example of BROKEN URL: https://shop.skysecure.ai/...--6895f3c3ef1ca (MISSING LAST 12 CHARS)
    - YOU MUST OUTPUT THE FULL 24-CHAR ID. DO NOT STOP HALFWAY.

12. **SELF-CORRECTION PHASE**: 
    Before outputting any link, perform this mental check:
    - "Does this URL end with a 12-character string like '6895f3c3ef1ca'?" -> STOP! IT IS BROKEN.
    - "Does it end with a 24-character string like '6895f3c3ef1ca6239ac8d0c5'?" -> GOOD.
    - You MUST use the full, long ID.`;

    // Build conversation messages
    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
    ];

    // Add conversation history (last 10 messages to avoid token limits)
    const recentHistory = conversationHistory.slice(-10);
    recentHistory.forEach((msg) => {
      messages.push({
        role: msg.from === "bot" ? "assistant" : "user",
        content: msg.text,
      });
    });

    // Add current user message
    messages.push({
      role: "user",
      content: message,
    });

    // Call Azure OpenAI REST API (with increased timeout)
    console.log("Calling Azure OpenAI API...");
    const endpoint = AZURE_OPENAI_ENDPOINT.endsWith('/')
      ? AZURE_OPENAI_ENDPOINT
      : AZURE_OPENAI_ENDPOINT + '/';
    const apiUrl = `${endpoint}openai/deployments/${DEPLOYMENT_NAME}/chat/completions?api-version=${API_VERSION}`;

    console.log(`System prompt size: ${systemPrompt.length} characters`);
    console.log(`Total messages: ${messages.length}`);

    // Call Azure OpenAI REST API with automatic retries for stability
    console.log("Calling Azure OpenAI API (with auto-retries)...");
    const response = await makeRequest(apiUrl, {
      method: 'POST',
      headers: {
        "api-key": AZURE_OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: {
        messages: messages,
        temperature: 0.7,
        max_tokens: 4096,
      },
      timeout: 120000, // 2-minute timeout per attempt
    }, 3).catch(err => {
      console.error("OpenAI API call final failure:", err.message);
      throw err;
    });

    const responseData = await response.json();
    const botResponse = responseData.choices[0]?.message?.content || "I apologize, but I couldn't generate a response. Please try again.";

    // Log diagnostic info for response truncation
    if (responseData.choices && responseData.choices.length > 0) {
      const choice = responseData.choices[0];
      console.log(`OpenAI Finish Reason: ${choice.finish_reason}`);
      if (choice.finish_reason !== 'stop') {
        console.warn(`⚠️  Response incomplete. Finish reason: ${choice.finish_reason}`);
      }
    }

    if (responseData.usage) {
      console.log(`Token Usage: Prompt=${responseData.usage.prompt_tokens}, Completion=${responseData.usage.completion_tokens}, Total=${responseData.usage.total_tokens}`);
    }

    console.log("Successfully generated response");

    // --- DETERMINISTIC LINK FIXER ---
    // This safety net catches and repairs truncated URLs using the valid product data
    let fixedResponse = botResponse;
    const productsForFixer = productsFromJSON || [];

    // Create lookup maps for fast repair
    const validIdMap = new Map();   // Full ID -> Full URL
    const suffixMap = new Map();    // Last 12 chars -> Full URL
    const slugMap = new Map();      // Full Slug -> Full URL
    const simpleSlugMap = new Map(); // Simple Slug -> Full URL

    productsForFixer.forEach(p => {
      if (p.id && p.url) {
        validIdMap.set(p.id, p.url);
        if (p.id.length === 24) {
          const suffix = p.id.substring(12);
          suffixMap.set(suffix, p.url);
        }

        // Extract full slug (everything between /products/ and the last --)
        const match = p.url.match(/\/products\/(.*)--[a-f0-9]{24}/);
        if (match && match[1]) {
          const fullSlug = match[1];
          slugMap.set(fullSlug.toLowerCase(), p.url);

          // Simple Slug (last segment)
          const parts = fullSlug.split('--');
          const simpleSlug = parts[parts.length - 1].toLowerCase();
          simpleSlugMap.set(simpleSlug, p.url);
        }
      }
    });

    // Regex: Splits the URL into [Slug] and [ID] using the last occurrence of '--'
    const linkRegex = /https:\/\/shop\.skysecure\.ai\/products\/([^\s"')]*)--([a-f0-9]+)/gi;

    fixedResponse = fixedResponse.replace(linkRegex, (fullMatch, slugCandidate, idCandidate) => {
      const slug = slugCandidate ? slugCandidate.toLowerCase() : '';
      const id = idCandidate.toLowerCase();

      // 1. If ID is perfect and valid, keep it.
      if (id.length === 24 && validIdMap.has(id)) {
        return fullMatch;
      }

      console.log(`🔍 Link Fixer started for: ${fullMatch}`);
      let repairedUrl = null;

      // 2. Exact Full Slug Match
      if (slugMap.has(slug)) {
        repairedUrl = slugMap.get(slug);
        console.log(`   - Repaired via Full Slug: ${slug}`);
      }

      // 3. Simple Slug / Alias / Fuzzy Segment Match
      if (!repairedUrl) {
        const slugParts = slug.split('--');
        const lastSegment = slugParts[slugParts.length - 1];

        const aliasMap = {
          'power-bi-premium': 'power-bi-premium-per-user',
          'power-bi-premium-add-on': 'power-bi-premium-per-user-add-on',
          'azure-sql-edge': 'azure-sql-edge-1-year'
        };

        const target = aliasMap[lastSegment] || lastSegment;

        if (simpleSlugMap.has(target)) {
          repairedUrl = simpleSlugMap.get(target);
          console.log(`   - Repaired via Segment/Alias: ${lastSegment} -> ${target}`);
        } else {
          // Final Fuzzy Fallback for Segments
          for (const [validSimple, url] of simpleSlugMap.entries()) {
            if (validSimple.startsWith(lastSegment) || lastSegment.startsWith(validSimple)) {
              repairedUrl = url;
              console.log(`   - Repaired via Fuzzy Segment: ${lastSegment} -> ${validSimple}`);
              break;
            }
          }
        }
      }

      // 4. Suffix repair (ID-based)
      if (!repairedUrl && id.length >= 10) {
        const idSuffix = id.length > 12 ? id.substring(id.length - 12) : id;
        if (suffixMap.has(idSuffix)) {
          repairedUrl = suffixMap.get(idSuffix);
          console.log(`   - Repaired via ID Suffix: ${idSuffix}`);
        }
      }

      // 5. HARD-CODED POWER BI FALLBACK (Safety Net)
      if (!repairedUrl) {
        if (slug.includes('power-bi-premium-per-user') || slug.includes('power-bi-premium')) {
          repairedUrl = simpleSlugMap.get('power-bi-premium-per-user');
          console.log("   - Repaired via Hard-Coded Power BI Fallback");
        } else if (slug.includes('azure-sql-edge')) {
          repairedUrl = simpleSlugMap.get('azure-sql-edge-1-year');
          console.log("   - Repaired via Hard-Coded Azure Fallback");
        }
      }

      if (repairedUrl) {
        return repairedUrl;
      }

      console.log("   - NO REPAIR FOUND");
      return fullMatch;
    });

    // Update the response with the fixed version
    const finalResponse = fixedResponse;

    // Ensure CORS headers are set in response
    res.header('Access-Control-Allow-Origin', '*');
    res.json({
      success: true,
      message: finalResponse,
      quickReplies: quickReplies, // Include quick-reply suggestions
      conversationStage: conversationState.stage, // Include stage for debugging
    });
  } catch (error) {
    console.error("Error in chat endpoint:", error);
    console.error("Error stack:", error.stack);
    console.error("Error details:", {
      message: error.message,
      name: error.name,
      code: error.code,
    });

    // Ensure CORS headers are set even on error
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    res.status(500).json({
      success: false,
      message: error.message || "An error occurred while processing your request",
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined, // Only show stack in development
    });
  }
});

// Start server - listen on all interfaces for dev tunnel compatibility
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Chatbot backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Chat endpoint: http://localhost:${PORT}/api/chat`);
  console.log(`Server is accessible from dev tunnel`);

  // Silent background warm-up to improve responsiveness
  (async () => {
    try {
      console.log("🔄 Background Warm-up: Pre-fetching categories...");
      await fetchCategoryHierarchy();
      console.log("✅ Category cache ready");
    } catch (e) {
      console.error("Warm-up warning:", e.message);
    }
  })();
});
