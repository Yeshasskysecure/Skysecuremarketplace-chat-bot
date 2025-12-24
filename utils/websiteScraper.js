import { makeRequest } from "./httpClient.js";
import * as cheerio from "cheerio";
import { fetchCategoryHierarchy } from "./categoryFetcher.js";

// Cache for website content (refresh every 30 minutes)
let websiteCache = {
  data: null,
  lastFetch: null,
  ttl: 30 * 60 * 1000, // 30 minutes
};

// Cache for dynamic URLs (refresh every 10 minutes)
let dynamicUrlsCache = {
  urls: null,
  lastFetch: null,
  ttl: 10 * 60 * 1000, // 10 minutes
};

/**
 * Scrapes product listing pages for products
 * @param {Array<string>} urls - Array of listing URLs to scrape
 * @returns {Promise<Array>} - Array of scraped products with name, vendor, url
 */
/**
 * COMPREHENSIVE PRODUCT EXTRACTION - Treats HTML/DOM as PRIMARY source of truth
 * Extracts products from multiple sources: HTML elements, JSON scripts, data attributes
 */
export async function scrapeListingProducts(urls = []) {
  const products = [];
  const seenProducts = new Set(); // Track by name+vendor to avoid duplicates

  if (!urls || urls.length === 0) {
    return products;
  }

  for (const url of urls) {
    try {
      console.log(`🔍 Scraping listing page: ${url}`);
      const response = await makeRequest(url, { timeout: 15000 });

      if (!response.ok) {
        console.warn(`⚠️  Failed to scrape ${url}: ${response.status}`);
        continue;
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      
      console.log(`📄 HTML content length: ${html.length} characters`);

      // METHOD 1: Extract from JSON/script tags (React/Next.js apps) - PRIMARY METHOD
      let jsonProductsFound = 0;
      $('script').each((i, elem) => {
        const scriptContent = $(elem).html();
        if (!scriptContent || scriptContent.length < 50) return;
        
        try {
          // Try to parse as JSON
          const jsonData = JSON.parse(scriptContent);
          const jsonString = JSON.stringify(jsonData);
          
          // Look for product indicators
          if (jsonString.includes('product') || jsonString.includes('Product') || 
              jsonString.includes('docs') || jsonString.includes('items') ||
              jsonString.includes('name') || jsonString.includes('price') ||
              jsonString.includes('sellingPrice') || jsonString.includes('subscription')) {
            
            // Comprehensive recursive product finder
            function findProducts(obj, depth = 0, maxDepth = 10) {
              if (depth > maxDepth) return [];
              const results = [];
              
              if (Array.isArray(obj)) {
                obj.forEach((item) => {
                  if (item && typeof item === 'object') {
                    const name = item.name || item.title || item.productName || item.product?.name;
                    const vendor = item.vendor || item.oemDetails?.[0]?.title || item.brand || item.oem?.title || '';
                    const price = item.price || item.sellingPrice || item.subscriptions?.[0]?.sellingPrice || 
                                 item.subscription?.price || 0;
                    const billingCycle = item.billingCycle || item.plan || item.subscriptions?.[0]?.plan || 
                                       item.subscription?.plan || 'Monthly';
                    const productId = item._id || item.id || item.productId;
                    const description = item.description || item.overview || '';
                    
                    if (name && typeof name === 'string' && name.length > 3) {
                      const productKey = `${name.toLowerCase()}|${vendor.toLowerCase()}`;
                      if (!seenProducts.has(productKey)) {
                        seenProducts.add(productKey);
                        results.push({
                          name: name.trim(),
                          vendor: vendor || 'Unknown Vendor',
                          price: typeof price === 'number' ? price : (typeof price === 'string' ? parseFloat(price.replace(/[^0-9.]/g, '')) || 0 : 0),
                          billingCycle: billingCycle,
                          description: description,
                          url: item.url || item.link || (productId ? `https://shop.skysecure.ai/product/${productId}` : ''),
                          productId: productId || null,
                          category: item.category || item.categoryDetails?.[0]?.name || '',
                          subCategory: item.subCategory || item.subCategoryDetails?.[0]?.name || ''
                        });
                      }
                    }
                  }
                });
              } else if (obj && typeof obj === 'object') {
                // Check all keys for product-related data
                Object.keys(obj).forEach(key => {
                  const keyLower = key.toLowerCase();
                  if (keyLower.includes('product') || keyLower.includes('item') || 
                      keyLower.includes('doc') || key === 'data' || key === 'docs' ||
                      keyLower.includes('result') || keyLower.includes('list') ||
                      Array.isArray(obj[key])) {
                    const found = findProducts(obj[key], depth + 1, maxDepth);
                    results.push(...found);
                  }
                });
              }
              return results;
            }
            
            const foundProducts = findProducts(jsonData);
            if (foundProducts.length > 0) {
              jsonProductsFound += foundProducts.length;
              foundProducts.forEach(p => {
                const key = `${p.name.toLowerCase()}|${p.vendor.toLowerCase()}`;
                if (!seenProducts.has(key)) {
                  seenProducts.add(key);
                  products.push(p);
                }
              });
            }
          }
        } catch (e) {
          // Not valid JSON, but might contain product info in text
          if (scriptContent.includes('SQL') || scriptContent.includes('Server') || 
              scriptContent.includes('Database') || scriptContent.includes('product')) {
            // Try to extract product names from text
            const productNameMatches = scriptContent.match(/(?:name|title|productName)["\s:]+["']?([^"',\n}]{10,200})/gi);
            if (productNameMatches) {
              productNameMatches.forEach(match => {
                const name = match.replace(/(?:name|title|productName)["\s:]+["']?/i, '').replace(/["',\n}].*$/, '').trim();
                if (name && name.length > 5 && name.length < 200) {
                  const key = `${name.toLowerCase()}|unknown`;
                  if (!seenProducts.has(key)) {
                    seenProducts.add(key);
                    products.push({
                      name: name,
                      vendor: 'Unknown Vendor',
                      price: 0,
                      billingCycle: 'Monthly',
                      description: '',
                      url: ''
                    });
                  }
                }
              });
            }
          }
        }
      });
      
      if (jsonProductsFound > 0) {
        console.log(`✅ Found ${jsonProductsFound} products in JSON/script tags`);
      }

      // METHOD 2: Extract from HTML DOM elements - COMPREHENSIVE SELECTORS
      let htmlProductsFound = 0;
      
      // Multiple selector patterns to catch all product cards
      const productSelectors = [
        '[class*="product"]',
        '[class*="Product"]',
        '[class*="card"]',
        '[class*="Card"]',
        '[id*="product"]',
        '[id*="Product"]',
        '[data-product]',
        '[data-product-id]',
        'article',
        '[role="article"]',
        '[class*="item"]',
        '[class*="Item"]',
        'li[class*="product"]',
        'div[class*="product"]',
        '[class*="listing"]',
        '[class*="grid-item"]'
      ];
      
      productSelectors.forEach(selector => {
        $(selector).each((i, elem) => {
          try {
            // Extract product name from multiple possible locations
            const nameSelectors = [
              'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
              '[class*="name"]', '[class*="Name"]',
              '[class*="title"]', '[class*="Title"]',
              '[class*="heading"]', '[class*="Heading"]',
              '[data-name]', '[data-title]',
              'a[href*="product"]',
              'strong', 'b'
            ];
            
            let name = '';
            for (const nameSel of nameSelectors) {
              const found = $(elem).find(nameSel).first().text().trim();
              if (found && found.length > 5 && found.length < 200) {
                name = found;
                break;
              }
            }
            
            // If no name found in children, check the element itself
            if (!name || name.length < 5) {
              const elemText = $(elem).text().trim();
              // Try to extract first meaningful line as name
              const lines = elemText.split('\n').map(l => l.trim()).filter(l => l.length > 5 && l.length < 200);
              if (lines.length > 0) {
                name = lines[0];
              }
            }
            
            if (name && name.length > 5 && name.length < 200) {
              // Extract vendor/OEM
              const vendorSelectors = [
                '[class*="vendor"]', '[class*="Vendor"]',
                '[class*="oem"]', '[class*="OEM"]',
                '[class*="brand"]', '[class*="Brand"]',
                '[class*="manufacturer"]',
                '[data-vendor]', '[data-oem]'
              ];
              
              let vendor = '';
              for (const vendorSel of vendorSelectors) {
                const found = $(elem).find(vendorSel).first().text().trim();
                if (found && found.length > 0) {
                  vendor = found;
                  break;
                }
              }
              
              // Extract price
              const priceSelectors = [
                '[class*="price"]', '[class*="Price"]',
                '[class*="cost"]', '[class*="Cost"]',
                '[class*="amount"]', '[data-price]',
                '[class*="rupee"]', '[class*="₹"]'
              ];
              
              let priceText = '';
              let price = 0;
              for (const priceSel of priceSelectors) {
                const found = $(elem).find(priceSel).first().text().trim();
                if (found && found.length > 0) {
                  priceText = found;
                  // Extract numeric value
                  const priceMatch = found.match(/[\d,]+\.?\d*/);
                  if (priceMatch) {
                    price = parseFloat(priceMatch[0].replace(/,/g, '')) || 0;
                  }
                  break;
                }
              }
              
              // Extract billing cycle from price text
              let billingCycle = 'Monthly';
              if (priceText) {
                if (priceText.toLowerCase().includes('year') || priceText.toLowerCase().includes('annual')) {
                  billingCycle = 'Yearly';
                } else if (priceText.toLowerCase().includes('month')) {
                  billingCycle = 'Monthly';
                } else if (priceText.toLowerCase().includes('triennial')) {
                  billingCycle = 'Triennial';
                }
              }
              
              // Extract product URL
              let productUrl = '';
              const link = $(elem).find('a[href*="product"], a[href*="/product/"]').first();
              if (link.length > 0) {
                productUrl = link.attr('href') || '';
                if (productUrl && !productUrl.startsWith('http')) {
                  productUrl = `https://shop.skysecure.ai${productUrl.startsWith('/') ? '' : '/'}${productUrl}`;
                }
              } else {
                // Check if element itself is a link
                const elemLink = $(elem).closest('a').attr('href');
                if (elemLink) {
                  productUrl = elemLink.startsWith('http') ? elemLink : `https://shop.skysecure.ai${elemLink}`;
                }
              }
              
              // Extract description
              const descSelectors = [
                '[class*="description"]', '[class*="Description"]',
                '[class*="desc"]', '[class*="overview"]',
                'p', '[class*="summary"]'
              ];
              
              let description = '';
              for (const descSel of descSelectors) {
                const found = $(elem).find(descSel).first().text().trim();
                if (found && found.length > 10 && found.length < 500) {
                  description = found;
                  break;
                }
              }
              
              // Check for product indicators (Buy button, Add to cart, Compare, etc.)
              const hasProductIndicators = $(elem).find(
                '[class*="buy"], [class*="Buy"], button, [class*="button"], ' +
                '[class*="cart"], [class*="Cart"], [class*="compare"], ' +
                '[class*="add"], [aria-label*="buy"], [aria-label*="add"]'
              ).length > 0;
              
              // Only add if it looks like a product (has name + (price OR link OR product indicators))
              if (name && (price > 0 || productUrl || hasProductIndicators || description.length > 0)) {
                const key = `${name.toLowerCase()}|${(vendor || 'unknown').toLowerCase()}`;
                if (!seenProducts.has(key)) {
                  seenProducts.add(key);
                  htmlProductsFound++;
                  products.push({
                    name: name,
                    vendor: vendor || 'Unknown Vendor',
                    price: price,
                    billingCycle: billingCycle,
                    description: description,
                    url: productUrl || '',
                    source: 'HTML_DOM'
                  });
                }
              }
            }
          } catch (err) {
            // Continue with next element if this one fails
          }
        });
      });
      
      if (htmlProductsFound > 0) {
        console.log(`✅ Found ${htmlProductsFound} products in HTML DOM`);
      }
      
      // METHOD 3: Extract from data attributes
      $('[data-product-name], [data-product-id], [data-name]').each((i, elem) => {
        const name = $(elem).attr('data-product-name') || $(elem).attr('data-name') || 
                    $(elem).text().trim();
        const productId = $(elem).attr('data-product-id') || $(elem).attr('data-id');
        
        if (name && name.length > 5) {
          const key = `${name.toLowerCase()}|unknown`;
          if (!seenProducts.has(key)) {
            seenProducts.add(key);
            products.push({
              name: name,
              vendor: 'Unknown Vendor',
              price: 0,
              billingCycle: 'Monthly',
              description: '',
              url: productId ? `https://shop.skysecure.ai/product/${productId}` : '',
              source: 'DATA_ATTRIBUTES'
            });
          }
        }
      });
      
      // METHOD 4: Extract from links that look like product links
      $('a[href*="/product/"], a[href*="product?"]').each((i, elem) => {
        const linkText = $(elem).text().trim();
        const href = $(elem).attr('href') || '';
        
        if (linkText && linkText.length > 5 && linkText.length < 200 && 
            !linkText.toLowerCase().includes('view all') &&
            !linkText.toLowerCase().includes('see more')) {
          const key = `${linkText.toLowerCase()}|unknown`;
          if (!seenProducts.has(key)) {
            seenProducts.add(key);
            const fullUrl = href.startsWith('http') ? href : `https://shop.skysecure.ai${href}`;
            products.push({
              name: linkText,
              vendor: 'Unknown Vendor',
              price: 0,
              billingCycle: 'Monthly',
              description: '',
              url: fullUrl,
              source: 'PRODUCT_LINKS'
            });
          }
        }
      });

      // METHOD 5: Try pagination - check if there are "next page" links and scrape them
      const nextPageLink = $('a[aria-label*="next"], a[class*="next"], a:contains("Next"), button[aria-label*="next"]').first().attr('href');
      if (nextPageLink && nextPageLink !== url) {
        const nextPageUrl = nextPageLink.startsWith('http') ? nextPageLink : 
                           new URL(nextPageLink, url).href;
        if (!urls.includes(nextPageUrl) && products.length > 0) {
          console.log(`📄 Found next page link: ${nextPageUrl}`);
          // Note: We'll let the caller handle pagination if needed
        }
      }
      
      const totalFound = products.length;
      console.log(`✅ Total products found on ${url}: ${totalFound} (JSON: ${jsonProductsFound}, HTML: ${htmlProductsFound})`);
      
      await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting
    } catch (error) {
      console.error(`❌ Error scraping listing page ${url}:`, error.message);
      // Continue with other URLs even if one fails
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`📦 FINAL SCRAPING RESULTS`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Total Products Scraped: ${products.length}`);
  console.log(`From ${urls.length} listing pages`);
  
  if (products.length > 0) {
    console.log(`\n📋 ALL SCRAPED PRODUCTS (${products.length} total):`);
    products.forEach((p, idx) => {
      console.log(`  ${idx + 1}. ${p.name} (${p.vendor}) - ₹${p.price}/${p.billingCycle}`);
      if (p.url) console.log(`      URL: ${p.url}`);
      if (p.source) console.log(`      Source: ${p.source}`);
    });
    
    // CRITICAL: Check for SQL/Database products specifically
    const sqlProducts = products.filter(p => {
      const name = (p.name || '').toLowerCase();
      const desc = (p.description || '').toLowerCase();
      return name.includes('sql') || name.includes('database') || name.includes('server') ||
             desc.includes('sql') || desc.includes('database') || desc.includes('server') ||
             name.includes('microsoft sql') || name.includes('sql server');
    });
    
    if (sqlProducts.length > 0) {
      console.log(`\n🔍 SQL/DATABASE PRODUCTS FOUND IN SCRAPED DATA (${sqlProducts.length}):`);
      sqlProducts.forEach((p, idx) => {
        console.log(`  ${idx + 1}. ${p.name} (${p.vendor}) - ₹${p.price}/${p.billingCycle}`);
      });
    } else {
      console.warn(`\n⚠️  WARNING: No SQL/Database products found in scraped data!`);
      console.warn(`   This could mean:`);
      console.warn(`   1. SQL products are not on the scraped pages`);
      console.warn(`   2. SQL products are loaded via JavaScript that needs to execute`);
      console.warn(`   3. SQL products are in a different format/structure`);
    }
  } else {
    console.warn(`⚠️  WARNING: No products found! This may indicate:`);
    console.warn(`  1. Website structure changed`);
    console.warn(`  2. Products load via JavaScript that needs to execute`);
    console.warn(`  3. Products are behind authentication`);
    console.warn(`  4. Selectors need to be updated`);
  }
  console.log(`${'='.repeat(80)}\n`);
  
  return products;
}

/**
 * Scrapes multiple pages from the SkySecure website
 * @param {string} baseUrl - Base URL of the website
 * @returns {Promise<string>} - Comprehensive knowledge base from all pages
 */
export async function scrapeAllPages(baseUrl = "https://shop.skysecure.ai/") {
  // Check cache first
  const now = Date.now();
  if (websiteCache.data && websiteCache.lastFetch &&
    (now - websiteCache.lastFetch) < websiteCache.ttl) {
    console.log("Using cached website content");
    return websiteCache.data;
  }

  try {
    const allContent = [];
    const visitedUrls = new Set();

    // DYNAMIC: Build pages to scrape from API data
    const now = Date.now();
    let pagesToScrape = [
      baseUrl, // Homepage
      `${baseUrl}products`, // Products page
      `${baseUrl}about-us`, // About Us
      `${baseUrl}contact-us`, // Contact Us
      `${baseUrl}orders`, // Orders
      `${baseUrl}compare`, // Compare
      `${baseUrl}review`, // Review
    ];

    // Check cache for dynamic URLs
    if (dynamicUrlsCache.urls && dynamicUrlsCache.lastFetch && 
        (now - dynamicUrlsCache.lastFetch) < dynamicUrlsCache.ttl) {
      console.log("Using cached dynamic URLs for scraping");
      pagesToScrape.push(...dynamicUrlsCache.urls);
    } else {
      // Fetch categories and OEMs from API to build URLs dynamically
      try {
        console.log("Building dynamic URLs from API categories...");
        const categoryData = await fetchCategoryHierarchy();
        
        const dynamicUrls = [];

        // Build subcategory URLs from API
        if (categoryData.categories && Array.isArray(categoryData.categories)) {
          categoryData.categories.forEach(category => {
            const subCategories = category.subcategories || category.subCategories || [];
            
            subCategories.forEach(subCategory => {
              const subCategoryName = subCategory.name || subCategory.title || '';
              const subCategoryId = subCategory._id || subCategory.id;
              
              if (subCategoryId && subCategoryName) {
                // Build URL with subcategory ID and name
                const subCategorySlug = subCategoryName.toLowerCase()
                  .replace(/\s+/g, '-')
                  .replace(/[^a-z0-9-]/g, '');
                dynamicUrls.push(
                  `${baseUrl}products?subCategoryId=${subCategoryId}&subCategory=${subCategorySlug}`
                );
              }
            });
          });
          
          console.log(`✅ Built ${dynamicUrls.length} dynamic subcategory URLs`);
        }

        // Build OEM URLs from API
        if (categoryData.oems && Array.isArray(categoryData.oems)) {
          categoryData.oems.forEach(oem => {
            const oemId = oem._id || oem.id;
            if (oemId) {
              dynamicUrls.push(`${baseUrl}products?oemId=${oemId}`);
            }
          });
          
          console.log(`✅ Built ${categoryData.oems.length} dynamic OEM URLs`);
        }

        // Update cache
        dynamicUrlsCache.urls = dynamicUrls;
        dynamicUrlsCache.lastFetch = now;
        
        pagesToScrape.push(...dynamicUrls);
        console.log(`✅ Total dynamic URLs to scrape: ${dynamicUrls.length}`);
        // Log sample URLs for debugging
        if (dynamicUrls.length > 0) {
          console.log(`   Sample URLs: ${dynamicUrls.slice(0, 3).join(', ')}...`);
        }
      } catch (error) {
        console.error("Error building dynamic URLs:", error.message);
        console.warn("Using fallback hardcoded URLs");
        
        // Fallback to hardcoded URLs if API fails
        const fallbackUrls = [
          `${baseUrl}products?subCategoryId=6942ac81d91c1f7c88d02bbb&sort=none`, // Cloud services
          `${baseUrl}products?subCategoryId=6942ac70d91c1f7c88d02bad&subCategory=Data-Management`, // Data Management
          `${baseUrl}products?subCategoryId=6942ac61d91c1f7c88d02b9f&subCategory=Collaboration-Tools`, // Collaboration Tools
          `${baseUrl}products?subCategoryId=6942ac51d91c1f7c88d02b91&subCategory=Enterprise-Applications`, // Enterprise Applications
          `${baseUrl}products?subCategoryId=6942ac3ed91c1f7c88d02b83&subCategory=Governance-and-Compliance`, // Governance and Compliance
          `${baseUrl}products?subCategoryId=6942ac2dd91c1f7c88d02b75&subCategory=Identity-and-Access-Management`, // Identity and Access Management
          `${baseUrl}products?subCategoryId=6942ab6ad91c1f7c88d02b5a&subCategory=Communication`, // Communication
          `${baseUrl}products?oemId=68931b8d7874310ffca28d65`, // OEM 1
        ];
        pagesToScrape.push(...fallbackUrls);
      }
    }

    console.log(`Starting to scrape ${pagesToScrape.length} pages...`);

    // Scrape each page
    for (const url of pagesToScrape) {
      if (visitedUrls.has(url)) continue;
      visitedUrls.add(url);

      try {
        console.log(`Scraping: ${url}`);
        const pageContent = await scrapePage(url);
        if (pageContent) {
          allContent.push(`\n=== PAGE: ${url} ===\n${pageContent}\n`);
        }
        // Small delay to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        // Continue with other pages even if one fails
      }
    }

    // Also try to find and scrape product detail pages
    try {
      const productLinks = await findProductLinks(baseUrl);
      console.log(`Found ${productLinks.length} product links to scrape`);

      for (const productUrl of productLinks.slice(0, 20)) { // Limit to first 20 products
        if (visitedUrls.has(productUrl)) continue;
        visitedUrls.add(productUrl);

        try {
          const productContent = await scrapePage(productUrl);
          if (productContent) {
            allContent.push(`\n=== PRODUCT PAGE: ${productUrl} ===\n${productContent}\n`);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          console.error(`Error scraping product ${productUrl}:`, error.message);
        }
      }
    } catch (error) {
      console.error("Error finding product links:", error.message);
    }

    const combinedContent = allContent.join("\n\n");
    console.log(`Scraped ${visitedUrls.size} pages, total content length: ${combinedContent.length} characters`);

    // Update cache
    websiteCache.data = combinedContent;
    websiteCache.lastFetch = now;

    return combinedContent;
  } catch (error) {
    console.error("Error in scrapeAllPages:", error.message);
    return "";
  }
}

// Rest of the file remains the same (scrapePage, findProductLinks functions)
async function scrapePage(url) {
  // ... (keeping existing implementation from lines 119-613)
  try {
    const response = await makeRequest(url, {
      timeout: 15000,
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const content = [];

    // CRITICAL: Extract JSON data from script tags BEFORE removing them
    // React/Next.js apps often embed product data in JSON-LD or script tags
    $('script[type="application/json"], script[type="application/ld+json"], script').each((i, elem) => {
      const scriptContent = $(elem).html();
      if (scriptContent) {
        try {
          // Try to parse as JSON
          const jsonData = JSON.parse(scriptContent);
          const jsonString = JSON.stringify(jsonData);

          // Look for product-related data
          if (jsonString.includes('product') || jsonString.includes('Product') ||
            jsonString.includes('best') || jsonString.includes('selling') ||
            jsonString.includes('recently') || jsonString.includes('latest') ||
            jsonString.includes('featured')) {
            content.push(`JSON DATA: ${jsonString.substring(0, 5000)}`);
          }
        } catch (e) {
          // Not JSON, but check if it contains product data
          if (scriptContent.includes('product') || scriptContent.includes('Product') ||
            scriptContent.includes('best') || scriptContent.includes('selling') ||
            scriptContent.includes('recently') || scriptContent.includes('latest')) {
            content.push(`SCRIPT DATA: ${scriptContent.substring(0, 3000)}`);
          }
        }
      }
    });

    // Now remove unwanted elements
    $("script, style, nav, footer, header, .header, .footer, .nav").remove();

    // Page title
    const title = $("title").text().trim();
    if (title) {
      content.push(`Page Title: ${title}`);
    }

    // Extract URL parameters to identify category/sub-category/OEM pages
    try {
      const urlObj = new URL(url);
      const subCategoryId = urlObj.searchParams.get('subCategoryId');
      const subCategory = urlObj.searchParams.get('subCategory');
      const oemId = urlObj.searchParams.get('oemId');

      if (subCategoryId) {
        content.push(`Sub-Category ID: ${subCategoryId}`);
        if (subCategory) {
          content.push(`Sub-Category Name: ${subCategory}`);
          content.push(`=== PRODUCTS IN SUB-CATEGORY: ${subCategory} ===`);
        } else {
          content.push(`=== PRODUCTS IN SUB-CATEGORY ID: ${subCategoryId} ===`);
        }
      }
      if (oemId) {
        content.push(`OEM ID: ${oemId}`);
        content.push(`=== PRODUCTS FROM OEM ID: ${oemId} ===`);
      }
    } catch (e) {
      // Ignore URL parsing errors
    }

    // Main headings
    $("h1, h2, h3").each((i, elem) => {
      const text = $(elem).text().trim();
      if (text && text.length > 3) {
        content.push(`Heading: ${text}`);
      }
    });

    // CRITICAL: Extract products from JSON data in script tags (for React/Next.js apps)
    $('script[type="application/json"], script[type="application/ld+json"], script').each((i, elem) => {
      const scriptContent = $(elem).html();
      if (scriptContent && (scriptContent.includes('product') || scriptContent.includes('Product') || 
          scriptContent.includes('docs') || scriptContent.includes('items'))) {
        try {
          const jsonData = JSON.parse(scriptContent);
          
          // Recursively find product arrays
          function extractProducts(obj, depth = 0) {
            if (depth > 5) return []; // Prevent infinite recursion
            const products = [];
            
            if (Array.isArray(obj)) {
              obj.forEach(item => {
                if (item && typeof item === 'object') {
                  const name = item.name || item.title || item.productName;
                  if (name && typeof name === 'string' && name.length > 5) {
                    products.push({
                      name: name,
                      vendor: item.vendor || item.oemDetails?.[0]?.title || item.brand || '',
                      price: item.price || item.sellingPrice || item.subscriptions?.[0]?.sellingPrice || 0,
                      description: item.description || item.overview || ''
                    });
                  }
                }
              });
            } else if (obj && typeof obj === 'object') {
              Object.keys(obj).forEach(key => {
                if (key.toLowerCase().includes('product') || key.toLowerCase().includes('item') || 
                    key.toLowerCase().includes('doc') || key === 'data' || key === 'products') {
                  const found = extractProducts(obj[key], depth + 1);
                  products.push(...found);
                }
              });
            }
            return products;
          }
          
          const extractedProducts = extractProducts(jsonData);
          if (extractedProducts.length > 0) {
            content.push(`=== PRODUCTS FROM JSON DATA (${extractedProducts.length} products) ===`);
            extractedProducts.forEach((p, idx) => {
              content.push(`Product ${idx + 1}: ${p.name}`);
              if (p.vendor) content.push(`  Vendor: ${p.vendor}`);
              if (p.price) content.push(`  Price: ₹${p.price}`);
              if (p.description) content.push(`  Description: ${p.description.substring(0, 150)}`);
            });
            content.push(`=== END PRODUCTS FROM JSON DATA ===`);
          }
        } catch (e) {
          // Not valid JSON, but might contain product info
          if (scriptContent.includes('SQL') || scriptContent.includes('sql') || 
              scriptContent.includes('Server') || scriptContent.includes('Database')) {
            content.push(`SCRIPT CONTENT (may contain product data): ${scriptContent.substring(0, 2000)}`);
          }
        }
      }
    });

    // COMPREHENSIVE: Product cards/sections - Multiple extraction methods
    const productSelectors = [
      "[class*='product']", "[id*='product']", "[class*='Product']", "[id*='Product']",
      "[class*='card']", "[class*='Card']", "[data-product]", "[data-product-id]",
      "article", "[role='article']", "[class*='item']", "[class*='listing']",
      "[class*='grid-item']", "li[class*='product']", "div[class*='product']"
    ];
    
    let productsFoundInPage = 0;
    productSelectors.forEach(selector => {
      $(selector).each((i, elem) => {
        const productText = $(elem).text().trim();
        if (productText && productText.length > 20) {
          // Extract product name from multiple possible locations
          const productName = $(elem).find('h1, h2, h3, h4, h5, h6, [class*="name"], [class*="title"], [class*="Name"], [class*="Title"], strong, b, a').first().text().trim() ||
                             productText.split('\n')[0].trim().substring(0, 200);
          
          if (productName && productName.length > 5 && productName.length < 200) {
            content.push(`Product Name: ${productName}`);
            productsFoundInPage++;
          }
          
          // Extract price
          const price = $(elem).find('[class*="price"], [class*="Price"], [class*="cost"], [class*="amount"], [class*="rupee"]').first().text().trim();
          if (price) {
            content.push(`Product Price: ${price}`);
          }
          
          // Extract vendor
          const vendor = $(elem).find('[class*="vendor"], [class*="oem"], [class*="brand"], [class*="manufacturer"]').first().text().trim();
          if (vendor) {
            content.push(`Product Vendor: ${vendor}`);
          }
          
          // Extract description
          const description = $(elem).find('[class*="description"], [class*="desc"], [class*="overview"], p').first().text().trim();
          if (description && description.length > 10) {
            content.push(`Product Description: ${description.substring(0, 200)}`);
          }
          
          // Extract URL
          const productUrl = $(elem).find('a[href*="product"], a[href*="/product/"]').first().attr('href');
          if (productUrl) {
            content.push(`Product URL: ${productUrl}`);
          }
          
          // Check for product indicators
          const hasBuyButton = $(elem).find('[class*="buy"], [class*="Buy"], button, [class*="button"], [class*="cart"], [class*="add"]').length > 0;
          if (hasBuyButton) {
            content.push(`Product Action: Buy/Add to Cart available`);
          }
          
          // Full product info
          content.push(`Product Info: ${productText.substring(0, 400)}`);
        }
      });
    });
    
    // Also extract from any text that looks like product listings (SQL, Server, etc.)
    const bodyText = $('body').text();
    const productPatterns = [
      /(SQL Server[^\n]{0,150})/gi,
      /(Microsoft[^\n]{0,150})/gi,
      /(₹[\d,]+[^\n]{0,100})/gi,
      /(License[^\n]{0,150})/gi,
      /(Standard|Enterprise|Express)[^\n]{0,100}/gi
    ];
    
    productPatterns.forEach(pattern => {
      const matches = bodyText.match(pattern);
      if (matches && matches.length > 0) {
        matches.slice(0, 30).forEach(match => {
          const cleanMatch = match.trim();
          if (cleanMatch.length > 10 && cleanMatch.length < 250 && 
              !cleanMatch.toLowerCase().includes('privacy') &&
              !cleanMatch.toLowerCase().includes('cookie')) {
            content.push(`Potential Product Reference: ${cleanMatch}`);
          }
        });
      }
    });
    
    if (productsFoundInPage > 0) {
      content.push(`\n=== PRODUCTS FOUND ON THIS PAGE: ${productsFoundInPage} ===`);
    }

    // Clean and format
    let pageContent = content
      .filter((text) => text && text.length > 0)
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();

    return pageContent || null;
  } catch (error) {
    console.error(`Error scraping page ${url}:`, error.message);
    return null;
  }
}

async function findProductLinks(baseUrl) {
  try {
    const response = await makeRequest(baseUrl, {
      timeout: 10000,
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const productLinks = [];

    // Find all links that might be product pages
    $("a[href*='product'], a[href*='Product']").each((i, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
        if (!productLinks.includes(fullUrl)) {
          productLinks.push(fullUrl);
        }
      }
    });

    // Also check for links in product cards
    $("[class*='product'] a, [id*='product'] a").each((i, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
        if (!productLinks.includes(fullUrl)) {
          productLinks.push(fullUrl);
        }
      }
    });

    return productLinks;
  } catch (error) {
    console.error("Error finding product links:", error.message);
    return [];
  }
}
