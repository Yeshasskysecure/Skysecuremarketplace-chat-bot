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
import { indexContent, getRelevantContent, needsUpdate } from "./utils/embeddingService.js";
import { trackConversationState, getStagePrompt, generateGuidingQuestion, suggestQuickReplies } from "./utils/conversationManager.js";

dotenv.config();

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

    // Fetch website content with timeout - use cached/scraped content
    const baseUrl = process.env.KNOWLEDGE_BASE_URL || "https://shop.skysecure.ai/";
    let combinedWebsiteContent = "";
    let relevantContent = "";
    
    // DYNAMIC: resolveIntent is now async - await it
    const intentInfo = await resolveIntent(message, baseUrl);
    const conversationStage = inferConversationStage(conversationHistory, message, intentInfo);

    // Track conversation state using new conversation manager
    const conversationState = trackConversationState(conversationHistory, message, intentInfo);
    console.log(`Conversation state: Stage=${conversationState.stage}, Confidence=${conversationState.confidence}`);
    const stagePrompt = getStagePrompt(conversationState.stage, conversationState.context);
    const quickReplies = suggestQuickReplies(conversationState.stage, intentInfo);

    try {
      // Try to get comprehensive content (may be cached)
      console.log("Fetching website content...");
      const comprehensiveWebsiteContent = await Promise.race([
        scrapeEntireWebsite(baseUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Scrape timeout")), 30000)) // 30s timeout
      ]).catch(err => {
        console.warn("Comprehensive scrape timed out or failed, using fallback:", err.message);
        return "";
      });

      // Get specific pages (faster)
      const specificPagesContent = await Promise.race([
        scrapeAllPages(baseUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Scrape timeout")), 15000)) // 15s timeout
      ]).catch(err => {
        console.warn("Specific pages scrape timed out:", err.message);
        return "";
      });

      combinedWebsiteContent = (comprehensiveWebsiteContent || "") + "\n\n" + (specificPagesContent || "");
      console.log(`Combined website content length: ${combinedWebsiteContent.length} characters`);

      // Embedding indexing RE-ENABLED with optimizations
      // Index content only if cache needs update (1 hour TTL)
      if (combinedWebsiteContent && needsUpdate()) {
        console.log("Indexing website content with embeddings (cache expired)...");
        await Promise.race([
          indexContent(combinedWebsiteContent),
          new Promise((resolve) => setTimeout(() => resolve(), 10000)) // 10s timeout for indexing
        ]).catch(err => {
          console.warn("Indexing failed, continuing without semantic search:", err.message);
        });
      } else if (combinedWebsiteContent) {
        console.log("Using cached embeddings (no re-indexing needed)");
      }

      // Get relevant content using semantic search (with timeout)
      if (combinedWebsiteContent) {
        console.log("Finding relevant content using semantic search...");
        relevantContent = await Promise.race([
          getRelevantContent(message, 5), // Reduced to 5 chunks for performance
          new Promise((resolve) => setTimeout(() => resolve(""), 5000)) // 5s timeout
        ]).catch(err => {
          console.warn("Semantic search failed:", err.message);
          return "";
        });
        console.log(`Semantic search returned ${relevantContent.length} characters of relevant content`);
      }
    } catch (error) {
      console.error("Error fetching website content:", error.message);
      console.error("Error stack:", error.stack);
      // Ensure combinedWebsiteContent is always a string
      combinedWebsiteContent = combinedWebsiteContent || "";
      // Continue with product data even if website scraping fails
    }

    // Fetch real product data from API (pass website content for fallback matching)
    console.log("Fetching product data from API...");
    let products = [];
    let productFetchError = null;

    try {
      // Ensure combinedWebsiteContent is a string before passing
      const websiteContentForProducts = typeof combinedWebsiteContent === 'string' ? combinedWebsiteContent : "";
      console.log(`Passing website content to product fetcher: ${websiteContentForProducts.length} characters`);

      // Pass website content to product fetcher for fallback matching
      // Increased timeout to 90 seconds to allow all API calls to complete
      products = await Promise.race([
        fetchAllProducts(websiteContentForProducts, intentInfo),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Product API timeout")), 90000)) // 90s timeout
      ]);
    } catch (error) {
      console.error("Error fetching products:", error.message);
      console.error("Error stack:", error.stack);
      productFetchError = error.message;
      products = []; // Ensure products is an array
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

    // Fetch category hierarchy and OEMs
    console.log("Fetching category hierarchy and OEMs...");
    let categoryHierarchy = "";
    try {
      const categoryData = await Promise.race([
        fetchCategoryHierarchy(),
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

    // NOTE: productKnowledgeBase will be created AFTER scraping to include scraped products
    let listingProductsSection = "";
    
    // CRITICAL: HTML/DOM is PRIMARY source of truth - Always scrape listing pages
    try {
      const urlsToScrape = [];
      
      // Always include intent-based URLs
      if (intentInfo && intentInfo.listingUrls && intentInfo.listingUrls.length > 0) {
        urlsToScrape.push(...intentInfo.listingUrls);
      }
      
      // If SQL/Data Management is detected, scrape that page
      if (intentInfo && intentInfo.categoryName === "Data Management") {
        const dataMgmtUrl = `https://shop.skysecure.ai/products?subCategoryId=${intentInfo.subCategoryId}&subCategory=Data-Management`;
        if (!urlsToScrape.includes(dataMgmtUrl)) {
          urlsToScrape.push(dataMgmtUrl);
        }
        console.log(`🔍 Scraping Data Management page for SQL products: ${dataMgmtUrl}`);
      }
      
      // CRITICAL: Always scrape main products page to find ALL products (including SQL)
      // This ensures we don't miss products that might not be in specific category pages
      const mainProductsUrl = 'https://shop.skysecure.ai/products';
      if (!urlsToScrape.includes(mainProductsUrl)) {
        urlsToScrape.push(mainProductsUrl);
        console.log(`🔍 Always scraping main products page: ${mainProductsUrl}`);
      }
      
      // Also scrape homepage which might have featured products
      const homepageUrl = 'https://shop.skysecure.ai/';
      if (!urlsToScrape.includes(homepageUrl)) {
        urlsToScrape.push(homepageUrl);
        console.log(`🔍 Also scraping homepage for featured products: ${homepageUrl}`);
      }
      
      console.log(`\n${'='.repeat(80)}`);
      console.log(`🌐 SCRAPING LISTING PAGES (PRIMARY SOURCE OF TRUTH)`);
      console.log(`${'='.repeat(80)}`);
      console.log(`URLs to scrape: ${urlsToScrape.length}`);
      urlsToScrape.forEach((url, idx) => {
        console.log(`  ${idx + 1}. ${url}`);
      });
      console.log(`${'='.repeat(80)}\n`);
      
      if (urlsToScrape.length > 0) {
        const scrapedListing = await scrapeListingProducts(urlsToScrape);
        
        if (scrapedListing.length > 0) {
          listingProductsSection += `\n=== PRODUCTS FROM LISTING PAGES (${scrapedListing.length} products) ===\n`;
          listingProductsSection += `⚠️  CRITICAL: These products were scraped DIRECTLY from the website HTML/DOM.\n`;
          listingProductsSection += `This is the PRIMARY source of truth. If API returns 0 products but this section has products, USE THESE PRODUCTS.\n\n`;
          
          scrapedListing.forEach((p, i) => {
            listingProductsSection += `${i + 1}. **${p.name}**\n`;
            listingProductsSection += `   ${p.name}\n`; // Duplicate for search results format
            if (p.vendor && p.vendor !== 'Unknown Vendor') {
              listingProductsSection += `   Vendor: ${p.vendor}\n`;
            }
            if (p.price && p.price > 0) {
              const formattedPrice = typeof p.price === 'number' ? 
                p.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 
                p.price;
              listingProductsSection += `   Price: ₹${formattedPrice}${p.billingCycle ? ` / ${p.billingCycle}` : ''}\n`;
            }
            if (p.description) {
              listingProductsSection += `   Description: ${p.description.substring(0, 150)}...\n`;
            }
            if (p.url) {
              listingProductsSection += `   Link: ${p.url}\n`;
            }
            listingProductsSection += `\n`;
          });
          listingProductsSection += `=== END PRODUCTS FROM LISTING PAGES ===\n`;
          console.log(`✅ Scraped ${scrapedListing.length} products from listing pages (PRIMARY SOURCE)`);
          
          // CRITICAL: Add scraped products to main products array (they take priority)
          scrapedListing.forEach(scrapedProduct => {
            if (!scrapedProduct.name) return;
            
            const existingIndex = products.findIndex(p => 
              p.name && scrapedProduct.name && 
              p.name.toLowerCase().trim() === scrapedProduct.name.toLowerCase().trim()
            );
            
            if (existingIndex >= 0) {
              // Update existing product with scraped data (scraped data is more reliable)
              products[existingIndex] = {
                ...products[existingIndex],
                name: scrapedProduct.name,
                vendor: scrapedProduct.vendor || products[existingIndex].vendor,
                price: scrapedProduct.price > 0 ? scrapedProduct.price : products[existingIndex].price,
                billingCycle: scrapedProduct.billingCycle || products[existingIndex].billingCycle,
                description: scrapedProduct.description || products[existingIndex].description,
                productUrl: scrapedProduct.url || products[existingIndex].productUrl,
                source: 'SCRAPED_FROM_HTML' // Mark as scraped
              };
            } else {
              // Add new product from scraping
              products.push({
                id: `scraped-${Buffer.from(scrapedProduct.name).toString('base64').substring(0, 20)}`,
                name: scrapedProduct.name,
                vendor: scrapedProduct.vendor || 'Unknown Vendor',
                price: scrapedProduct.price || 0,
                billingCycle: scrapedProduct.billingCycle || 'Monthly',
                category: intentInfo?.categoryName || 'Software',
                subCategory: intentInfo?.categoryName || 'General',
                description: scrapedProduct.description || '',
                isFeatured: false,
                isTopSelling: false,
                isLatest: false,
                productUrl: scrapedProduct.url || '',
                source: 'SCRAPED_FROM_HTML' // Mark as scraped
              });
            }
          });
          
          console.log(`✅ Merged ${scrapedListing.length} scraped products into main list (Total: ${products.length})`);
          
          // CRITICAL: Check if any scraped products are SQL-related
          const scrapedSqlProducts = scrapedListing.filter(p => {
            const name = (p.name || '').toLowerCase();
            const desc = (p.description || '').toLowerCase();
            return name.includes('sql') || name.includes('database') || name.includes('server') ||
                   desc.includes('sql') || desc.includes('database') || desc.includes('server') ||
                   name.includes('microsoft sql') || name.includes('sql server');
          });
          
          if (scrapedSqlProducts.length > 0) {
            console.log(`\n🔍 CRITICAL: Found ${scrapedSqlProducts.length} SQL products in SCRAPED data:`);
            scrapedSqlProducts.forEach((p, idx) => {
              console.log(`   ${idx + 1}. ${p.name} (${p.vendor}) - ₹${p.price}/${p.billingCycle}`);
            });
            console.log(`   These products are now in the main products array and will be included in SQL PRODUCTS section.\n`);
          }
        } else {
          console.warn(`⚠️  WARNING: No products scraped from listing pages: ${urlsToScrape.join(', ')}`);
          console.warn(`   This may indicate:`);
          console.warn(`   1. Website structure changed`);
          console.warn(`   2. Products load via JavaScript that needs execution`);
          console.warn(`   3. Selectors need updating`);
          console.warn(`   4. Website requires authentication`);
        }
      }
    } catch (error) {
      console.error(`❌ Error scraping listing pages: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
      // Continue even if scraping fails - API products might still be available
    }
    
    // Re-format knowledge base AFTER merging scraped products to ensure SQL products section includes scraped ones
    const productKnowledgeBase = formatProductsForKnowledgeBase(products);
    console.log(`Product knowledge base created: ${productKnowledgeBase.length} characters`);

    // Build system prompt with knowledge base
    const systemPrompt = `You are a helpful, friendly, and visually-oriented virtual assistant for SkySecure Marketplace, similar to Amazon's Rufus. Your role is to help customers with questions about products, services, pricing, and general inquiries.

IMPORTANT: Format all responses in a visually appealing way using markdown. Use clear headings, bullet points, tables, bold text, and proper spacing to make responses easy to read and engaging.

⚠️  CRITICAL DATA SOURCE RULES - PRIMARY SOURCE OF TRUTH: HTML/DOM ⚠️

The website https://shop.skysecure.ai IS a product marketplace. Products DO EXIST and MUST be discovered.

MANDATORY DATA FETCH RULES (PRIORITY ORDER):
1. **PRIMARY SOURCE**: "PRODUCTS FROM LISTING PAGES" section - These are scraped DIRECTLY from HTML/DOM
   - This section takes HIGHEST PRIORITY
   - If this section has products, they EXIST regardless of API status
   - These products were extracted from the actual website HTML
2. **SECONDARY SOURCE**: API product data (SQL PRODUCTS, DATA MANAGEMENT PRODUCTS sections)
3. DO NOT rely on category counters shown on landing pages or main category pages
4. ALWAYS check products from filtered product listing URLs using:
   - subCategoryId (e.g., /products?subCategoryId=*&subCategory=Data-Management)
   - oemId (e.g., /products?oemId=*)
   - sort parameters (e.g., /products?sort=*)
5. A category is considered empty ONLY if:
   - Scraped HTML from listing pages shows zero products
   - AND no product cards, links, or references found in DOM
   - AND API also returns zero products
6. API failures, embedding failures, or timeouts MUST NEVER be used to say "no products exist"
7. If products appear in "PRODUCTS FROM LISTING PAGES", they EXIST and MUST be listed
8. DO NOT assume, infer, or hallucinate products - but DO trust scraped HTML content

PRODUCT PAGES TO TRAVERSE:
- /products?subCategoryId=* (for subcategories)
- /products?oemId=* (for OEM/vendor products)
- /products?sort=* (for sorted product lists)

BEHAVIOR RULES:
1. PRIORITY ORDER for product data:
   a) "PRODUCTS FROM LISTING PAGES" section (scraped from HTML - HIGHEST PRIORITY)
   b) "SQL PRODUCTS" section (from API)
   c) "DATA MANAGEMENT PRODUCTS" section (from API)
   d) General product listings (from API)
2. If products appear in "PRODUCTS FROM LISTING PAGES", they EXIST and MUST be listed
3. If products exist on listing pages (scraped HTML), LIST THEM, even if API shows 0 products
4. Say "No products found" ONLY if:
   - Scraped HTML from listing pages shows zero products
   - AND no product cards, links, or references found in DOM
   - AND API also returns zero products
5. If a user asks about a specific category (e.g., Data Management), check:
   - First: "PRODUCTS FROM LISTING PAGES" section
   - Then: Category-specific sections in knowledge base
6. Match the website structure exactly (Categories → Subcategories → Products)
7. Show product name, vendor, pricing model, and license duration from scraped or API data
8. Keep responses concise, factual, and aligned with the live marketplace data
9. DO NOT add external explanations, recommendations, or examples unless explicitly asked
10. ALWAYS prioritize scraped HTML content over API data when there's a conflict
11. TRUST THE UI - if products appear in scraped HTML, they exist regardless of API status

RESPONSE FORMAT:
When listing products, always include:
- Product Name (bold)
- Vendor
- Price / License (if shown in the data)
- Category (if relevant)

EXAMPLE BEHAVIOR:
- User asks: "What products are in Data Management?"
  → Action: Check the data below for products from /products?subCategoryId=68931f337874310ffca28e96&subCategory=Data-Management
  → If products are listed in the data, respond with the listed products
  → If no products are found in the data, respond: "No products found in the Data Management category on SkySecure Marketplace."
  → DO NOT assume or infer products that are not in the data

CRITICAL: You have access to:

1. REAL, LIVE product data from the SkySecure API with actual names, prices, categories, vendors, descriptions
2. COMPREHENSIVE website content scraped from ALL pages of https://shop.skysecure.ai/ (all pages crawled)
3. Complete product information, descriptions, features, pricing, categories, and all website content

You MUST use this comprehensive data to answer ALL questions accurately. The website has been fully crawled and you have access to all the content. DO NOT make up or assume any information that is not in the data provided below.

CONVERSATION STATE: ${conversationStage}
CONVERSATION STAGE (Guided Sales): ${conversationState.stage}
STAGE CONFIDENCE: ${conversationState.confidence}
RESOLVED INTENT: ${intentInfo.categoryName || ''} ${intentInfo.subCategoryId ? `(subCategoryId=${intentInfo.subCategoryId})` : ''} ${intentInfo.oemId ? `(oemId=${intentInfo.oemId})` : ''}
LISTING URLS: ${(intentInfo.listingUrls || []).join(', ')}

${stagePrompt}

COMPLETE WEBSITE CONTENT (crawled from ALL pages of https://shop.skysecure.ai/):
${combinedWebsiteContent}

${relevantContent ? `SEMANTIC SEARCH RESULTS (Most relevant content for this query):
${relevantContent}
` : ''}

=== MARKETPLACE CATEGORY HIERARCHY AND OEMs ===
${categoryHierarchy}
=== END CATEGORY HIERARCHY ===

=== PRODUCT DATA FROM API ===
${productKnowledgeBase}
=== END PRODUCT DATA ===

 ${listingProductsSection}

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
  1. **FIRST**: Check "=== PRODUCTS FROM LISTING PAGES ===" section - These are scraped DIRECTLY from HTML/DOM
     - This is the PRIMARY source of truth
     - If products are here, they EXIST on the website
     - Filter for products with "SQL" in the name
  2. **SECOND**: Check "=== SQL PRODUCTS ===" section (from API)
  3. **THIRD**: Check "=== DATA MANAGEMENT PRODUCTS ===" section (from API)
  
  If ANY of these sections show products, you MUST:
  * Create a "### Search Results" section
  * List ALL SQL products found with format:
    **Product Name**
    Product Name
    ₹Price / BillingCycle
  * Include ALL products from ALL sections that contain SQL products
  * DO NOT say "no products" if ANY section shows products
  * If "PRODUCTS FROM LISTING PAGES" has products, prioritize those (they're from HTML)
  * Example format:
    **SQL Server Standard 2022- 2 Core License Pack - 1 year**
    SQL Server Standard 2022- 2 Core License Pack - 1 year
    ₹139,289.92 / Yearly
  
  CRITICAL: If "PRODUCTS FROM LISTING PAGES" section exists and has products, those products EXIST on the website
  regardless of what the API returns. NEVER say "no products" if scraped HTML shows products.

GENERAL INSTRUCTIONS:
1. ALWAYS check the product data sections FIRST before saying something doesn't exist - specifically check filtered product listing URLs (subCategoryId, oemId) in the website content
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

ABSOLUTE GUARDRAILS:
1. NEVER say "no products found" unless BOTH sources are empty: API products for the target scope AND scraped listing pages for the relevant subCategoryId/oemId return zero product cards.
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
  1. "=== PRODUCTS FROM LISTING PAGES ===" section FIRST (most reliable - scraped from actual website)
  2. "=== SQL PRODUCTS ===" section (from API)
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
   - Example row: | 1 | **Product Name** | Microsoft | ₹12,345.67/Monthly | Software | Brief description... |
   - Horizontal rule: ---
   - Highlights section: ### 🎯 Highlights with bullet points for most affordable, most popular, key categories, and total products
   - Friendly closing line with emoji

11. **SPECIAL FORMAT FOR SQL PRODUCTS:**
   When user asks "what are the SQL products being sold" or similar:
   - Start with: ## 📦 SQL Products in SkySecure Marketplace
   - Add brief intro: "Here are all the SQL products available:"
   - Create a "### Search Results" section
   - For EACH SQL product, use this EXACT format:
     **Product Name**
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

    // Limit system prompt size to avoid token limits and timeouts
    // Truncate website content if it's too large (reduce to 8k to prevent timeouts)
    const maxWebsiteContentLength = 8000; // Reduced to 8k chars to prevent timeouts
    const truncatedWebsiteContent = combinedWebsiteContent.length > maxWebsiteContentLength
      ? combinedWebsiteContent.substring(0, maxWebsiteContentLength) + "\n\n[Website content truncated for performance - most relevant sections included]"
      : combinedWebsiteContent;

    // Update system prompt with truncated content
    const optimizedSystemPrompt = systemPrompt.replace(
      combinedWebsiteContent,
      truncatedWebsiteContent
    );

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
