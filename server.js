// IMPORTANT: Import polyfill FIRST before any other modules
import './polyfill.js';

import express from "express";
import dotenv from "dotenv";
import { makeRequest } from "./utils/httpClient.js";
import { fetchAllProducts, formatProductsForKnowledgeBase } from "./utils/productFetcher.js";
import { fetchCategoryHierarchy, formatCategoryHierarchyForKnowledgeBase } from "./utils/categoryFetcher.js";
import { scrapeAllPages, scrapeListingProducts } from "./utils/websiteScraper.js";
import { resolveIntent, inferConversationStage } from "./utils/intentMapper.js";
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

    // DYNAMIC: Parallelize data fetching for speed
    console.log("🚀 Starting parallel data fetch...");
    const productsPromise = loadProductsFromJSON();
    const signalsPromise = loadMarketplaceSignals();
    const categoryPromise = fetchCategoryHierarchy(); // Hoisted from below

    // DYNAMIC: resolveIntent is now async - await it
    const intentInfo = await resolveIntent(message, baseUrl);
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

    // Re-format knowledge base with products from JSON
    let productKnowledgeBase = formatProductsForKnowledgeBase(products);
    console.log(`Product knowledge base created: ${productKnowledgeBase.length} characters`);

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
    const systemPrompt = `You are a helpful, friendly, and visually-oriented virtual assistant for SkySecure Marketplace, similar to Amazon's Rufus. Your role is to help customers with questions about products, services, pricing, and general inquiries.

⛔ OUT OF SCOPE / OFF-TOPIC QUESTIONS:
If the user asks about topics COMPLETELY UNRELATED to:
- Software products, IT, cloud services, security, or technology
- SkySecure Marketplace features, pricing, or support
- General business/enterprise software inquiries

(Examples of off-topic: "How's the weather?", "Who won the cricket match?", "Write a poem about cats", "Solve this math problem", "politics", "movies", etc.)

YOU MUST RESPOND WITH:
"I am the SkySecure Marketplace assistant. I can only help you with questions about our software products, services, and features. How can I assist you with your IT or software needs today?"

DO NOT attempt to answer the off-topic question. politely decline and pivot back to the marketplace.

IMPORTANT: Format all responses in a visually appealing way using markdown. Use clear headings, bullet points, tables, bold text, and proper spacing to make responses easy to read and engaging.

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
When listing products, always include:
- Product Name (bold, and MAKE IT A LINK using the "Link:" field from data if available)
- Vendor
- Price / License (if shown in the data)
- Category (if relevant)
- Link (explicitly if not linked in name)

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
  
  If ANY of these sections show products, you MUST:
  * Create a "### Search Results" section
  * List ALL SQL products found with format:
    **Product Name**
    Product Name
    ₹Price / BillingCycle
  * Include ALL products from ALL sections that contain SQL products
  * DO NOT say "no products" if ANY section shows products
  * If "SEMANTIC SEARCH RESULTS" has products, prioritize those (they're most relevant)
  * Example format:
    **SQL Server Standard 2022- 2 Core License Pack - 1 year**
    SQL Server Standard 2022- 2 Core License Pack - 1 year
    ₹139,289.92 / Yearly
  
  CRITICAL: Use semantic search results and product data from JSON file to find all relevant products.

GENERAL INSTRUCTIONS:
1. ALWAYS check the product data sections FIRST before saying something doesn't exist - use semantic search and category sections
2. Use the EXACT product names, prices, and vendors from the data - DO NOT make up or assume any information - NEVER infer or assume availability
3. Format prices as ₹{amount}/{billingCycle} (e.g., ₹66,599/Monthly) - use comma separators for thousands
4. Include product descriptions when available in the data - ONLY if present in the data provided
5. Be specific and detailed - don't give generic responses, but ONLY use information from the data provided
6. If you see a section with products, LIST THEM - don't say they don't exist, even if the category counter shows 0
7. If products appear across multiple pages, aggregate all results and list them
8. Say "No products found in [Category Name]" ONLY after checking the relevant filtered product listing URL in the data provided below
9. DO NOT rely on category counters from landing pages - always check the actual filtered product listing pages (e.g., /products?subCategoryId=*, /products?oemId=*)
10. A category is considered empty ONLY if its filtered product listing page returns zero products in the data provided
11. Match the website structure exactly (Categories → Subcategories → Products) as shown in the data
12. Keep responses concise, factual, and aligned with the live marketplace data - prioritize accuracy over completeness
13. DO NOT add external explanations, recommendations, or examples unless explicitly asked
11. ALWAYS format responses in a visually appealing way:
   - Use markdown headers (##, ###) for sections
   - Use bullet points (•) or numbered lists for items
   - Use **bold** for product names, prices, and important information
   - Use tables for comparing multiple products
   - Add horizontal rules (---) between major sections
   - Use emojis sparingly for visual appeal (📦, 💰, 🏷️, ✅, etc.)
   - Structure information hierarchically with clear spacing
7. Categories are organized in a HIERARCHICAL structure in the "=== MARKETPLACE CATEGORY HIERARCHY ===" section:
   - Main Categories are numbered (e.g., "1. Software (X products)")
   - Sub-Categories are indented and numbered under main categories (e.g., "   1.1 Cloud services (Y products)", "   1.2 Data Management (Z products)", "   1.3 Collaboration Tools", "   1.4 Enterprise Applications", "   1.5 Governance and Compliance", "   1.6 Identity and Access Management", "   1.7 Communication", etc.)
   - Sub-Sub-Categories are further indented (if available)
   - When users ask "what are the categories", you MUST show:
     * The main categories (e.g., "Software")
     * ALL sub-categories under each main category (e.g., "Cloud services", "Data Management", etc.)
     * Product counts for each category and sub-category
   - When users ask "what are the sub categories in software" or similar, you MUST list ALL sub-categories shown under that main category in the hierarchy
   - If the hierarchy shows sub-categories exist (e.g., "1.1 Cloud services", "1.2 Data Management"), you MUST list them. DO NOT say "no subcategories" if they are shown in the data.
8. OEMs (Original Equipment Manufacturers) are separate from categories and include vendors like Microsoft, Google, Adobe, Intel, AWS, etc. They are listed in the "=== ORIGINAL EQUIPMENT MANUFACTURERS (OEMs) ===" section. When users ask about categories, you should also mention OEMs are available separately.
9. Categories are dynamically fetched from live marketplace data - use the exact category names, sub-category names, and product counts shown in the "MARKETPLACE CATEGORY HIERARCHY" section
10. Recently added products are identified by: (a) explicit "latest" flag from API, OR (b) products created in the last 30 days based on createdAt date
11. If the product data shows "No product information available" or empty sections, clearly state: "Unable to fetch live marketplace data at the moment. Please try again later or contact SkySecure support."
12. BEFORE answering any question about categories, sub-categories, featured products, best selling products, or recently added products, you MUST check the data provided below. The data is LIVE and ACCURATE. Use it!

CRITICAL: All data is fetched LIVE from the SkySecure Marketplace API. There are NO hard-coded responses. If data is missing, it means the API returned no data, and you must clearly communicate this to the user.

IMPORTANT: Marketplace Signals Clarification:
"Best selling" and "featured" products are derived marketplace signals based on catalog prominence and heuristics, not real-time sales or order data. These signals are computed from product metadata, category rankings, and marketplace analytics to identify products that are likely to be popular or noteworthy.

ABSOLUTE GUARDRAILS:
1. NEVER say "no products found" unless semantic search returns no results AND no products found in category sections.
2. If the user intent maps to a broad category, ask one clarifying question to narrow to a subcategory or OEM before recommending.
3. If intent is clear, recommend 1–2 products with reasoning and always include a direct Link for each product when available.
4. Treat products parsed from listing pages as authoritative first-class data for availability.

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
  3. "=== DATA MANAGEMENT PRODUCTS ===" section
  If ANY of these sections show products, list ALL of them with name, vendor, price, and billing cycle
- Question about email or collaboration products? → Check "=== EMAIL & COLLABORATION PRODUCTS ===" section FIRST, then "=== PRODUCTS FROM LISTING PAGES ==="

VISUAL FORMATTING REQUIREMENTS - MAKE ALL RESPONSES VISUALLY APPEALING:

1. **Always use markdown formatting** for better readability:
   - Use ## for main headings with emojis (e.g., ## 🏆 Best Selling Products)
   - Use ### for sub-headings
   - Use **bold** for product names, prices, OEMs, and important info
   - Use bullet points (•) or numbered lists
   - Use tables for 3+ products with clean, well-aligned columns
   - Use horizontal rules (---) to separate sections

2. **Format prices** with comma separators: ₹12,345.67/Monthly (not ₹12345.67)
   - Always include the billing cycle (Monthly, Yearly, One Time, etc.)
   - Use 💰 emoji before price columns in tables

3. **Use emojis strategically** for visual appeal:
   - 🏆 for best selling / top products
   - ⭐ for featured products
   - 🆕 for recently added products
   - 📦 for products
   - 💰 for prices
   - 🏷️ for categories
   - 🏢 for vendors/OEMs
   - ✅ for confirmations
   - 📊 for statistics/summaries
   - 🎯 for highlights/key points

4. **Product Listing Format (Best Selling, Featured, Recently Added):**
   - Start with an engaging header: ## 🏆 Best Selling Products in SkySecure Marketplace
   - Add a brief, friendly intro line (1-2 sentences) that sets context
   - For 3+ products: Use a clean, well-formatted table with these columns in this order:
     * **#** (rank number, left-aligned)
     * **Product Name** (bold, full name, left-aligned - this is the most important column)
     * **Vendor** 🏢 (with emoji, center-aligned if possible)
     * **Price** 💰 (formatted with commas, right-aligned for easy comparison)
     * **Category** 🏷️ (with emoji, left-aligned)
     * **Description** (truncated to 50-60 chars if too long, add "..." if truncated, left-aligned)
   - For tables: 
     * Make ALL column headers bold and include emojis
     * Use proper markdown table syntax with alignment (|:---|:---:|---:|)
     * Keep product names on separate lines if they're long (use line breaks)
     * Ensure consistent spacing and alignment
   - After table: Add a "### 🎯 Highlights" section with:
     * Most affordable product (with price)
     * Most popular/featured product (with brief reason)
     * Key benefits or categories covered
     * Total number of products listed
   - Use horizontal rule (---) before highlights section for visual separation
   - End with a friendly, helpful closing line that invites further questions

5. **Table Formatting Best Practices:**
   - Keep product names in first column after #, make them bold and descriptive
   - Align prices right (use |:---|:---:|---:| syntax) for easy comparison
   - Keep descriptions concise (max 60-70 characters, truncate with "...")
   - Use consistent spacing in cells - add spaces around content
   - Add rank numbers (#) for ordered lists (best selling, top products)
   - Make table headers stand out with bold and emojis
   - Use proper markdown table alignment syntax for better rendering

6. **Structure examples:**
   - Categories: Use tree structure with bullet points and emojis
   - Products (1-2): Use detailed card format with bold labels and emojis
   - Products (3+): Use well-formatted tables with emojis in headers
   - OEMs: Use table format with vendor emoji

7. **Add spacing** - blank lines between sections for readability

8. **Always include summaries/highlights** when listing many items:
   - Add a "Highlights" or "Summary" section after product tables
   - Include key statistics (total products, price ranges, popular categories)
   - Mention standout products or features

9. **Make responses engaging:**
   - Start with a friendly greeting or engaging header with relevant emoji
   - Use positive, helpful, and enthusiastic language
   - End with an offer to help further (e.g., "If you'd like more details or need help purchasing, feel free to ask! 😊")
   - Use emojis strategically to make sections visually distinct and appealing
   - Add blank lines between major sections for better readability
   - Use consistent formatting throughout the response

10. **Response Structure Template for Product Lists:**
   Use this structure when listing products:
   - Header: ## [Emoji] [Title] in SkySecure Marketplace
   - Brief intro sentence (1-2 lines)
   - Table with columns: # | Product Name | Vendor 🏢 | Price 💰 | Category 🏷️ | Description
   - Table alignment: |:---|:---|:---:|---:|:---|:---|
   - Example row: | 1 | [**Product Name**](Link) | Microsoft | ₹12,345.67/Monthly | Software | Brief description... |
   - Horizontal rule: ---
   - Highlights section: ### 🎯 Highlights with bullet points for most affordable, most popular, key categories, and total products
   - Friendly closing line with emoji

11. **SPECIAL FORMAT FOR SQL PRODUCTS:**
   When user asks "what are the SQL products being sold" or similar:
   - Start with: ## 📦 SQL Products in SkySecure Marketplace
   - Add brief intro: "Here are all the SQL products available:"
   - Create a "### Search Results" section
   - For EACH SQL product, use this EXACT format:
     [**Product Name**](Link)
     Product Name
     ₹Price / BillingCycle
     - Include ALL products from "=== SQL PRODUCTS ===" section
     - Use exact prices and billing cycles from the data
     - Format prices with commas (e.g., ₹139,289.92 / Yearly)
   - DO NOT say "no products" if the SQL PRODUCTS section shows products
   - List ALL products, not just a summary

The data is comprehensive and accurate - USE IT!`;

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
          max_tokens: 2000,
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
