// import { makeRequest } from "./httpClient.js";
// import { extractBestSellingProductsFromWebsite, extractRecentlyAddedProductsFromWebsite, matchProductsByName } from "./productMatcher.js";
// import { scrapeListingProducts } from "./websiteScraper.js";

// Cache for product data (refresh every 5 minutes)
let productCache = {
  data: null,
  lastFetch: null,
  ttl: 5 * 60 * 1000, // 5 minutes
};

// Cache for formatted knowledge base
let kbCache = {
  base: null, // Basic version (categories, featured, top selling, recent)
  full: null, // Full version (includes all products list)
  lastUpdate: null
};

const PRODUCT_SERVICE_BACKEND_URL = process.env.PRODUCT_SERVICE_BACKEND_URL ||
  process.env.NEXT_PUBLIC_PRODUCT_SERVICE_BACKEND_URL ||
  "https://devshop-backend.skysecure.ai/api/product";


/**
 * Helper to format price details from product
 */
function formatPriceDetails(product) {
  let details = [];

  // 1. Check for subscriptions array (from API)
  if (product.subscriptions && product.subscriptions.length > 0) {
    product.subscriptions.forEach(sub => {
      const price = sub.sellingPrice || sub.price || 0;
      const plan = sub.plan || "Monthly";
      const formattedPrice = price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      details.push(`₹${formattedPrice}/${plan}`);
    });
  }
  // 2. Check for pricing object (from JSON)
  else if (product.pricing && Object.keys(product.pricing).length > 0) {
    if (product.pricing.monthly) {
      const formattedPrice = product.pricing.monthly.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      details.push(`₹${formattedPrice}/Monthly`);
    }
    if (product.pricing.yearly) {
      const formattedPrice = product.pricing.yearly.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      details.push(`₹${formattedPrice}/Yearly`);
    }

    // Check for explicit triennial or oneTime with a "3 Year" context
    const isTriennial = product.pricing.triennial ||
      (product.pricing.oneTime &&
        ((product.name && product.name.toLowerCase().includes("3 year")) ||
          (product.subscriptionHint && product.subscriptionHint.toLowerCase().includes("3 year")) ||
          (product.raw && product.raw.subscriptionHint && product.raw.subscriptionHint.toLowerCase().includes("3 year")) ||
          (product.billingCycle && product.billingCycle.toLowerCase().includes("3 year"))));

    if (product.pricing.triennial) {
      const formattedPrice = product.pricing.triennial.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      details.push(`₹${formattedPrice}/3 Years`);
    } else if (isTriennial && product.pricing.oneTime) {
      const formattedPrice = product.pricing.oneTime.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      details.push(`₹${formattedPrice}/3 Years`);
    } else if (product.pricing.oneTime) {
      const formattedPrice = product.pricing.oneTime.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      details.push(`₹${formattedPrice}/One Time`);
    }
  }

  // 3. Fallback to product-level price/billingCycle
  if (details.length === 0) {
    const price = product.price || 0;
    const cycle = product.billingCycle || "Monthly";
    const formattedPrice = price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `₹${formattedPrice}/${cycle}`;
  }

  return details.join(" | ");
}

/**
 * Formats product data into a knowledge base string
 * @param {Array} products - Array of product objects
 * @param {boolean} includeFullList - Whether to include the ALL PRODUCTS LIST section (expensive!)
 * @returns {string} - Formatted product knowledge base
 */
export function formatProductsForKnowledgeBase(products, includeFullList = false) {
  if (!products || products.length === 0) {
    return "No product information available at this time. Unable to fetch live marketplace data from the API.";
  }

  // Check cache first
  const cacheKey = includeFullList ? 'full' : 'base';
  if (kbCache[cacheKey] && kbCache.lastUpdate && (Date.now() - kbCache.lastUpdate < productCache.ttl)) {
    console.log(`Using cached ${cacheKey} knowledge base`);
    return kbCache[cacheKey];
  }
  if (!products || products.length === 0) {
    return "No product information available at this time. Unable to fetch live marketplace data from the API.";
  }

  let knowledgeBase = `\n\n=== SKYSECURE MARKETPLACE PRODUCTS ===\n\n`;
  knowledgeBase += `Total Products Available: ${products.length}\n\n`;

  // Group by category
  const byCategory = {};
  const bySubCategory = {};

  products.forEach((product) => {
    const category = product.category || "Uncategorized";
    const subCategory = product.subCategory || "General";

    if (!byCategory[category]) {
      byCategory[category] = [];
    }
    byCategory[category].push(product);

    if (!bySubCategory[subCategory]) {
      bySubCategory[subCategory] = [];
    }
    bySubCategory[subCategory].push(product);
  });

  // Add simple category breakdown (will be enhanced by category hierarchy)
  knowledgeBase += `=== MARKETPLACE CATEGORIES (Simple List) ===\n`;
  const categoryEntries = Object.entries(byCategory).sort((a, b) => b[1].length - a[1].length);
  categoryEntries.forEach(([category, categoryProducts]) => {
    knowledgeBase += `- ${category}: ${categoryProducts.length} products\n`;
  });
  knowledgeBase += `=== END SIMPLE CATEGORIES ===\n\n`;
  knowledgeBase += `NOTE: For detailed category hierarchy with sub-categories and sub-sub-categories, see the "MARKETPLACE CATEGORY HIERARCHY" section below.\n\n`;

  // Add detailed subcategory breakdown (especially Cloud Services)
  Object.keys(bySubCategory).forEach((subCat) => {
    if (subCat && subCat !== "General" && bySubCategory[subCat].length > 0) {
      const subCatProducts = bySubCategory[subCat];
      knowledgeBase += `${subCat.toUpperCase()} PRODUCTS (${subCatProducts.length} products):\n`;
      subCatProducts
        .sort((a, b) => (b.price || 0) - (a.price || 0)) // Sort by price descending
        .slice(0, 5)
        .forEach((product) => {
          knowledgeBase += `  - ${product.name} (${product.vendor}): ${formatPriceDetails(product)}\n`;
          if (product.url) knowledgeBase += `    Link: ${product.url}\n`;
        });
      if (subCatProducts.length > 5) {
        knowledgeBase += `    ... and ${subCatProducts.length - 5} more products in ${subCat}\n`;
      }
      knowledgeBase += `\n`;
    }
  });

  // DYNAMIC SEARCH SECTIONS: Add explicit sections for common searches
  // Enhanced SQL product detection - more flexible matching
  const sqlProducts = products.filter(p => {
    const name = (p.name || '').toLowerCase();
    const desc = (p.description || '').toLowerCase();
    const subCat = (p.subCategory || '').toLowerCase();
    const category = (p.category || '').toLowerCase();

    // Check for SQL keywords in various forms
    const sqlKeywords = ['sql', 'database', 'db', 'data management', 'data management', 'server'];
    const hasSqlKeyword = sqlKeywords.some(keyword =>
      name.includes(keyword) ||
      desc.includes(keyword) ||
      subCat.includes(keyword) ||
      category.includes(keyword)
    );

    // Exclude Power BI from SQL products to avoid confusion
    const isPowerBi = name.includes('power bi');
    if (isPowerBi) return false;

    // Also check if product is in Data Management subcategory
    const isDataManagement = subCat.includes('data management') ||
      subCat.includes('data-management') ||
      category.includes('data');

    return hasSqlKeyword || isDataManagement;
  });

  const powerBiProducts = products.filter(p => {
    const name = (p.name || '').toLowerCase();
    const desc = (p.description || '').toLowerCase();
    return name.includes('power bi');
  });

  const aiProducts = products.filter(p => {
    const name = (p.name || '').toLowerCase();
    const desc = (p.description || '').toLowerCase();
    const subCat = (p.subCategory || '').toLowerCase();
    const subSubCat = (p.subSubCategory || '').toLowerCase();
    return name.includes('copilot') ||
      name.includes('artificial intelligence') ||
      subCat.includes('artificial intelligence') ||
      subSubCat.includes('artificial intelligence') ||
      name.includes('defender threat intelligence');
  });

  const videoProducts = products.filter(p => {
    const name = (p.name || '').toLowerCase();
    const subCat = (p.subCategory || '').toLowerCase();
    return name.includes('teams') ||
      subCat.includes('video conferencing') ||
      name.includes('skype');
  });

  // Log SQL products found for debugging
  if (sqlProducts.length > 0) {
    console.log(`\n🔍 SQL PRODUCTS DETECTED: ${sqlProducts.length} products`);
    sqlProducts.forEach((p, idx) => {
      console.log(`   ${idx + 1}. ${p.name} (${p.vendor}) - Price: ₹${p.price}/${p.billingCycle}`);
    });
  } else {
    console.log(`\n⚠️  No SQL products detected in ${products.length} total products`);
    // Log sample product names to help debug
    if (products.length > 0) {
      console.log(`   Sample product names (first 10):`);
      products.slice(0, 10).forEach((p, idx) => {
        console.log(`   ${idx + 1}. ${p.name}`);
      });
    }
  }

  if (sqlProducts.length > 0) {
    knowledgeBase += `\n=== SQL PRODUCTS (${sqlProducts.length} products) ===\n`;
    knowledgeBase += `These are ALL SQL and database-related products in SkySecure Marketplace. When a user asks about SQL products, you MUST list ALL of these products with their full details:\n\n`;
    sqlProducts.slice(0, 10).forEach((product, index) => {
      knowledgeBase += `${index + 1}. **${product.name}**\n`;
      knowledgeBase += `   ${product.name}\n`; // Duplicate name for search results format
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      if (product.category) {
        const cat = product.category;
        const sub = (product.subCategory && product.subCategory !== product.category) ? product.subCategory : null;
        const subSub = (product.subSubCategory && product.subSubCategory !== product.subCategory && product.subSubCategory !== product.category) ? product.subSubCategory : null;
        let catDisplay = cat;
        if (sub) catDisplay += ` > ${sub}`;
        if (subSub) catDisplay += ` > ${subSub}`;
        knowledgeBase += `   Category: ${catDisplay}\n`;
      }
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) {
        knowledgeBase += `   Link: ${link}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 100)}\n`;
      }
      knowledgeBase += `\n`;
    });
    if (sqlProducts.length > 10) {
      knowledgeBase += `... and ${sqlProducts.length - 10} more SQL products\n\n`;
    }
    knowledgeBase += `=== END SQL PRODUCTS ===\n\n`;
    knowledgeBase += `CRITICAL: When a user asks "what are the SQL products" or "SQL products being sold", you MUST:\n`;
    knowledgeBase += `1. List ALL products from the "=== SQL PRODUCTS ===" section above\n`;
    knowledgeBase += `2. Include product name (duplicated for search results format), vendor, price, and billing cycle for EACH product\n`;
    knowledgeBase += `3. Format the response with a "### Search Results" section showing all SQL products\n`;
    knowledgeBase += `4. Use the exact format:\n`;
    knowledgeBase += `   **Product Name**\n`;
    knowledgeBase += `   Product Name\n`;
    knowledgeBase += `   ₹Price / BillingCycle\n`;
    knowledgeBase += `5. If a product has multiple price options, show the primary one (first subscription or product price)\n`;
    knowledgeBase += `6. DO NOT say "no products" if this section shows products - LIST THEM ALL\n\n`;
  }

  const emailCollabProducts = products.filter(p => {
    const name = (p.name || '').toLowerCase();
    const desc = (p.description || '').toLowerCase();
    const subCat = (p.subCategory || '').toLowerCase();
    return name.includes('email') || desc.includes('email') ||
      name.includes('exchange') || desc.includes('exchange') ||
      name.includes('outlook') || desc.includes('outlook') ||
      name.includes('teams') || desc.includes('teams') ||
      name.includes('sharepoint') || desc.includes('sharepoint') ||
      name.includes('onedrive') || desc.includes('onedrive') ||
      subCat.includes('collaboration') || subCat.includes('communication');
  });

  if (emailCollabProducts.length > 0) {
    knowledgeBase += `\n=== EMAIL & COLLABORATION PRODUCTS (${emailCollabProducts.length} products) ===\n`;
    knowledgeBase += `These are ALL Email and Collaboration Tools in SkySecure Marketplace:\n\n`;
    emailCollabProducts.slice(0, 10).forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) {
        knowledgeBase += `   Link: ${link}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 100)}\n`;
      }
      knowledgeBase += `\n`;
    });
    if (emailCollabProducts.length > 10) {
      knowledgeBase += `... and ${emailCollabProducts.length - 10} more email/collaboration products\n\n`;
    }
    knowledgeBase += `=== END EMAIL & COLLABORATION PRODUCTS ===\n\n`;
  }

  // Add Power BI products - CRITICAL SECTION
  if (powerBiProducts.length > 0) {
    knowledgeBase += `\n=== POWER BI PRODUCTS (${powerBiProducts.length} products) ===\n`;
    knowledgeBase += `These are ALL Power BI products in SkySecure Marketplace. DO NOT confuse these with Power Automate:\n\n`;
    powerBiProducts.forEach((product, index) => {
      knowledgeBase += `${index + 1}. **${product.name}**\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) {
        knowledgeBase += `   Link: ${link}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 100)}\n`;
      }
      knowledgeBase += `\n`;
    });
    knowledgeBase += `=== END POWER BI PRODUCTS ===\n\n`;
  }

  // Add Artificial Intelligence products - CRITICAL SECTION
  if (aiProducts.length > 0) {
    knowledgeBase += `\n=== ARTIFICIAL INTELLIGENCE (AI) SOLUTIONS (${aiProducts.length} products) ===\n`;
    knowledgeBase += `These are ALL AI-related products in SkySecure Marketplace. When a user asks about AI, list THESE products:\n\n`;
    aiProducts.slice(0, 10).forEach((product, index) => {
      knowledgeBase += `${index + 1}. **${product.name}**\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) knowledgeBase += `   Link: ${link}\n`;
      if (product.description) knowledgeBase += `   Description: ${product.description.substring(0, 100)}\n`;
      knowledgeBase += `\n`;
    });
    knowledgeBase += `=== END ARTIFICIAL INTELLIGENCE (AI) SOLUTIONS ===\n\n`;
  }

  // Add Video Conferencing products - CRITICAL SECTION
  if (videoProducts.length > 0) {
    knowledgeBase += `\n=== VIDEO CONFERENCING SOLUTIONS (${videoProducts.length} products) ===\n`;
    videoProducts.slice(0, 10).forEach((product, index) => {
      knowledgeBase += `${index + 1}. **${product.name}**\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) knowledgeBase += `   Link: ${link}\n`;
      if (product.description) knowledgeBase += `   Description: ${product.description.substring(0, 100)}\n`;
      knowledgeBase += `\n`;
    });
    knowledgeBase += `=== END VIDEO CONFERENCING SOLUTIONS ===\n\n`;
  }

  if (includeFullList) {
    // Add ALL products list (comprehensive)
    knowledgeBase += `\nALL PRODUCTS LIST:\n`;
    products.slice(0, 20).forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name} (${product.vendor})\n`;
      const cat = product.category;
      const sub = (product.subCategory && product.subCategory !== product.category) ? product.subCategory : null;
      const subSub = (product.subSubCategory && product.subSubCategory !== product.subCategory && product.subSubCategory !== product.category) ? product.subSubCategory : null;
      let catDisplay = cat || 'Uncategorized';
      if (sub) catDisplay += ` > ${sub}`;
      if (subSub) catDisplay += ` > ${subSub}`;
      knowledgeBase += `   Category: ${catDisplay}\n`;

      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) {
        knowledgeBase += `   Link: ${link}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 80)}...\n`;
      }
      knowledgeBase += `\n`;
    });
    if (products.length > 20) {
      knowledgeBase += `... and ${products.length - 20} more products\n\n`;
    }
  } else {
    // DISCOVERY FALLBACK: Even if full list is off, provide a sample to prevent hallucination
    knowledgeBase += `\n=== DISCOVERY SAMPLE (20 products) ===\n`;
    knowledgeBase += `Use these as general recommendations if no specific search results were found:\n\n`;
    products.slice(0, 20).forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) knowledgeBase += `   Link: ${link}\n`;
      if (product.description) knowledgeBase += `   Description: ${product.description.substring(0, 80)}...\n`;
      knowledgeBase += `\n`;
    });
    knowledgeBase += `=== END DISCOVERY SAMPLE ===\n\n`;
  }

  // Add featured products - CRITICAL SECTION
  const featured = products.filter((p) => p.isFeatured);
  if (featured.length > 0) {
    knowledgeBase += `\n=== FEATURED PRODUCTS (${featured.length} products) ===\n`;
    knowledgeBase += `These are the FEATURED products in SkySecure Marketplace:\n\n`;
    featured.slice(0, 5).forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) {
        knowledgeBase += `   Link: ${link}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 80)}...\n`;
      }
      knowledgeBase += `\n`;
    });
    if (featured.length > 5) {
      knowledgeBase += `... and ${featured.length - 5} more featured products\n\n`;
    }
    knowledgeBase += `=== END FEATURED PRODUCTS ===\n\n`;
  } else {
    knowledgeBase += `\n=== FEATURED PRODUCTS (0 products) ===\n`;
    knowledgeBase += `Note: No products are currently marked as "featured" in the system.\n`;
    knowledgeBase += `=== END FEATURED PRODUCTS ===\n\n`;
  }

  // Add top selling products - CRITICAL SECTION
  const topSelling = products.filter((p) => p.isTopSelling === true);
  console.log(`Formatting: Found ${topSelling.length} products with isTopSelling=true`);

  if (topSelling.length > 0) {
    knowledgeBase += `\n=== TOP SELLING / BEST SELLING PRODUCTS (${topSelling.length} products) ===\n`;
    knowledgeBase += `These are the BEST SELLING products in SkySecure Marketplace:\n\n`;
    topSelling.slice(0, 5).forEach((product, index) => { // Limit to 5 for token management
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) {
        knowledgeBase += `   Link: ${link}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 80)}...\n`;
      }
      knowledgeBase += `\n`;
    });
    if (topSelling.length > 5) {
      knowledgeBase += `... and ${topSelling.length - 5} more best selling products\n\n`;
    }
    knowledgeBase += `=== END BEST SELLING PRODUCTS ===\n\n`;
  } else {
    knowledgeBase += `\n=== TOP SELLING / BEST SELLING PRODUCTS (0 products) ===\n`;
    knowledgeBase += `Note: No products are currently marked as "best selling" in the system based on live data from the marketplace API.\n`;
    knowledgeBase += `=== END BEST SELLING PRODUCTS ===\n\n`;
  }

  // Add recently added products - CRITICAL SECTION
  const recentlyAdded = products.filter((p) => p.isLatest);
  if (recentlyAdded.length > 0) {
    // Sort by createdAt date (most recent first)
    const sortedRecentlyAdded = recentlyAdded.sort((a, b) => {
      if (!a.createdAtDate && !b.createdAtDate) return 0;
      if (!a.createdAtDate) return 1;
      if (!b.createdAtDate) return -1;
      return b.createdAtDate - a.createdAtDate;
    });

    knowledgeBase += `\n=== RECENTLY ADDED PRODUCTS (${sortedRecentlyAdded.length} products) ===\n`;
    knowledgeBase += `These are the RECENTLY ADDED products in SkySecure Marketplace:\n\n`;
    sortedRecentlyAdded.slice(0, 5).forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      const cat = product.category;
      const sub = (product.subCategory && product.subCategory !== product.category) ? product.subCategory : null;
      const subSub = (product.subSubCategory && product.subSubCategory !== product.subCategory && product.subSubCategory !== product.category) ? product.subSubCategory : null;
      let catDisplay = cat || 'Uncategorized';
      if (sub) catDisplay += ` > ${sub}`;
      if (subSub) catDisplay += ` > ${subSub}`;
      knowledgeBase += `   Category: ${catDisplay}\n`;

      const link = product.url || (product.id ? `https://shop.skysecure.ai/products/product--${product.id}` : null);
      if (link) {
        knowledgeBase += `   Link: ${link}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 80)}...\n`;
      }
      knowledgeBase += `\n`;
    });
    if (sortedRecentlyAdded.length > 5) {
      knowledgeBase += `... and ${sortedRecentlyAdded.length - 5} more recently added products\n\n`;
    }
    knowledgeBase += `=== END RECENTLY ADDED PRODUCTS ===\n\n`;

  } else {
    knowledgeBase += `\n=== RECENTLY ADDED PRODUCTS (0 products) ===\n`;
    knowledgeBase += `Note: No products are currently marked as "recently added" in the system based on live data from the marketplace.\n`;
    knowledgeBase += `=== END RECENTLY ADDED PRODUCTS ===\n\n`;
  }

  // Add most expensive products by category
  Object.keys(byCategory).forEach((category) => {
    const categoryProducts = byCategory[category];
    const sortedByPrice = categoryProducts
      .filter((p) => p.price > 0)
      .sort((a, b) => (b.price || 0) - (a.price || 0));

    if (sortedByPrice.length > 0) {
      const mostExpensive = sortedByPrice[0];
      knowledgeBase += `Most Expensive in ${category}: ${mostExpensive.name} - ${formatPriceDetails(mostExpensive)}\n`;
    }
  });

  knowledgeBase += `\n=== END PRODUCT DATA ===\n`;

  // Update cache
  kbCache[cacheKey] = knowledgeBase;
  kbCache.lastUpdate = Date.now();

  return knowledgeBase;
}
