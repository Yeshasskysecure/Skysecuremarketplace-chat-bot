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
import { generateSystemPrompt } from "./utils/promptBuilder.js";

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
        getRelevantContent(message, 10), // Get top 10 relevant products
        new Promise((resolve) => setTimeout(() => resolve(""), 2000)) // 2s timeout
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

    // Detect Collaboration-related queries
    if (queryLower.includes('collaboration') || queryLower.includes('teams') ||
      queryLower.includes('sharepoint') || queryLower.includes('onedrive')) {
      searchTerms.push('Collaboration');
      const collabProducts = products.filter(p => {
        const name = (p.name || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();
        const subCat = (p.subCategory || '').toLowerCase();
        return name.includes('teams') || name.includes('sharepoint') ||
          name.includes('onedrive') || subCat.includes('collaboration');
      });
      console.log(`\n🔍 DYNAMIC SEARCH: Collaboration Products`);
      console.log(`  Found ${collabProducts.length} Collaboration products:`);
      collabProducts.forEach((p, idx) => {
        console.log(`    ${idx + 1}. ${p.name} (${p.vendor}) - ${p.subCategory || p.category}`);
      });
    }

    if (searchTerms.length > 0) {
      console.log(`\n🎯 Search Terms Detected: ${searchTerms.join(', ')}`);
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
        new Promise((_, reject) => setTimeout(() => reject(new Error("Category API timeout")), 15000)) // 15s timeout
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
    const systemPrompt = generateSystemPrompt({
      conversationStage,
      conversationState,
      intentInfo,
      stagePrompt,
      relevantContent,
      categoryHierarchy,
      productKnowledgeBase
    });

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

    // System prompt is already optimized - no website content to truncate
    const optimizedSystemPrompt = systemPrompt;

    // Update messages with optimized prompt
    const optimizedMessages = [
      {
        role: "system",
        content: optimizedSystemPrompt,
      },
      ...messages.slice(1) // Keep conversation history and user message
    ];

    console.log(`System prompt size: ${optimizedSystemPrompt.length} characters`);
    console.log(`Total messages: ${optimizedMessages.length}`);

    const response = await Promise.race([
      makeRequest(apiUrl, {
        method: 'POST',
        headers: {
          "api-key": AZURE_OPENAI_API_KEY,
          "Content-Type": "application/json",
        },
        body: {
          messages: optimizedMessages,
          temperature: 0.7,
          max_tokens: 4000,
        },
        timeout: 120000, // Increased to 120 seconds (2 minutes)
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI API timeout")), 120000)) // 120s timeout
    ]).catch(err => {
      console.error("OpenAI API call failed:", err.message);
      throw err;
    });

    const responseData = await response.json();
    const botResponse = responseData.choices[0]?.message?.content || "I apologize, but I couldn't generate a response. Please try again.";

    console.log("Successfully generated response");

    // Ensure CORS headers are set in response
    res.header('Access-Control-Allow-Origin', '*');
    res.json({
      success: true,
      message: botResponse,
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
});
