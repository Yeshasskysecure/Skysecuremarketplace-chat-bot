import { makeRequest } from "./httpClient.js";

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const EMBEDDING_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_MODEL || "text-embedding-3-large";
const API_VERSION = "2024-02-15-preview";

// In-memory vector store (in production, use a proper vector DB)
let vectorStore = {
  chunks: [],
  embeddings: [],
  lastUpdate: null,
};

/**
 * Creates embeddings for text chunks (optimized for memory)
 * @param {Array<string>} chunks - Array of text chunks
 * @returns {Promise<Array<Array<number>>>} - Array of embedding vectors
 */
export async function createEmbeddings(chunks) {
  try {
    if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
      console.warn("Azure OpenAI not configured for embeddings");
      return [];
    }

    // Check for empty input
    if (!chunks || chunks.length === 0) {
      return [];
    }

    // Process ALL chunks - Removing artificial 100 limit
    // const maxChunks = 100;
    // const limitedChunks = chunks.slice(0, maxChunks);
    const limitedChunks = chunks;

    if (chunks.length > 500) {
      console.log(`Processing ${chunks.length} chunks for embeddings (this may take a moment)...`);
    } else {
      console.log(`Creating embeddings for ${chunks.length} chunks...`);
    }

    // Ensure endpoint has trailing slash
    const endpoint = AZURE_OPENAI_ENDPOINT.endsWith('/')
      ? AZURE_OPENAI_ENDPOINT
      : AZURE_OPENAI_ENDPOINT + '/';
    const apiUrl = `${endpoint}openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=${API_VERSION}`;

    // Process in smaller batches to reduce memory usage
    const batchSize = 5; // Reduced from 10
    const allEmbeddings = [];

    for (let i = 0; i < limitedChunks.length; i += batchSize) {
      const batch = limitedChunks.slice(i, i + batchSize);

      try {
        const response = await makeRequest(apiUrl, {
          method: 'POST',
          headers: {
            "api-key": AZURE_OPENAI_API_KEY,
            "Content-Type": "application/json",
          },
          body: {
            input: batch,
          },
        });

        if (!response.ok) {
          console.error(`Embedding API error: ${response.status}`);
          continue;
        }

        const responseData = await response.json();

        if (responseData.data && Array.isArray(responseData.data)) {
          const batchEmbeddings = responseData.data.map(item => item.embedding);
          allEmbeddings.push(...batchEmbeddings);
        }

        // Clear response data from memory
        responseData = null;

        // Shorter delay between batches to improve speed
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error in embedding batch ${i}:`, error.message);
        continue;
      }
    }

    console.log(`Created ${allEmbeddings.length} embeddings`);
    return allEmbeddings;
  } catch (error) {
    console.error("Error creating embeddings:", error.message);
    return [];
  }
}

/**
 * Splits text into chunks for embedding (optimized for memory)
 * @param {string} text - Text to chunk
 * @param {number} chunkSize - Size of each chunk
 * @param {number} overlap - Overlap between chunks
 * @returns {Array<string>} - Array of text chunks
 */
export function chunkText(text, chunkSize = 800, overlap = 100) {
  // Limit total text size to prevent memory issues
  const maxTextSize = 50000; // 50KB max
  const limitedText = text.length > maxTextSize ? text.substring(0, maxTextSize) : text;

  const chunks = [];
  let start = 0;

  while (start < limitedText.length) {
    const end = Math.min(start + chunkSize, limitedText.length);
    const chunk = limitedText.substring(start, end).trim();

    if (chunk.length > 50) { // Only add meaningful chunks
      chunks.push(chunk);
    }

    start = end - overlap; // Overlap for context

    // Limit total chunks
    if (chunks.length >= 100) {
      break;
    }
  }

  return chunks;
}

/**
 * Calculates cosine similarity between two vectors
 * @param {Array<number>} vec1 - First vector
 * @param {Array<number>} vec2 - Second vector
 * @returns {number} - Similarity score (0-1)
 */
function cosineSimilarity(vec1, vec2) {
  if (vec1.length !== vec2.length) return 0;

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }

  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

/**
 * Finds most relevant chunks for a query
 * @param {string} query - Search query
 * @param {number} topK - Number of top results
 * @returns {Promise<Array<{chunk: string, score: number}>>} - Relevant chunks with scores
 */
export async function findRelevantChunks(query, topK = 5) {
  try {
    if (vectorStore.chunks.length === 0) {
      console.warn("Vector store is empty");
      return [];
    }

    // Create embedding for query
    const queryEmbeddings = await createEmbeddings([query]);
    if (queryEmbeddings.length === 0) {
      return [];
    }

    const queryVector = queryEmbeddings[0];

    // Calculate similarity scores
    const scores = vectorStore.embeddings.map((embedding, index) => ({
      chunk: vectorStore.chunks[index],
      score: cosineSimilarity(queryVector, embedding),
    }));

    // Sort by score and return top K
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  } catch (error) {
    console.error("Error finding relevant chunks:", error.message);
    return [];
  }
}

/**
 * Indexes website content with embeddings
 * @param {string} content - Website content to index
 */
export async function indexContent(content) {
  try {
    console.log("Indexing content with embeddings...");

    // Split content into chunks
    const chunks = chunkText(content, 1000, 200);
    console.log(`Split into ${chunks.length} chunks`);

    // Create embeddings
    const embeddings = await createEmbeddings(chunks);

    if (embeddings.length === chunks.length) {
      vectorStore.chunks = chunks;
      vectorStore.embeddings = embeddings;
      vectorStore.lastUpdate = Date.now();
      console.log(`Indexed ${chunks.length} chunks successfully`);
    } else {
      console.warn(`Embedding count mismatch: ${embeddings.length} vs ${chunks.length}`);
    }
  } catch (error) {
    console.error("Error indexing content:", error.message);
  }
}

/**
 * Indexes product chunks directly (for products from JSON)
 * @param {Array<string>} productChunks - Array of product text chunks
 */
export async function indexProductChunks(productChunks) {
  try {
    console.log(`Indexing ${productChunks.length} product chunks with embeddings...`);

    if (productChunks.length === 0) {
      console.warn("No product chunks to index");
      return;
    }

    // Create embeddings for product chunks
    const embeddings = await createEmbeddings(productChunks);

    if (embeddings.length === productChunks.length) {
      vectorStore.chunks = productChunks;
      vectorStore.embeddings = embeddings;
      vectorStore.lastUpdate = Date.now();
      console.log(`✅ Indexed ${productChunks.length} product chunks successfully`);
    } else {
      console.warn(`Embedding count mismatch: ${embeddings.length} vs ${productChunks.length}`);
      // Still use what we got
      if (embeddings.length > 0) {
        vectorStore.chunks = productChunks.slice(0, embeddings.length);
        vectorStore.embeddings = embeddings;
        vectorStore.lastUpdate = Date.now();
        console.log(`✅ Indexed ${embeddings.length} product chunks (partial)`);
      }
    }
  } catch (error) {
    console.error("Error indexing product chunks:", error.message);
  }
}

/**
 * Gets relevant content for a query using semantic search
 * @param {string} query - User query
 * @param {number} topK - Number of relevant chunks to retrieve
 * @returns {Promise<string>} - Relevant content
 */
export async function getRelevantContent(query, topK = 10) {
  try {
    const relevantChunks = await findRelevantChunks(query, topK);

    if (relevantChunks.length === 0) {
      return "";
    }

    let relevantContent = `\n=== MOST RELEVANT CONTENT FOR: "${query}" ===\n\n`;
    relevantChunks.forEach((item, index) => {
      relevantContent += `[Relevance Score: ${item.score.toFixed(3)}]\n`;
      relevantContent += `${item.chunk}\n\n`;
    });
    relevantContent += `=== END RELEVANT CONTENT ===\n`;

    return relevantContent;
  } catch (error) {
    console.error("Error getting relevant content:", error.message);
    return "";
  }
}

/**
 * Checks if vector store needs updating
 * @returns {boolean}
 */
export function needsUpdate() {
  if (vectorStore.chunks.length === 0) return true;
  const cacheAge = 60 * 60 * 1000; // 1 hour
  return !vectorStore.lastUpdate || (Date.now() - vectorStore.lastUpdate) > cacheAge;
}

