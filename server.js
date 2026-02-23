// IMPORTANT: Import polyfill FIRST before any other modules
import './polyfill.js';

import express from "express";
import dotenv from "dotenv";
import { makeRequest } from "./utils/httpClient.js";
import { formatProductsForKnowledgeBase } from "./utils/productFetcher.js";
import { fetchCategoryHierarchy, formatCategoryHierarchyForKnowledgeBase } from "./utils/categoryFetcher.js";
import { resolveIntent, inferConversationStage, isDomainRelated, isGreeting } from "./utils/intentMapper.js";

// Embedding service re-enabled with optimizations
import { trackConversationState, getStagePrompt, generateGuidingQuestion, suggestQuickReplies } from "./utils/conversationManager.js";
import { loadProductsFromJSON, productsToTextChunks } from "./utils/productLoader.js";
import { loadMarketplaceSignals, resolveProductsByIds } from "./utils/marketplaceSignalsLoader.js";
import { getUserTenantContext } from "./utils/userTenantService.js";

dotenv.config();

// Global flag to track if products have been indexed for semantic search
let isIndexed = false;

// Global Cache for Data (Approach #1 - Speed Optimization)
let cachedProducts = null;
let cachedSignals = null;
let cachedCategoryHierarchy = null;
let lastLoadTime = 0;
const CACHE_TTL = 300000; // 5 minutes cache TTL

/**
 * Loads all marketplace data into memory if not already cached
 * removing expensive File I/O from the chat loop.
 */
async function getMarketplaceData() {
  const now = Date.now();
  if (cachedProducts && (now - lastLoadTime < CACHE_TTL)) {
    return {
      products: cachedProducts,
      signals: cachedSignals,
      categories: cachedCategoryHierarchy
    };
  }

  console.log("📂 Reloading marketplace data into memory cache...");
  const [products, signals, categories] = await Promise.all([
    loadProductsFromJSON(),
    loadMarketplaceSignals(),
    fetchCategoryHierarchy()
  ]);

  cachedProducts = products;
  cachedSignals = signals;
  cachedCategoryHierarchy = categories;
  lastLoadTime = now;

  return { products, signals, categories };
}

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
function augmentKnowledgeBaseWithSignals(queryLower, products, marketplaceSignals, categoryRankings, oemRankings, intentInfo) {
  let augmentedSections = "";

  // aa) POWER BI SPECIFIC SEARCH (CRITICAL)
  if (queryLower.includes('power bi') && !queryLower.includes('video conferencing') && !queryLower.includes('email')) {
    const powerBiProducts = products.filter(p => (p.name || '').toLowerCase().includes('power bi'));
    if (powerBiProducts.length > 0) {
      augmentedSections += `\n=== ACCURATE POWER BI PRODUCTS (${powerBiProducts.length} products) ===\n`;
      augmentedSections += `MANDATORY: These are the ONLY Power BI products. Do NOT list Power Automate products for this query. ONLY recommend 3 products. Use FULL names.\n\n`;
      powerBiProducts.slice(0, 3).forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ${product.price ? `₹${product.price.toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}` : "Contact Sales"}\n`;
        const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END ACCURATE POWER BI PRODUCTS ===\n\n`;
    }
  }

  // ab) SMALL BUSINESS / BUSINESS PLANS (NEW)
  if (queryLower.includes('small business') || queryLower.includes('business plan') || queryLower.includes('1-50') || queryLower.includes('startup')) {
    const bizProducts = products.filter(p =>
      (p.name || '').toLowerCase().includes('business') ||
      (p.name || '').toLowerCase().includes('professional') ||
      (p.name || '').toLowerCase().includes('pro')
    ).filter(p => !p.name.toLowerCase().includes('add-on') && !p.name.toLowerCase().includes('storage'));

    if (bizProducts.length > 0) {
      augmentedSections += `\n=== RELEVANT BUSINESS PLANS FOR SMALL BUSINESS (${bizProducts.length} products) ===\n`;
      augmentedSections += `MANDATORY: Recommmend these specific "Business" plans. Do NOT provide generic outside advice or mention products like "Zoom" if NOT in this list.\n\n`;
      bizProducts.slice(0, 3).forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
        const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END BUSINESS PLANS ===\n\n`;
    }
  }

  // bb) ARTIFICIAL INTELLIGENCE & COPILOT SEARCH (ULTRA-STRICT)
  if (queryLower.includes('ai') || queryLower.includes('artificial intelligence') || queryLower.includes('copilot') || queryLower.includes('machine learning')) {
    const aiKeywords = ['ai', 'copilot', 'machine learning', 'artificial intelligence'];

    // 1. Resolve products from official "Artificial Intelligence" and "Copilot" ranking sections
    let officialAiProducts = [];
    if (Array.isArray(categoryRankings)) {
      for (const cat of categoryRankings) {
        const subs = cat.subCategories || cat.subcategories || [];
        for (const sub of subs) {
          const subName = (sub.name || '').toLowerCase();
          // Match "Artificial Intelligence" or "Copilot" subcategories
          if (subName === 'artificial intelligence' || subName === 'copilot') {
            if (sub.productIds) officialAiProducts = [...officialAiProducts, ...resolveProductsByIds(sub.productIds, products)];
          }

          const subSubs = sub.subSubs || sub.subSubcategories || [];
          for (const ss of subSubs) {
            const ssName = (ss.name || '').toLowerCase();
            if (ssName === 'artificial intelligence' || ssName === 'copilot') {
              if (ss.productIds) officialAiProducts = [...officialAiProducts, ...resolveProductsByIds(ss.productIds, products)];
            }
          }
        }
      }
    }

    // 2. Keyword fallback (only if no official products OR to supplement up to 10)
    let aiKeywordProducts = products.filter(p => {
      const name = (p.name || '').toLowerCase();
      const desc = (p.description?.overview || p.description || '').toLowerCase();
      // Must have "ai" as a whole word or other keywords
      return name.includes('copilot') || name.includes('artificial intelligence') ||
        (name.split(/\s+/).includes('ai')) || (desc.includes('artificial intelligence'));
    });

    // Merge: Official first, then keyword matches
    let finalAiList = [...new Set([...officialAiProducts, ...aiKeywordProducts])];

    if (finalAiList.length > 0) {
      augmentedSections += `\n=== ARTIFICIAL INTELLIGENCE (AI) SOLUTIONS (${finalAiList.length} products) ===\n`;
      augmentedSections += `CRITICAL: Recommendations MUST stay 100% within this list. NEVER mention external tools like ChatGPT, Claude, or Gemini.\n\n`;
      finalAiList.slice(0, 10).forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ${product.price ? `₹${product.price.toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}` : "Contact Sales"}\n`;

        // Fix category display
        const cat = product.category;
        const sub = (product.subCategory && product.subCategory !== product.category) ? product.subCategory : null;
        let catDisplay = cat;
        if (sub) catDisplay += ` > ${sub}`;
        augmentedSections += `   Category: ${catDisplay}\n`;

        const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END AI SOLUTIONS ===\n\n`;
    } else {
      augmentedSections += `\n=== NO AI PRODUCTS FOUND ===\n`;
      augmentedSections += `I could not find dedicated AI products. Inform the user we are constantly updating our catalog.\n`;
      augmentedSections += `=== END AI SOLUTIONS ===\n\n`;
    }
  }

  // bd) VIDEO CONFERENCING & COMMUNICATION (NEW)
  if (queryLower.includes('video') || queryLower.includes('conference') || queryLower.includes('meeting') || queryLower.includes('teams') || queryLower.includes('skype')) {
    const videoProducts = products.filter(p => {
      const name = (p.name || '').toLowerCase();
      const subCat = (p.subCategory || '').toLowerCase();
      return name.includes('teams') || name.includes('skype') || subCat.includes('video');
    });

    if (videoProducts.length > 0) {
      augmentedSections += `\n=== VIDEO CONFERENCING SOLUTIONS (${videoProducts.length} products) ===\n`;
      augmentedSections += `MANDATORY: Recommmend these communication tools. Use FULL names and include direct Links.\n\n`;
      videoProducts.slice(0, 5).forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
        const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END VIDEO CONFERENCING SOLUTIONS ===\n\n`;
    }
  }

  // bc) MICROSOFT 365 / OFFICE 365 SEARCH
  if (queryLower.includes('microsoft 365') || queryLower.includes('m365') || queryLower.includes('office 365') || queryLower.includes('o365')) {
    const m365Products = products.filter(p =>
      (p.name || '').toLowerCase().includes('microsoft 365') ||
      (p.name || '').toLowerCase().includes('office 365') ||
      (p.name || '').toLowerCase().includes('m365')
    ).filter(p => !p.name.toLowerCase().includes('add-on') && !p.name.toLowerCase().includes('storage'));

    if (m365Products.length > 0) {
      augmentedSections += `\n=== MICROSOFT 365 & OFFICE 365 PLANS (${m365Products.length} products) ===\n`;
      augmentedSections += `MANDATORY: Use these exact plans. Recommend only the most relevant ones (Business for SMB, Enterprise for large corp).\n\n`;
      m365Products.slice(0, 5).forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
        const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END M365 PLANS ===\n\n`;
    }
  }

  // bd) SECURITY SEARCH
  if (queryLower.includes('security') || queryLower.includes('protection') || queryLower.includes('defender') || queryLower.includes('cyber')) {
    const securityProducts = products.filter(p =>
      (p.subCategory || '').toLowerCase() === 'security' ||
      (p.name || '').toLowerCase().includes('security') ||
      (p.name || '').toLowerCase().includes('defender') ||
      (p.name || '').toLowerCase().includes('protection')
    );
    if (securityProducts.length > 0) {
      augmentedSections += `\n=== SECURITY AND PROTECTION SOLUTIONS (${securityProducts.length} products) ===\n`;
      augmentedSections += `These are official security products. Recommend based on user's specific security needs (identity, endpoint, etc.):\n\n`;
      securityProducts.slice(0, 5).forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ${product.price ? `₹${product.price.toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}` : "Contact Sales"}\n`;
        const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END SECURITY SOLUTIONS ===\n\n`;
    }
  }

  // ac) PRODUCTIVITY SEARCH
  if (queryLower.includes('productivity') || queryLower.includes('office') || queryLower.includes('workplace') || queryLower.includes('collaboration')) {
    const productivityProducts = products.filter(p =>
      (p.subCategory || '').toLowerCase() === 'productivity' ||
      (p.name || '').toLowerCase().includes('business') ||
      (p.name || '').toLowerCase().includes('m365') ||
      (p.name || '').toLowerCase().includes('office 365')
    );
    if (productivityProducts.length > 0) {
      augmentedSections += `\n=== PRODUCTIVITY SOLUTIONS (${productivityProducts.length} products) ===\n`;
      augmentedSections += `MANDATORY: These are the ONLY productivity products. Do NOT suggest Slack, Zoom, or Google Workspace as they are NOT in our marketplace.\n\n`;
      productivityProducts.slice(0, 5).forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ${product.price ? `₹${product.price.toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}` : "Contact Sales"}\n`;
        const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END PRODUCTIVITY SOLUTIONS ===\n\n`;
    }
  }

  // ad) ADD-ON / LICENSE SEARCH
  if (queryLower.includes('addon') || queryLower.includes('add-on') || queryLower.includes('licence') || queryLower.includes('license') || queryLower.includes('additional')) {
    const addonProducts = products.filter(p =>
      (p.name || '').toLowerCase().includes('add on') ||
      (p.name || '').toLowerCase().includes('add-on') ||
      (p.name || '').toLowerCase().includes('storage') ||
      (p.name || '').toLowerCase().includes('premium') ||
      (p.name || '').toLowerCase().includes('defender') ||
      (p.name || '').toLowerCase().includes('protection')
    );
    if (addonProducts.length > 0) {
      augmentedSections += `\n=== RECOMMENDED ADD-ONS & LICENSES (${addonProducts.length} products) ===\n`;
      augmentedSections += `Use these products when the user asks for "add-ons" or "additional licenses":\n\n`;
      addonProducts.slice(0, 5).forEach((product, index) => {
        augmentedSections += `${index + 1}. **${product.name}**\n`;
        augmentedSections += `   Vendor: ${product.vendor}\n`;
        augmentedSections += `   Price: ${product.price ? `₹${product.price.toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}` : "Contact Sales"}\n`;
        const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
        if (link) augmentedSections += `   Link: ${link}\n`;
        augmentedSections += `\n`;
      });
      augmentedSections += `=== END ADD-ONS ===\n\n`;
    }
  }

  // a) BEST SELLING PRODUCTS
  if (queryLower.includes('best selling') || queryLower.includes('top selling') || queryLower.includes('popular products') || queryLower.includes('best seller')) {
    if (marketplaceSignals?.bestSelling && Array.isArray(marketplaceSignals.bestSelling)) {
      const bestSellingProducts = resolveProductsByIds(marketplaceSignals.bestSelling, products);
      if (bestSellingProducts.length > 0) {
        augmentedSections += `\n=== TOP SELLING / BEST SELLING PRODUCTS (${bestSellingProducts.length} products) ===\n`;
        augmentedSections += `These are the best selling products in SkySecure Marketplace. Recommend exactly 3 products:\n\n`;
        bestSellingProducts.slice(0, 3).forEach((product, index) => {
          augmentedSections += `${index + 1}. **${product.name}**\n`;
          augmentedSections += `   Vendor: ${product.vendor}\n`;
          augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
          augmentedSections += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
          const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
          if (link) augmentedSections += `   Link: ${link}\n`;
          if (product.description) {
            augmentedSections += `   Description: ${product.description.substring(0, 150)}...\n`;
          }
          augmentedSections += `\n`;
        });
        augmentedSections += `=== END TOP SELLING / BEST SELLING PRODUCTS ===\n\n`;
      }
    }
  }

  // a2) FEATURED PRODUCTS
  if (queryLower.includes('featured') || queryLower.includes('recommended products')) {
    if (marketplaceSignals?.featured && Array.isArray(marketplaceSignals.featured)) {
      const featuredProducts = resolveProductsByIds(marketplaceSignals.featured, products);
      if (featuredProducts.length > 0) {
        augmentedSections += `\n=== FEATURED PRODUCTS (${featuredProducts.length} products) ===\n`;
        augmentedSections += `These are featured products hand-picked for our marketplace. Recommend exactly 3 products:\n\n`;
        featuredProducts.slice(0, 3).forEach((product, index) => {
          augmentedSections += `${index + 1}. **${product.name}**\n`;
          augmentedSections += `   Vendor: ${product.vendor}\n`;
          augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
          const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
          if (link) augmentedSections += `   Link: ${link}\n`;
          augmentedSections += `\n`;
        });
        augmentedSections += `=== END FEATURED PRODUCTS ===\n\n`;
      }
    }
  }

  // a3) RECENTLY ADDED PRODUCTS
  if (queryLower.includes('recently added') || queryLower.includes('latest products') || queryLower.includes('new products')) {
    if (marketplaceSignals?.recentlyAdded && Array.isArray(marketplaceSignals.recentlyAdded)) {
      const recentlyAddedIds = marketplaceSignals.recentlyAdded.map(item => typeof item === 'object' ? item.productId || item.id : item);
      const recentlyAddedProducts = resolveProductsByIds(recentlyAddedIds, products);
      if (recentlyAddedProducts.length > 0) {
        augmentedSections += `\n=== RECENTLY ADDED PRODUCTS (${recentlyAddedProducts.length} products) ===\n`;
        augmentedSections += `These are the latest additions to the SkySecure Marketplace catalog. Recommend exactly 3 products:\n\n`;
        recentlyAddedProducts.slice(0, 3).forEach((product, index) => {
          augmentedSections += `${index + 1}. **${product.name}**\n`;
          augmentedSections += `   Vendor: ${product.vendor}\n`;
          augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
          const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
          if (link) augmentedSections += `   Link: ${link}\n`;
          augmentedSections += `\n`;
        });
        augmentedSections += `=== END RECENTLY ADDED PRODUCTS ===\n\n`;
      }
    }
  }

  // b) CATEGORY OVERVIEW
  if (queryLower.includes('categories') || queryLower.includes('domains') || queryLower.includes('segments') ||
    queryLower.includes('what categories') || queryLower.includes('list categories')) {
    if (Array.isArray(categoryRankings)) {
      augmentedSections += `\n=== CATEGORY OVERVIEW ===\n`;
      augmentedSections += `SkySecure Marketplace offers Software products under these main domains:\n\n`;
      categoryRankings.forEach(cat => {
        augmentedSections += `- **${cat.category || cat.name}**: ${cat.productCount || cat.count || 0} products\n`;
        if (cat.subCategories || cat.subcategories) {
          const subs = cat.subCategories || cat.subcategories;
          subs.slice(0, 5).forEach(sub => {
            augmentedSections += `  - ${sub.name}: ${sub.count} products\n`;
          });
          if (subs.length > 5) augmentedSections += `  - ... and ${subs.length - 5} more sub-categories\n`;
        }
      });
      augmentedSections += `=== END CATEGORY OVERVIEW ===\n\n`;
    } else if (categoryRankings && typeof categoryRankings === 'object') {
      augmentedSections += `\n=== CATEGORY OVERVIEW ===\n`;
      augmentedSections += `SkySecure Marketplace offers Software products under these domains:\n\n`;
      Object.entries(categoryRankings).forEach(([categoryName, productIds]) => {
        const productCount = Array.isArray(productIds) ? productIds.length : 0;
        augmentedSections += `- **${categoryName}**: ${productCount} products\n`;
      });
      augmentedSections += `=== END CATEGORY OVERVIEW ===\n\n`;
    }
  }

  // c) CATEGORY-SPECIFIC QUERIES (Enhanced for Hierarchical Data)
  if (Array.isArray(categoryRankings)) {
    for (const cat of categoryRankings) {
      const categoryName = cat.category || cat.name;
      const categoryLower = categoryName.toLowerCase();

      // Check for main category match
      if (queryLower.includes(categoryLower)) {
        // Collect all product IDs in this category branch
        let allIds = [];
        if (cat.subCategories || cat.subcategories) {
          const subs = cat.subCategories || cat.subcategories;
          subs.forEach(sub => {
            if (sub.productIds) allIds = allIds.concat(sub.productIds);
            if (sub.subSubs || sub.subSubcategories) {
              const subsubs = sub.subSubs || sub.subSubcategories;
              subsubs.forEach(ss => {
                if (ss.productIds) allIds = allIds.concat(ss.productIds);
              });
            }
          });
        }

        if (allIds.length > 0) {
          const categoryProducts = resolveProductsByIds([...new Set(allIds)], products);
          if (categoryProducts.length > 0) {
            augmentedSections += `\n=== PRODUCTS IN CATEGORY: ${categoryName} (${categoryProducts.length} products) ===\n`;
            augmentedSections += `Provide exactly 3 recommendations from this list:\n\n`;
            categoryProducts.slice(0, 5).forEach((product, index) => {
              augmentedSections += `${index + 1}. **${product.name}**\n`;
              augmentedSections += `   Vendor: ${product.vendor}\n`;
              augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
              const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
              if (link) augmentedSections += `   Link: ${link}\n`;
              augmentedSections += `\n`;
            });
            augmentedSections += `=== END PRODUCTS IN CATEGORY: ${categoryName} ===\n\n`;
          }
        }
      }

      // Check for sub-category match
      const subs = cat.subCategories || cat.subcategories || [];
      for (const sub of subs) {
        const subName = (sub.name || '').toLowerCase();
        const subId = sub._id || sub.id;

        // Match sub-category
        const isSubMatch = queryLower.includes(subName) || (intentInfo?.subCategoryId === subId);

        // Match sub-sub-categories
        const subSubs = sub.subSubs || sub.subSubcategories || [];
        const matchingSubSub = subSubs.find(ss =>
          queryLower.includes((ss.name || '').toLowerCase()) ||
          (intentInfo?.subCategoryId === (ss._id || ss.id))
        );

        if (isSubMatch || matchingSubSub) {
          // Collect product IDs specifically for the match if possible
          let targetIds = [];
          if (matchingSubSub && matchingSubSub.productIds) {
            targetIds = matchingSubSub.productIds;
            augmentedSections += `\n=== PRODUCTS IN ${matchingSubSub.name.toUpperCase()} (${targetIds.length} products) ===\n`;
          } else {
            targetIds = sub.productIds || [];
            if (subSubs.length > 0) {
              subSubs.forEach(ss => { if (ss.productIds) targetIds = targetIds.concat(ss.productIds); });
            }
            augmentedSections += `\n=== PRODUCTS IN ${sub.name.toUpperCase()} (${targetIds.length} products) ===\n`;
          }

          if (targetIds.length > 0) {
            const subProducts = resolveProductsByIds([...new Set(targetIds)], products);
            if (subProducts.length > 0) {
              augmentedSections += `MANDATORY: Use the FULL name associated with the price. Do NOT truncate product names.\n`;
              augmentedSections += `Provide exactly 3 recommendations from this list:\n\n`;
              subProducts.slice(0, 5).forEach((product, index) => {
                augmentedSections += `${index + 1}. **${product.name}**\n`;
                augmentedSections += `   Vendor: ${product.vendor}\n`;
                augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
                const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
                if (link) augmentedSections += `   Link: ${link}\n`;
                augmentedSections += `\n`;
              });
              augmentedSections += `=== END PRODUCTS ===\n\n`;
            }
          }
        }
      }
    }
  }

  // d) OEM / VENDOR QUERIES
  if (Array.isArray(oemRankings)) {
    for (const oem of oemRankings) {
      const oemName = oem.oem || oem.name;
      const oemLower = oemName.toLowerCase();
      if (queryLower.includes(oemLower) || queryLower.includes(`${oemLower} products`)) {
        const oemProducts = resolveProductsByIds(oem.productIds || [], products);
        if (oemProducts.length > 0) {
          augmentedSections += `\n=== PRODUCTS BY OEM/VENDOR: ${oemName} (${oemProducts.length} products) ===\n`;
          oemProducts.slice(0, 3).forEach((product, index) => {
            augmentedSections += `${index + 1}. **${product.name}**\n`;
            augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
            augmentedSections += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
            const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
            if (link) augmentedSections += `   Link: ${link}\n`;
            augmentedSections += `\n`;
          });
          augmentedSections += `=== END PRODUCTS BY OEM/VENDOR: ${oemName} ===\n\n`;
          break;
        }
      }
    }
  } else if (oemRankings && typeof oemRankings === 'object') {
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
            oemProducts.slice(0, 3).forEach((product, index) => {
              augmentedSections += `${index + 1}. **${product.name}**\n`;
              augmentedSections += `   Price: ₹${(product.price || 0).toLocaleString('en-IN')}/${product.billingCycle || "Monthly"}\n`;
              augmentedSections += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
              const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
              if (link) augmentedSections += `   Link: ${link}\n`;
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

    // Extract user identification from request
    // Support both Authorization header and request body
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const accessToken = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : req.body.accessToken || null;
    const userId = req.body.userId || req.headers['x-user-id'] || null;

    // DEBUG: Log user identification extraction
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔍 USER IDENTIFICATION DEBUG`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Authorization Header Present: ${!!authHeader}`);
    console.log(`AccessToken from Header: ${accessToken ? `${accessToken.substring(0, 20)}...` : 'null'}`);
    console.log(`AccessToken from Body: ${req.body.accessToken ? `${req.body.accessToken.substring(0, 20)}...` : 'null'}`);
    console.log(`UserId from Body: ${req.body.userId || 'null'}`);
    console.log(`UserId from Header (x-user-id): ${req.headers['x-user-id'] || 'null'}`);
    console.log(`Final AccessToken: ${accessToken ? 'PRESENT' : 'MISSING'}`);
    console.log(`Final UserId: ${userId || 'MISSING'}`);
    console.log(`AUTH_SERVICE_URL: ${process.env.AUTH_SERVICE_URL || 'http://localhost:3000 (default)'}`);
    console.log(`${'='.repeat(80)}\n`);

    // Load products from JSON file instead of scraping/API
    const baseUrl = process.env.KNOWLEDGE_BASE_URL || "https://shop.skysecure.ai/";
    let relevantContent = "";

    // DYNAMIC: Parallelize data fetching and intent resolution for speed
    console.log("🚀 Initializing optimized data access...");
    const dataFetchPromise = getMarketplaceData();

    console.log("🚀 Starting parallel data fetch and intent resolution...");
    console.log(`📝 Message: "${message}"`);
    console.log(`🌐 Base URL: ${baseUrl}`);
    const productsPromise = loadProductsFromJSON();
    const signalsPromise = loadMarketplaceSignals();
    const categoryPromise = fetchCategoryHierarchy();
    const intentPromise = resolveIntent(message, baseUrl);

    // Await intent resolution early as it's needed for stage inference
    const intentInfo = await intentPromise;

    // FAST TRACK: Handle greetings and off-topic questions quickly...
    const greeting = isGreeting(message);
    const domainRelated = isDomainRelated(message, intentInfo);

    // Only fast-track if it's a greeting WITH NO domain intent, or if it's off-topic
    if ((greeting && !domainRelated) || !domainRelated) {
      console.log(`⚡ Fast-tracking ${greeting ? 'greeting' : 'off-topic'} response`);

      // Fetch user tenant context for fast-track responses too (non-blocking)
      let fastUserTenantContext = "";
      if (greeting) {
        try {
          const tenantContextPromise = getUserTenantContext(userId, accessToken);
          fastUserTenantContext = await Promise.race([
            tenantContextPromise,
            new Promise((resolve) => setTimeout(() => resolve(""), 3000)) // 3s timeout for fast track
          ]).catch(() => "");
        } catch (error) {
          // Ignore errors in fast track
        }
      }

      const fastSystemPrompt = `You are a helpful virtual assistant for SkySecure Marketplace.
      ${greeting ? 'The user just said hello. Respond with a warm, professional greeting and briefly ask how you can help them with software or IT needs.' : 'The user asked something outside the scope of software and IT. Politely inform them that you specialize in SkySecure Marketplace products and services.'}
      ${fastUserTenantContext ? `\n\nUSER'S TENANT INFORMATION:\n${fastUserTenantContext}\n\nIf the user asks about their licenses, subscriptions, or what they currently own, you MUST provide the specific details from the "USER'S ACTIVE SUBSCRIPTIONS" list above. List Product Name, SKU, and available counts.` : ''}
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
        body: {
          messages: fastMessages,
          temperature: 0.7,
          max_tokens: 1500 // Increased from 500 to prevent truncation
        }
      });

      const responseData = await response.json();
      const botResponse = responseData.choices[0]?.message?.content || "How can I help you today?";

      // Diagnostic for truncation in fast-track
      if (responseData.choices?.[0]?.finish_reason === 'length') {
        console.warn("⚠️  Fast-track response was truncated due to length!");
      }

      return res.json({
        success: true,
        message: botResponse,
        quickReplies: greeting ? [
          { text: "Show Best Sellers", value: "Show best selling products" },
          { text: "Browse Categories", value: "What are the categories?" },
          { text: "Recently Added", value: "What are recently added products?" },
          { text: "Featured Products", value: "Show featured products" }
        ] : [],
        conversationStage: "Discovery"
      });
    }

    const conversationStage = inferConversationStage(conversationHistory, message, intentInfo);
    const conversationState = trackConversationState(conversationHistory, message, intentInfo);
    console.log(`Conversation state: Stage=${conversationState.stage}, Confidence=${conversationState.confidence}`);
    const stagePrompt = getStagePrompt(conversationState.stage, conversationState.context);
    const quickReplies = suggestQuickReplies(conversationState.stage, intentInfo);

    // Fetch user tenant context (non-blocking, with timeout)
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔍 FETCHING USER TENANT CONTEXT`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Starting tenant context fetch...`);
    let userTenantContext = "";
    try {
      const tenantContextPromise = getUserTenantContext(userId, accessToken);
      userTenantContext = await Promise.race([
        tenantContextPromise,
        new Promise((resolve) => setTimeout(() => resolve(""), 5000)) // 5s timeout
      ]).catch(err => {
        console.error(`❌ Error in tenant context promise: ${err.message}`);
        console.error(`Stack: ${err.stack}`);
        return "";
      });

      console.log(`Tenant context fetch completed`);
      console.log(`Context length: ${userTenantContext.length} characters`);
      if (userTenantContext) {
        console.log(`✅ User tenant context retrieved successfully`);
        console.log(`First 300 chars of context:\n${userTenantContext.substring(0, 300)}...`);
      } else {
        console.log(`⚠️  No user tenant context available`);
        console.log(`Possible reasons:`);
        console.log(`  1. User not authenticated (no userId or accessToken)`);
        console.log(`  2. Tenant not connected`);
        console.log(`  3. Auth service unavailable`);
        console.log(`  4. API endpoint mismatch`);
        console.log(`  5. Response structure mismatch`);
      }
    } catch (error) {
      console.error(`❌ Failed to fetch user tenant context: ${error.message}`);
      console.error(`Stack: ${error.stack}`);
      // Continue without tenant context - don't fail the conversation
    }
    console.log(`${'='.repeat(80)}\n`);

    // Use Optimized Memory Cache
    const { products: productsFromJSON, signals: marketplaceSignals, categories: categoryDataRaw } = await dataFetchPromise;


    // Index products with embeddings for semantic search - ONLY ONCE
    // if (productsFromJSON.length > 0 && !isIndexed) {
    //   console.log("Indexing products with embeddings for semantic search (First Run)...");
    //   const productChunks = productsToTextChunks(productsFromJSON);
    //   try {
    //     await Promise.race([
    //       indexProductChunks(productChunks),
    //       new Promise((resolve) => setTimeout(() => resolve(), 30000))
    //     ]);
    //     isIndexed = true;
    //     console.log("✅ Semantic search indexing complete");
    //   } catch (err) {
    //     console.warn("Product indexing failed:", err.message);
    //   }
    // }

    // Get relevant content using semantic search
    let relevantContentPromise = Promise.resolve("");
    // if (productsFromJSON.length > 0 && isIndexed) {
    //   console.log("Finding relevant products via Semantic Cache...");
    //   relevantContentPromise = getRelevantContent(message, 10).catch(() => "");
    // }

    let products = productsFromJSON || [];
    const signalsData = marketplaceSignals?.marketplaceSignals || {};
    const categoryRankings = marketplaceSignals?.categoryRankings || [];
    const oemRankings = marketplaceSignals?.oemRankings || [];

    // Await semantic search result
    relevantContent = await relevantContentPromise;

    // Enrich products with cached signals (Optimized)
    if (signalsData) {
      if (signalsData.bestSelling) {
        resolveProductsByIds(signalsData.bestSelling, products).forEach(p => p.isTopSelling = true);
      }
      if (signalsData.featured) {
        resolveProductsByIds(signalsData.featured, products).forEach(p => p.isFeatured = true);
      }
      if (signalsData.recentlyAdded) {
        const recentlyAddedIds = signalsData.recentlyAdded.map(item => typeof item === 'object' ? (item.productId || item.id) : item);
        resolveProductsByIds(recentlyAddedIds, products).forEach(p => p.isLatest = true);
      }
    }

    // DYNAMIC SEARCH: Analyze query (Optimized)
    const queryLower = message.toLowerCase();
    const searchTerms = [];
    if (queryLower.includes('sql') || queryLower.includes('database')) searchTerms.push('SQL/Database');
    if (queryLower.includes('email') || queryLower.includes('exchange') || queryLower.includes('outlook')) searchTerms.push('Email');
    if (queryLower.includes('power bi')) searchTerms.push('Power BI');
    if (queryLower.includes('power automate')) searchTerms.push('Power Automate');
    if (queryLower.includes('ai ') || queryLower.includes('artificial intelligence') || queryLower.includes('copilot')) searchTerms.push('Artificial Intelligence');
    if (queryLower.includes('video') || queryLower.includes('conference') || queryLower.includes('meeting')) searchTerms.push('Video Conferencing');

    // Group products for formatting
    const productsByCategory = {};
    products.forEach(p => {
      const cat = p.category || 'Uncategorized';
      if (!productsByCategory[cat]) productsByCategory[cat] = [];
      productsByCategory[cat].push(p);
    });

    console.log(`✅ Knowledge Base Ready: ${products.length} products, ${searchTerms.length} active filters.`);

    // Build category hierarchy formatting (Optimized)
    let categoryHierarchy = "";
    try {
      categoryHierarchy = formatCategoryHierarchyForKnowledgeBase(
        categoryDataRaw.categories || [],
        categoryDataRaw.oems || [],
        products
      );
    } catch (err) {
      console.error("Error formatting categories:", err.message);
      categoryHierarchy = "Category hierarchy unavailable.";
    }

    // Skip website scraping - using products from JSON file
    console.log("✅ Using cached marketplace data - skipping slow operations");

    // Re-format knowledge base with products - Use LIMITED version for faster response
    let productKnowledgeBase = formatProductsForKnowledgeBase(productsFromJSON, false);

    // Augment knowledge base with signals
    const augmentedSections = augmentKnowledgeBaseWithSignals(
      queryLower,
      products,
      signalsData,
      categoryRankings,
      oemRankings,
      intentInfo
    );

    if (augmentedSections) {
      productKnowledgeBase += augmentedSections;
      console.log(`✅ Augmented knowledge base with marketplace signals`);
    }

    // Build system prompt with knowledge base
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔍 BUILDING SYSTEM PROMPT`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Including userTenantContext: ${userTenantContext ? 'YES' : 'NO'}`);
    if (userTenantContext) {
      console.log(`Tenant context length: ${userTenantContext.length} characters`);
      console.log(`Tenant context preview:\n${userTenantContext.substring(0, 400)}...`);
    }
    console.log(`${'='.repeat(80)}\n`);

    const systemPrompt = `You are a helpful, friendly, and visually-oriented virtual assistant for SkySecure Marketplace (Official URL: ${baseUrl}), similar to Amazon's Rufus. Your role is to help customers with questions about products, services, pricing, and general inquiries.

IDENTIFICATION RULES:
- When asked "who are you" or "what model are you", you MUST respond with: "I'm here to assist with SkySecure Marketplace products and services."
- NEVER mention that you are a GPT model or developed by OpenAI unless explicitly challenged, even then pivot back to SkySecure.
- Do NOT use technical names like GPT-4o in your introduction.

DO NOT attempt to answer the off-topic question. politely decline and pivot back to the marketplace.

IMPORTANT: Format all responses in a visually appealing way using markdown. Use clear headings, bullet points (NO TABLES), bold text, and proper spacing to make responses easy to read and engaging.

=== SKYSECURE COMPANY INFORMATION (Always use these EXACT links) ===

CONTACT DETAILS:
- 📞 Phone: +91 73533 55526 (Mon–Fri, 9am–6pm IST)
- 💬 WhatsApp: +91 7625043383 (https://wa.me/917353355526)
- 📧 Email: sales@skysecure.ai
- 🏢 Address: Sakti Statesman, Unit # G/M-06 & 07, Marathahalli - Sarjapur Outer Ring Rd, 7th Cross, Green Glen Layout, Ibbaluru, Bengaluru, Karnataka 560103
- 🗺️ Directions: https://maps.google.com/?q=Sakti+Statesman+Unit+G+M+06+07+Marathahalli+Sarjapur+Outer+Ring+Rd+7th+Cross+Green+Glen+Layout+Ibbaluru+Bengaluru+Karnataka+560103

COMPANY PAGES:
- About Us: https://shop.skysecure.ai/about-us
- Careers: https://skysecure.zohorecruit.in/jobs/Careers

SUPPORT PAGES:
- Contact Us: https://shop.skysecure.ai/contact-us
- Order Status: https://shop.skysecure.ai/orders
- Feedback / Reviews: https://shop.skysecure.ai/review

LEGAL & POLICY PAGES:
- Terms of Service: https://shop.skysecure.ai/terms-of-service
- Privacy Policy: https://shop.skysecure.ai/privacy-policy
- Refund Policy: https://shop.skysecure.ai/refund-policy
- Cookie Policy: https://skysecure.ai/cookie-policy/
- (Note: "Terms and Conditions" and "Terms of Service" use the same link: https://shop.skysecure.ai/terms-of-service)

IMPORTANT LINK RULES FOR COMPANY/SUPPORT/POLICY QUERIES:
- ALWAYS use EXACTLY the links above. NEVER guess or modify them.
- The contact page is /contact-us NOT /contact.
- For any question about "contact", "phone", "email", "WhatsApp", "address", or "reach you" → use Contact Us link + provide the phone, WhatsApp, and email details.
- For any question about "about", "who is skysecure", "company" → use About Us link.
- For any question about "careers", "jobs", "work" → use Careers link.
- For any question about "order", "order status", "my order" → use Order Status link.
- For any question about "feedback", "review", "rating" → use Feedback link.
- For any question about "terms", "conditions", "terms of service", "terms and conditions" → use the Terms of Service link (https://shop.skysecure.ai/terms-of-service).
- For any question about "privacy", "data policy", "data protection" → use Privacy Policy link.
- For any question about "refund", "cancellation", "money back", "return policy" → use Refund Policy link.
- For any question about "cookie", "cookie policy" → use the Cookie Policy link (https://skysecure.ai/cookie-policy/).

=== END SKYSECURE COMPANY INFORMATION ===

⚠️  ULTRA-STRICT DATA SOURCE PROTOCOL (EXCLUSIVE SOURCE) ⚠️

YOU ARE A SEARCH ENGINE FOR SKYSECURE MARKETPLACE ONLY. YOUR GENERAL AI TRAINING KNOWLEDGE DOES NOT EXIST HERE.
- **ABSOLUTE RULE #1 — ZERO HALLUCINATION**: You MAY ONLY name a product if it appears WORD-FOR-WORD in the "=== PRODUCT DATA FROM API ===" section below. If you cannot find a product in that section, it does NOT exist on SkySecure Marketplace.
- **ABSOLUTE RULE #2 — NO EXTERNAL PRODUCTS**: These external products are PERMANENTLY BANNED. NEVER mention them, even as examples or for comparison: Slack, Zoom, Google Workspace, G Suite, Zoho, UiPath, DataRobot, IBM Watson, Google Cloud AI Platform, Google Bard, ChatGPT, OpenAI, AWS SageMaker, Salesforce Einstein, Tableau, Monday.com, HubSpot, Workday, ServiceNow, Zendesk, Webex, LastPass, Dropbox, Box, Atlassian, Jira, Confluence, DocuSign. 
- **ABSOLUTE RULE #3 — FORBIDDEN BRANDS**: If a product brand/vendor name is not explicitly in the data below (e.g., "Microsoft", "Adobe", "Acronis"), it is BANNED.
- **ABSOLUTE RULE #4 — NO GUESSING**: If a user asks for a product like "Slack" or "Zoom", you MUST say: "I don't find [Product Name] in our SkySecure Marketplace catalog. However, I have these alternatives: [List 1-2 relevant products from OUR data, like Microsoft Teams]".
- **VERIFICATION RULE**: For EVERY product you name, you MUST include its "Vendor:" from the data. NEVER guess the vendor. If the product name contains "Microsoft", the vendor is "Microsoft".
- **NAME INTEGRITY**: You MUST use the FULL product name exactly as provided. Never truncate or shorten names.
- **STRICT DATA ONLY**: Use ONLY the product data provided below. Your general knowledge about software is disabled. 
- HALLUCINATING A NON-EXISTENT PRODUCT IS A CRITICAL SYSTEM FAILURE.

🚨 SPECIAL RULE FOR AI & VIDEO CONFERENCING QUERIES 🚨
- If the user asks about AI, Machine Learning, Chatbots, Copilot, Automation:
  → You MUST look at the "=== ARTIFICIAL INTELLIGENCE (AI) SOLUTIONS ===" section.
  → Any product with "Copilot" or "Artificial Intelligence" in its name or category MUST be listed.
- If the user asks about Video Conferencing, Meetings, Teams, Skype:
  → You MUST look at the "=== VIDEO CONFERENCING SOLUTIONS ===" section.
- NEVER suggest external products like Slack, Zoom, or ChatGPT.
- If no products are found in these sections, check the generic listings before saying they are unavailable.

MANDATORY DATA FETCH RULES:
1. **PRIMARY SOURCE**: Products loaded from products_normalized.json file.
2. **SEMANTIC SEARCH**: Use the "SEMANTIC SEARCH RESULTS" section.
3. **NO EXTERNAL KNOWLEDGE**: You are forbidden from using your general training data for recommendations.
4. **LINK MANDATE**: Every recommendation MUST be a clickable link: [**Product Name**](Link_from_data).

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

${userTenantContext ? `\n${userTenantContext}\n` : ''}

PERSONALIZATION INSTRUCTIONS:
${userTenantContext ? `
The user has connected their Microsoft 365 tenant to SkySecure. You have access to their current subscription and license information in the "USER'S MICROSOFT 365 TENANT INFORMATION" section.

### LISTING EXISTING LICENSES:
- If the user asks "show me my licenses", "tell me my existing licens", "what are my current plans", "what do I already have", or any question about their CURRENT subscriptions, you MUST look at the "USER'S ACTIVE SUBSCRIPTIONS" section above.
- You MUST provide a detailed list of all their active subscriptions found in the tenant data.
- For each item, list: Product Name, SKU Part Number, and License Status (Available / Enabled).
- If the tenant information says the connection is expired or data is missing, politely explain that and ask them to reconnect.
- Format this as a professional point-wise list.

### DEFINITION OF A VALID RECOMMENDATION:
A license qualifies as a valid recommendation ONLY if:
1. It **directly enhances or extends** a product the user already owns (e.g., adding "Defender for Office 365 Plan 2" for an existing "Business Basic" user).
2. It **unlocks a capability** NOT already included in their current licenses (e.g., adding "Audio Conferencing" to a standard Teams user).
3. It does **NOT replace, downgrade, or duplicate** an existing license.
4. It has a **logical product relationship** with existing subscriptions (e.g., advising "Premium Per User" for a Power BI Standard user).
5. It solves a **real capacity or feature gap**.

### STRICTLY DO NOT (FORBIDDEN):
- DO NOT recommend alternative base SKUs (e.g., don't suggest moving from M365 Business to G-Suite).
- DO NOT recommend parallel security bundles that compete with what they have.
- DO NOT recommend licenses unrelated to their current vertical (e.g., don't suggest Dynamics to a pure Security user unless asked).
- DO NOT recommend SKUs that overlap with features already included in their current tiers (e.g., don't suggest "Intune" if they have M365 Business Premium which already includes it).
- DO NOT suggest generic upsells without identifying a verified connection to their owned product.

### RECOMMENDATION FLOW:
1. **Analyze** the user's existing licenses from the tenant data first.
2. **Identify** enhancement paths within the same product family (e.g., Security, Collaboration, Storage, AI).
3. **Recommend ONE logically connected add-on at a time** to avoid overwhelming the user.
4. **Mandatory Explanation Structure**: For every recommendation, you MUST clearly state:
    - **Product**: [**Full Product Name**](URL_from_data) | 🏢 **Vendor**: [Vendor]
    - **Existing license it enhances**: [Name of owned license]
    - **New capability it unlocks**: [Specific feature/benefit]
    - **Why it does not overlap**: [Verification that it is an add-on, not a duplication]

CRITICAL: If you cannot find a product link in the data, DO NOT recommend it. Every single product mention MUST be a clickable link.

### RESPONSE RULES:
- If the user asks for recommendations, follow the flow above.
- If the user asks for their "existing licenses" or "current subscriptions", list the data from the tenant information section.
- Use the exact subscription names from the marketplace data.
- Always include the direct link and vendor for any recommended add-on.

IMPORTANT: Always prioritize the user's actual subscription data from the "USER'S MICROSOFT 365 TENANT INFORMATION" section to answer questions about what they currently own.
` : `
The user has not connected their Microsoft 365 tenant. You cannot list their existing licenses or provide personalized recommendations. Politely invite them to connect their tenant via the "Connect Tenant" button in the dashboard to access their active subscriptions and receive tailored upgrade paths.
`}

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
- User asks "what are the categories in skysecure marketplace" → Look for "=== MARKETPLACE CATEGORY HIERARCHY ===" section. 
  * SHOW ONLY the top-level main categories (e.g., "1. Software").
  * DO NOT list sub-categories for every main category at once.
  * Instead, offer to show sub-categories for a specific main category of their choice.
- User asks "what are the sub categories in software" → Look for "=== MARKETPLACE CATEGORY HIERARCHY ===" section, find "Software" category, and list its immediate sub-categories (e.g., "1.1 Productivity", "1.2 Security"). DO NOT list sub-sub-categories unless specifically asked.
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
   - **DO NOT** use generic link text like "View Product", "Buy Now", or "Click here".
   - **DO NOT** hide the link in a separate line if possible; the product name ITSELF must be the link.
4. **PRODUCT LISTING FORMAT**:
   1. [**Product Name**](Direct_URL_From_Data) | 🏢 **Vendor**: [Vendor] | 💰 **Price**: [Prices]
      - 📝 **Description**: [Brief 1-sentence description]
5. **PRICING**: Format as ₹{amount}/{Cycle}.
6. **STRICT LINK GUARDRAIL**: ONLY use URLs from the "Link:" field. NEVER guess or use "skysecuremarketplace.com". All official links start with "https://shop.skysecure.ai/".
7. **CATEGORIES**: Organized in the "MARKETPLACE CATEGORY HIERARCHY" section. Use the exact hierarchy (1., 1.1, 1.2, etc.) and product counts provided.
8. **ACCURACY**: Use EXACT names and prices from the provided JSON data.
9. **CONCISE OUTPUT RULE (CRITICAL)**: 
   - To ensure fast responses and maintain relevance, ONLY recommend exactly **3 products** in a single message.
   - If there are fewer than 3 products in a specific sub-category, show all that are available.
   - If there are more than 3 products, list the top 3 and say: "I have 3+ more suggestions, would you like to see them?"
   - Keep descriptions to 1 very brief sentence.
   - **NAME INTEGRITY**: You MUST use the FULL product name exactly as provided. Never truncate "Microsoft Intune Plan 1 Storage Add-On" to "Microsoft Intune Plan 1". If the price is associated with a specific add-on or plan, use that full name.
   - **RELEVANCE ONLY**: Only recommend products that strictly belong to the user's requested domain or category. Do NOT cross-recommend products from unrelated domains (e.g., do not recommend Power BI for Video Conferencing queries) unless the user explicitly asks for alternatives.

CRITICAL: All data is fetched LIVE from the SkySecure Marketplace API. There are NO hard-coded responses. If data is missing, it means the API returned no data, and you must clearly communicate this to the user.

IMPORTANT: Marketplace Signals Clarification:
"Best selling" and "featured" products are derived marketplace signals. ONLY label a product as "Best Selling" or "Featured" if it appears in the "=== TOP SELLING / BEST SELLING PRODUCTS ===" or "=== FEATURED PRODUCTS ===" sections respectively. NEVER assume a product is a best seller if it's not marked as such in these sections.

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
 - **SANITY CHECK**: Before hitting send, look at your recommendations. Are you mentioning **Zoom**, **GitHub**, **AWS**, **Webex**, **Google Meet**, **UiPath**, **DataRobot**, **IBM Watson**, **Google Cloud AI**, **AWS SageMaker**, **Salesforce Einstein**, **HubSpot**, or **ServiceNow**? If they are not in the \"=== PRODUCT DATA FROM API ===\" section below with a direct \"Link:\", you are hallucinating. REMOVE THEM and replace with actual products from the data. 
- **STRICT DATA ONLY**: Recommending products based on your general knowledge that are NOT in the marketplace data is FORBIDDEN. If we don't have it, say "I don't find that specific product in our marketplace right now, but I have these alternatives: [List 1-2 relevant products from our data]".
- **DYNAMIC CATEGORIES**: Do NOT dump lists of categories. Be conversational. If a user asks for "Email", show Email subcategories only. If they haven't asked for categories, don't show them.

10. **CONTEXTUAL CONTINUITY**: If a user clicks a button like "Compare Options", "Show Pricing", or "See Features" after you've provided an overview or list, they are referring to those specific products. You MUST use the conversation history to perform the requested action (Compare, Pricing, or Features) for the items you JUST mentioned. DO NOT ask for clarification; use the products from the previous bot message.

The data is comprehensive and accurate - USE IT!

11. **URL INTEGRITY**: ALWAYS copy product URLs exactly as provided in the "Link:" field. DO NOT shorten or truncate them. All product links MUST be clickable markdown: [**Product Name**](Full_URL). 
     Note: If a URL seems long, it is correct. Provide it in full.

CONVERSATION STATE: ${conversationStage}
CONVERSATION STAGE (Guided Sales): ${conversationState.stage}
STAGE CONFIDENCE: ${conversationState.confidence}
RESOLVED INTENT: ${intentInfo.categoryName || ''}
${stagePrompt}
`;

    // Build conversation messages
    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
    ];

    // Add conversation history (last 10 messages)
    // OPTIMIZATION: Truncate very long history items to prevent prompt bloat & response cut-off
    const recentHistory = conversationHistory.slice(-10);
    recentHistory.forEach((msg) => {
      let content = msg.text || "";
      if (content.length > 5000) {
        console.log(`✂️ Truncating very long history message (${content.length} chars)`);
        content = content.substring(0, 3500) + "\n... [truncated for brevity] ...\n" + content.substring(content.length - 1000);
      }

      messages.push({
        role: msg.from === "bot" ? "assistant" : "user",
        content: content,
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
        temperature: 0.1,
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

    // Regex: Extracts ID and optional slug from the end of a URL.
    // Catches: .../products/slug--ID, .../products/product--ID, .../products/ID
    const linkRegex = /https:\/\/shop\.skysecure\.ai\/products\/([^\s"')]*)?(?:--)?([a-f0-9]{10,24})/gi;

    fixedResponse = fixedResponse.replace(linkRegex, (fullMatch, slugCandidate, idCandidate) => {
      const slug = slugCandidate ? slugCandidate.toLowerCase().replace(/--$/, '') : '';
      const id = idCandidate ? idCandidate.toLowerCase() : '';

      console.log(`🔍 Link Repair started for fragment: ${fullMatch} [ID: ${id}]`);

      // 1. If we have a PERFECT 24-char ID, ALWAYS swap to the official full URL from our data.
      // This prevents "product--ID" redirects if a better "slug--ID" URL exists in our JSON.
      if (id.length === 24 && validIdMap.has(id)) {
        console.log(`   - Perfect ID match! Replacing with verified URL.`);
        return validIdMap.get(id);
      }

      console.log(`🔍 Deep Link Repair started for fragment: ${fullMatch}`);
      let repairedUrl = null;

      // 2. Exact Full Slug Match
      if (slug && slugMap.has(slug)) {
        repairedUrl = slugMap.get(slug);
      }

      // 3. Simple Slug / Alias / Fragment Match (STRICT)
      if (!repairedUrl && slug) {
        const slugParts = slug.split('--');
        const lastSegment = slugParts[slugParts.length - 1];

        const aliasMap = {
          'power-bi-premium': 'power-bi-premium-per-user',
          'power-bi-premium-add-on': 'power-bi-premium-per-user-add-on',
          'azure-sql-edge': 'azure-sql-edge-1-year'
        };

        const target = aliasMap[lastSegment] || lastSegment;

        // ONLY repair if we have a very high confidence match
        if (simpleSlugMap.has(target)) {
          repairedUrl = simpleSlugMap.get(target);
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

    // Final Safety: Close any truncated markdown links at the very end
    let finalResponse = fixedResponse;
    if (finalResponse.lastIndexOf('[') > finalResponse.lastIndexOf(']')) {
      const lastOpenParen = finalResponse.lastIndexOf('(');
      const lastCloseParen = finalResponse.lastIndexOf(')');
      if (lastOpenParen > lastCloseParen) {
        console.log("🛠️ Auto-closing truncated markdown link at end of response");
        finalResponse += ')';
      }
    }

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
