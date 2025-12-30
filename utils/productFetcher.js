import { makeRequest } from "./httpClient.js";
import { extractBestSellingProductsFromWebsite, extractRecentlyAddedProductsFromWebsite, matchProductsByName } from "./productMatcher.js";
import { scrapeListingProducts } from "./websiteScraper.js";

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
 * Fetches all products from the product API
 * @param {string} websiteContent - Optional scraped website content for fallback matching
 * @returns {Promise<Array>} - Array of product objects
 */
export async function fetchAllProducts(websiteContent = "", intentInfo = null) {
  try {
    // Check cache first
    const now = Date.now();
    if (productCache.data && productCache.lastFetch &&
      (now - productCache.lastFetch) < productCache.ttl) {
      console.log("Using cached product data");
      return productCache.data;
    }

    console.log("Fetching products from API...");

    // CRITICAL: Fetch main products first - this is the most important call
    const allProductsUrl = `${PRODUCT_SERVICE_BACKEND_URL}/products/public/products?page=1&limit=500&sortBy=createdAt&sortOrder=desc`;
    const allProductsResponse = await makeRequest(allProductsUrl, {
      timeout: 20000, // Increased timeout for main products
    });

    let allProducts = [];
    if (allProductsResponse.ok) {
      const allProductsData = await allProductsResponse.json();
      if (allProductsData?.data?.docs && Array.isArray(allProductsData.data.docs)) {
        allProducts = allProductsData.data.docs;

        // DYNAMIC LOGGING: Log all products fetched from API
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📦 PRODUCTS FETCHED FROM API`);
        console.log(`${'='.repeat(80)}`);
        console.log(`Total Products Fetched: ${allProducts.length}`);
        console.log(`\n📋 ALL PRODUCT NAMES (${allProducts.length} products):`);
        console.log(`${'-'.repeat(80)}`);
        allProducts.forEach((product, index) => {
          const productName = product.name || 'Unnamed Product';
          const vendor = product.oemDetails?.[0]?.title || 'Unknown Vendor';
          const category = product.categoryDetails?.[0]?.name || 'Uncategorized';
          const subCategory = product.subCategoryDetails?.[0]?.name || 'General';
          console.log(`${String(index + 1).padStart(4, ' ')}. ${productName}`);
          console.log(`        Vendor: ${vendor} | Category: ${category} | SubCategory: ${subCategory}`);
        });
        console.log(`${'='.repeat(80)}\n`);
      }
    } else {
      console.warn(`⚠️  API Response not OK: ${allProductsResponse.status}`);
    }

    // CRITICAL: If SQL/Data Management is detected, fetch products from that subcategory immediately
    if (intentInfo && intentInfo.subCategoryId && intentInfo.categoryName === "Data Management") {
      console.log(`\n🔍 SQL/Data Management detected! Fetching products from subcategory: ${intentInfo.subCategoryId}`);
      try {
        const subCategoryUrl = `${PRODUCT_SERVICE_BACKEND_URL}/products/public/products?subCategoryId=${intentInfo.subCategoryId}&page=1&limit=500`;
        const subCategoryResponse = await makeRequest(subCategoryUrl, {
          timeout: 15000,
        });

        if (subCategoryResponse.ok) {
          const subCategoryData = await subCategoryResponse.json();
          if (subCategoryData?.data?.docs && Array.isArray(subCategoryData.data.docs)) {
            const subCategoryProducts = subCategoryData.data.docs;

            // Merge with existing products, avoiding duplicates
            const existingIds = new Set(allProducts.map(p => p._id));
            subCategoryProducts.forEach(product => {
              if (!existingIds.has(product._id)) {
                allProducts.push(product);
                existingIds.add(product._id);
              }
            });

            console.log(`✅ Added ${subCategoryProducts.length} products from Data Management subcategory (Total: ${allProducts.length})`);

            // Log SQL products found
            const sqlProductsFound = subCategoryProducts.filter(p => {
              const name = (p.name || '').toLowerCase();
              return name.includes('sql') || name.includes('database');
            });
            console.log(`📊 SQL Products found in Data Management: ${sqlProductsFound.length}`);
            sqlProductsFound.forEach((p, idx) => {
              console.log(`   ${idx + 1}. ${p.name}`);
            });
          }
        }
      } catch (error) {
        console.warn(`⚠️  Error fetching Data Management products: ${error.message}`);
      }
    }

    // NON-CRITICAL: Fetch Best Selling products (non-blocking, with shorter timeout)
    // Use Promise to make this non-blocking - don't wait if it takes too long
    console.log("Fetching best selling products (non-blocking)...");

    const bestSellingPromise = (async () => {
      try {
        // Try primary endpoint only (faster)
        const bestSellingUrl = `${PRODUCT_SERVICE_BACKEND_URL}/premium-offerings/public/get-all-offerings?topSelling=true&page=1&limit=100`;
        const bestSellingResponse = await makeRequest(bestSellingUrl, {
          timeout: 8000, // Reduced timeout for non-critical call
        });
        return bestSellingResponse;
      } catch (error) {
        console.warn(`Best selling fetch failed: ${error.message}`);
        return null;
      }
    })();

    // Don't await - continue with other operations
    let bestSellingResponse = null;
    try {
      bestSellingResponse = await Promise.race([
        bestSellingPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 10000)) // Max 10s wait
      ]);
    } catch (error) {
      console.warn(`Best selling fetch error: ${error.message}`);
    }

    const bestSellingIds = new Set();
    const bestSellingProducts = [];
    if (bestSellingResponse.ok) {
      const bestSellingData = await bestSellingResponse.json();
      console.log(`Best selling API response structure:`, {
        hasData: !!bestSellingData?.data,
        hasDocs: !!bestSellingData?.data?.docs,
        docsIsArray: Array.isArray(bestSellingData?.data?.docs),
        docsLength: bestSellingData?.data?.docs?.length || 0,
        fullResponseKeys: Object.keys(bestSellingData || {}),
        dataKeys: bestSellingData?.data ? Object.keys(bestSellingData.data) : []
      });

      // Log first item structure for debugging
      if (bestSellingData?.data?.docs && bestSellingData.data.docs.length > 0) {
        console.log(`Sample best selling item:`, JSON.stringify(bestSellingData.data.docs[0]).substring(0, 500));
      }

      if (bestSellingData?.data?.docs && Array.isArray(bestSellingData.data.docs)) {
        bestSellingData.data.docs.forEach((item, idx) => {
          // Try multiple ways to get product ID
          const productId = item?.productId?._id || item?.productId?.id || item?._id || item?.id;

          // Also check if item has topSelling flag
          const isTopSelling = item?.topSelling === true || item?.isTopSelling === true || item?.isBestSelling === true;

          if (productId) {
            bestSellingIds.add(productId);
            // Store full product data
            if (item.productId) {
              bestSellingProducts.push(item.productId);
            } else if (item._id || item.id) {
              // If the item itself is the product
              bestSellingProducts.push(item);
            }
          } else if (isTopSelling && (item._id || item.id)) {
            // If it's marked as top selling but no productId, it might be the product itself
            const id = item._id || item.id;
            bestSellingIds.add(id);
            bestSellingProducts.push(item);
            console.log(`Found best selling product by flag: ${id}`);
          } else {
            console.warn(`Best selling item ${idx} has no productId:`, Object.keys(item || {}));
          }
        });
        console.log(`Found ${bestSellingIds.size} best selling products from API`);
      } else if (Array.isArray(bestSellingData?.data)) {
        // Handle case where data is directly an array
        bestSellingData.data.forEach((item, idx) => {
          const productId = item?.productId?._id || item?.productId?.id || item?._id || item?.id;
          const isTopSelling = item?.topSelling === true || item?.isTopSelling === true;

          if (productId) {
            bestSellingIds.add(productId);
            if (item.productId) {
              bestSellingProducts.push(item.productId);
            } else {
              bestSellingProducts.push(item);
            }
          } else if (isTopSelling && (item._id || item.id)) {
            const id = item._id || item.id;
            bestSellingIds.add(id);
            bestSellingProducts.push(item);
          } else {
            console.warn(`Best selling item ${idx} (array format) has no productId:`, Object.keys(item || {}));
          }
        });
        console.log(`Found ${bestSellingIds.size} best selling products from API (array format)`);
      } else if (bestSellingData?.data && !Array.isArray(bestSellingData.data) && typeof bestSellingData.data === 'object') {
        // Handle case where data is an object with nested structure
        console.log("Best selling data is an object, checking for nested products...");
        const nestedProducts = bestSellingData.data.products || bestSellingData.data.items || [];
        if (Array.isArray(nestedProducts)) {
          nestedProducts.forEach(item => {
            const productId = item?._id || item?.id;
            if (productId) {
              bestSellingIds.add(productId);
              bestSellingProducts.push(item);
            }
          });
          console.log(`Found ${bestSellingIds.size} best selling products from nested structure`);
        }
      } else {
        console.warn("Best selling API response structure unexpected:", {
          responseKeys: Object.keys(bestSellingData || {}),
          dataType: typeof bestSellingData?.data,
          dataValue: bestSellingData?.data ? JSON.stringify(bestSellingData.data).substring(0, 200) : 'null'
        });
      }
    } else {
      console.warn(`Best selling API returned status ${bestSellingResponse.status}`);
      const errorText = await bestSellingResponse.text().catch(() => '');
      console.warn(`Best selling API error: ${errorText.substring(0, 500)}`);
    }

    // If no best selling products found from API, try alternative approaches
    if (bestSellingIds.size === 0 && allProducts.length > 0) {
      console.log("No best selling products from API, trying alternative methods...");

      // Method 1: Check if products in main list have a "topSelling" or "isTopSelling" flag
      allProducts.forEach(product => {
        if (product.topSelling === true || product.isTopSelling === true || product.isBestSelling === true) {
          bestSellingIds.add(product._id);
          bestSellingProducts.push(product);
        }
      });

      // Method 2: Try fetching without the topSelling parameter to see all premium offerings
      if (bestSellingIds.size === 0) {
        console.log("Trying to fetch all premium offerings to find best selling...");
        try {
          const allOfferingsUrl = `${PRODUCT_SERVICE_BACKEND_URL}/premium-offerings/public/get-all-offerings?page=1&limit=100`;
          const allOfferingsResponse = await makeRequest(allOfferingsUrl, { timeout: 10000 });

          if (allOfferingsResponse.ok) {
            const allOfferingsData = await allOfferingsResponse.json();
            const offerings = allOfferingsData?.data?.docs || allOfferingsData?.data || [];

            // Check for topSelling flag in the offering itself
            offerings.forEach(offering => {
              if (offering.topSelling === true || offering.isTopSelling === true) {
                const productId = offering?.productId?._id || offering?.productId?.id;
                if (productId) {
                  bestSellingIds.add(productId);
                  if (offering.productId) {
                    bestSellingProducts.push(offering.productId);
                  }
                }
              }
            });
            console.log(`Found ${bestSellingIds.size} best selling products from all offerings`);
          }
        } catch (error) {
          console.warn("Error fetching all offerings:", error.message);
        }
      }

      console.log(`Total best selling products found: ${bestSellingIds.size}`);
    }

    // NON-CRITICAL: Fetch Recently Added products (non-blocking)
    console.log("Fetching recently added products (non-blocking)...");
    const recentlyAddedPromise = makeRequest(
      `${PRODUCT_SERVICE_BACKEND_URL}/premium-offerings/public/get-all-offerings?latest=true&page=1&limit=100`,
      { timeout: 8000 }
    ).catch(() => null);

    let recentlyAddedResponse = null;
    try {
      recentlyAddedResponse = await Promise.race([
        recentlyAddedPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 10000))
      ]);
    } catch (error) {
      console.warn(`Recently added fetch error: ${error.message}`);
    }

    const recentlyAddedIds = new Set();
    const recentlyAddedProducts = [];
    if (recentlyAddedResponse.ok) {
      const recentlyAddedData = await recentlyAddedResponse.json();
      if (recentlyAddedData?.data?.docs && Array.isArray(recentlyAddedData.data.docs)) {
        recentlyAddedData.data.docs.forEach(item => {
          if (item?.productId?._id) {
            recentlyAddedIds.add(item.productId._id);
            // Also store the full product data if available
            if (item.productId) {
              recentlyAddedProducts.push(item.productId);
            }
          }
        });
        console.log(`Found ${recentlyAddedIds.size} recently added products`);
      }
    }

    // NON-CRITICAL: Fetch Featured products (non-blocking, parallel)
    console.log("Fetching featured products (non-blocking)...");
    const featuredPromises = Promise.allSettled([
      makeRequest(`${PRODUCT_SERVICE_BACKEND_URL}/products/public/products?featured=true&page=1&limit=100`, { timeout: 8000 }),
      makeRequest(`${PRODUCT_SERVICE_BACKEND_URL}/premium-offerings/public/get-all-offerings?featured=true&page=1&limit=100`, { timeout: 8000 })
    ]);

    const featuredIds = new Set();
    try {
      const [featuredResult1, featuredResult2] = await Promise.race([
        featuredPromises,
        new Promise((resolve) => setTimeout(() => resolve([null, null]), 10000))
      ]) || [null, null];

      if (featuredResult1?.status === 'fulfilled' && featuredResult1.value?.ok) {
        try {
          const featuredData = await featuredResult1.value.json();
          if (featuredData?.data?.docs && Array.isArray(featuredData.data.docs)) {
            featuredData.data.docs.forEach(item => {
              if (item?._id) {
                featuredIds.add(item._id);
              }
            });
            console.log(`Found ${featuredIds.size} featured products from products endpoint`);
          }
        } catch (error) {
          console.warn(`Error parsing featured response 1: ${error.message}`);
        }
      }

      if (featuredResult2?.status === 'fulfilled' && featuredResult2.value?.ok) {
        try {
          const featuredData2 = await featuredResult2.value.json();
          if (featuredData2?.data?.docs && Array.isArray(featuredData2.data.docs)) {
            featuredData2.data.docs.forEach(item => {
              if (item?.productId?._id) {
                featuredIds.add(item.productId._id);
              }
            });
            console.log(`Found ${featuredIds.size} total featured products (including premium-offerings)`);
          }
        } catch (error) {
          console.warn(`Error parsing featured response 2: ${error.message}`);
        }
      }
    } catch (error) {
      console.warn(`Featured products fetch error: ${error.message}`);
    }

    if (allProducts.length === 0) {
      console.warn("⚠️  No products fetched from main API");
      if (productCache.data && productCache.data.length > 0) {
        console.warn("Returning cached product data as fallback");
        return productCache.data;
      }
      console.error("❌ No products available and no cache - returning empty array");
      return [];
    }

    console.log(`✅ Successfully fetched ${allProducts.length} products from API`);

    // Get current date for recently added calculation
    const currentDate = new Date();
    const thirtyDaysAgo = new Date(currentDate.getTime() - (30 * 24 * 60 * 60 * 1000));

    // Transform products to a simpler format
    const products = allProducts.map((item) => {
      // Extract createdAt date
      const createdAt = item.createdAt ? new Date(item.createdAt) : null;
      const isRecentlyCreated = createdAt && createdAt >= thirtyDaysAgo;
      const productId = item._id;

      // Check if this product is in best selling, featured, or recently added
      const isBestSelling = bestSellingIds.has(productId);
      const isFeatured = featuredIds.has(productId);
      const isRecentlyAdded = recentlyAddedIds.has(productId);

      return {
        id: productId,
        name: item.name,
        description: item.description || item.overview || "",
        vendor: item.oemDetails?.[0]?.title || "Unknown Vendor",
        category: item.categoryDetails?.[0]?.name || "Software",
        categoryId: item.categoryId || item.categoryDetails?.[0]?._id || item.categoryDetails?.[0]?.id,
        categoryDetails: item.categoryDetails || [],
        subCategory: item.subCategoryDetails?.[0]?.name || "",
        subCategoryId: item.subCategoryId || item.subCategoryDetails?.[0]?._id || item.subCategoryDetails?.[0]?.id,
        subCategoryDetails: item.subCategoryDetails || [],
        subSubCategory: item.subSubCategoryDetails?.[0]?.name || "",
        subSubCategoryId: item.subSubCategoryId || item.subSubCategoryDetails?.[0]?._id || item.subSubCategoryDetails?.[0]?.id,
        subSubCategoryDetails: item.subSubCategoryDetails || [],
        price: item.subscriptions?.[0]?.sellingPrice || 0,
        billingCycle: item.subscriptions?.[0]?.plan || "Monthly",
        subscriptions: item.subscriptions || [], // Include all subscriptions for multiple pricing options
        rating: item.rating || 0,
        reviewCount: item.peopleRated || 0,
        features: item.features || [],
        tags: item.tags || [],
        createdAt: createdAt ? createdAt.toISOString() : null,
        createdAtDate: createdAt,
        oemId: item.oemId || item.oemDetails?.[0]?._id || item.oemDetails?.[0]?.id,
        oemDetails: item.oemDetails || [],
        isFeatured: isFeatured || item.isFeatured || false,
        isTopSelling: isBestSelling || item.isTopSelling || false, // CRITICAL: Mark as top selling if in bestSellingIds
        // Mark as latest if: 1) explicitly marked in API, OR 2) created in last 30 days
        isLatest: isRecentlyAdded || item.isLatest || isRecentlyCreated || false,
      };
    });

    // DYNAMIC LOGGING: Log parsed products with categorization
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔄 PRODUCTS PARSED AND TRANSFORMED`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Total Parsed Products: ${products.length}`);
    console.log(`Featured: ${products.filter(p => p.isFeatured).length}`);
    console.log(`Top Selling: ${products.filter(p => p.isTopSelling).length}`);
    console.log(`Recently Added: ${products.filter(p => p.isLatest).length}`);

    // Group by category for dynamic logging
    const byCategory = {};
    const bySubCategory = {};
    const byVendor = {};

    products.forEach((product) => {
      const category = product.category || "Uncategorized";
      const subCategory = product.subCategory || "General";
      const vendor = product.vendor || "Unknown Vendor";

      if (!byCategory[category]) byCategory[category] = [];
      byCategory[category].push(product);

      if (!bySubCategory[subCategory]) bySubCategory[subCategory] = [];
      bySubCategory[subCategory].push(product);

      if (!byVendor[vendor]) byVendor[vendor] = [];
      byVendor[vendor].push(product);
    });

    console.log(`\n📊 PRODUCTS BY CATEGORY:`);
    console.log(`${'-'.repeat(80)}`);
    Object.entries(byCategory).sort((a, b) => b[1].length - a[1].length).forEach(([category, categoryProducts]) => {
      console.log(`  ${category}: ${categoryProducts.length} products`);
    });

    console.log(`\n📊 PRODUCTS BY SUB-CATEGORY:`);
    console.log(`${'-'.repeat(80)}`);
    Object.entries(bySubCategory).sort((a, b) => b[1].length - a[1].length).forEach(([subCategory, subCategoryProducts]) => {
      if (subCategory && subCategory !== "General") {
        console.log(`  ${subCategory}: ${subCategoryProducts.length} products`);
        // Log product names in this subcategory
        subCategoryProducts.slice(0, 10).forEach((p, idx) => {
          console.log(`    ${idx + 1}. ${p.name} (${p.vendor})`);
        });
        if (subCategoryProducts.length > 10) {
          console.log(`    ... and ${subCategoryProducts.length - 10} more`);
        }
      }
    });

    console.log(`\n📊 PRODUCTS BY VENDOR:`);
    console.log(`${'-'.repeat(80)}`);
    Object.entries(byVendor).sort((a, b) => b[1].length - a[1].length).forEach(([vendor, vendorProducts]) => {
      console.log(`  ${vendor}: ${vendorProducts.length} products`);
    });

    // DYNAMIC LOGGING: Log all product names with details
    console.log(`\n📋 ALL PARSED PRODUCT NAMES (${products.length} products):`);
    console.log(`${'-'.repeat(80)}`);
    products.forEach((product, index) => {
      const flags = [];
      if (product.isFeatured) flags.push('⭐ Featured');
      if (product.isTopSelling) flags.push('🏆 Top Selling');
      if (product.isLatest) flags.push('🆕 Recent');
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      console.log(`${String(index + 1).padStart(4, ' ')}. ${product.name}${flagStr}`);
      console.log(`        ID: ${product.id} | Vendor: ${product.vendor} | Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''} | Price: ₹${product.price}/${product.billingCycle}`);
    });
    console.log(`${'='.repeat(80)}\n`);

    console.log(`After mapping: ${products.filter(p => p.isTopSelling).length} products marked as top selling`);

    // Also add products from premium-offerings that might not be in the main products list
    // Add best selling products - CRITICAL: Update existing products or add new ones
    bestSellingProducts.forEach(product => {
      const productId = product._id;
      const existingProduct = products.find(p => p.id === productId);

      if (existingProduct) {
        // Update existing product to mark as best selling
        existingProduct.isTopSelling = true;
        console.log(`Updated existing product ${productId} (${existingProduct.name}) to best selling`);
      } else {
        // Add new product from best selling API
        const createdAt = product.createdAt ? new Date(product.createdAt) : null;
        const isRecentlyCreated = createdAt && createdAt >= thirtyDaysAgo;

        products.push({
          id: productId,
          name: product.name,
          description: product.description || product.overview || "",
          vendor: product.oemDetails?.[0]?.title || "Unknown Vendor",
          category: product.categoryDetails?.[0]?.name || "Software",
          categoryId: product.categoryId || product.categoryDetails?.[0]?._id || product.categoryDetails?.[0]?.id,
          categoryDetails: product.categoryDetails || [],
          subCategory: product.subCategoryDetails?.[0]?.name || "",
          subCategoryId: product.subCategoryId || product.subCategoryDetails?.[0]?._id || product.subCategoryDetails?.[0]?.id,
          subCategoryDetails: product.subCategoryDetails || [],
          subSubCategory: product.subSubCategoryDetails?.[0]?.name || "",
          subSubCategoryId: product.subSubCategoryId || product.subSubCategoryDetails?.[0]?._id || product.subSubCategoryDetails?.[0]?.id,
          subSubCategoryDetails: product.subSubCategoryDetails || [],
          price: product.subscriptions?.[0]?.sellingPrice || 0,
          billingCycle: product.subscriptions?.[0]?.plan || "Monthly",
          subscriptions: product.subscriptions || [], // Include all subscriptions
          rating: product.rating || 0,
          reviewCount: product.peopleRated || 0,
          features: product.features || [],
          tags: product.tags || [],
          createdAt: createdAt ? createdAt.toISOString() : null,
          createdAtDate: createdAt,
          oemId: product.oemId || product.oemDetails?.[0]?._id || product.oemDetails?.[0]?.id,
          oemDetails: product.oemDetails || [],
          isFeatured: featuredIds.has(productId) || false,
          isTopSelling: true, // CRITICAL: These are definitely best selling from API
          isLatest: recentlyAddedIds.has(productId) || isRecentlyCreated || false,
        });
        console.log(`Added new best selling product ${productId} (${product.name})`);
      }
    });

    // Add recently added products
    recentlyAddedProducts.forEach(product => {
      if (!products.find(p => p.id === product._id)) {
        const createdAt = product.createdAt ? new Date(product.createdAt) : null;
        const isRecentlyCreated = createdAt && createdAt >= thirtyDaysAgo;

        products.push({
          id: product._id,
          name: product.name,
          description: product.description || product.overview || "",
          vendor: product.oemDetails?.[0]?.title || "Unknown Vendor",
          category: product.categoryDetails?.[0]?.name || "Software",
          subCategory: product.subCategoryDetails?.[0]?.name || "",
          subSubCategory: product.subSubCategoryDetails?.[0]?.name || "",
          price: product.subscriptions?.[0]?.sellingPrice || 0,
          billingCycle: product.subscriptions?.[0]?.plan || "Monthly",
          subscriptions: product.subscriptions || [], // Include all subscriptions
          rating: product.rating || 0,
          reviewCount: product.peopleRated || 0,
          features: product.features || [],
          tags: product.tags || [],
          createdAt: createdAt ? createdAt.toISOString() : null,
          createdAtDate: createdAt,
          isFeatured: featuredIds.has(product._id) || false,
          isTopSelling: bestSellingIds.has(product._id) || false,
          isLatest: true, // These are definitely recently added from API
        });
      }
    });

    // If no products marked as "latest" from API, try website scraping fallback
    if (products.filter(p => p.isLatest).length === 0 && websiteContent) {
      try {
        console.log("No products marked as 'latest' from API, trying website scraping fallback...");
        const recentlyAddedNames = extractRecentlyAddedProductsFromWebsite(websiteContent);
        console.log(`Found ${recentlyAddedNames.length} product names in 'Recently Added' section from website`);

        if (recentlyAddedNames.length > 0) {
          const matchedIds = matchProductsByName(recentlyAddedNames, products);
          console.log(`Matched ${matchedIds.length} products from website 'Recently Added' section`);

          matchedIds.forEach(productId => {
            const product = products.find(p => p.id === productId);
            if (product) {
              product.isLatest = true;
            }
          });
        }
      } catch (error) {
        console.error("Error in website scraping fallback for recently added:", error.message);
        console.error("Error stack:", error.stack);
        // Continue without marking products - don't crash the whole process
      }
    }

    // If still no products marked as "latest", use createdAt date as final fallback
    if (products.filter(p => p.isLatest).length === 0) {
      console.log("No products found from website scraping, using createdAt date as fallback");
      const sortedByDate = products
        .filter(p => p.createdAtDate)
        .sort((a, b) => b.createdAtDate - a.createdAtDate)
        .slice(0, 20); // Top 20 most recent

      sortedByDate.forEach(product => {
        product.isLatest = true;
      });
      console.log(`Marked ${sortedByDate.length} products as recently added based on createdAt date`);
    }

    // If no products marked as "best selling" from API, try website scraping fallback
    const currentBestSellingCount = products.filter(p => p.isTopSelling).length;
    if (currentBestSellingCount === 0 && websiteContent) {
      try {
        console.log("No products marked as 'best selling' from API, trying website scraping fallback...");
        console.log(`Website content length: ${websiteContent.length} characters`);
        console.log(`Website content sample (first 1000 chars): ${websiteContent.substring(0, 1000)}`);

        const bestSellingNames = extractBestSellingProductsFromWebsite(websiteContent);
        console.log(`Found ${bestSellingNames.length} product names in 'Best Selling' section from website`);
        if (bestSellingNames.length > 0) {
          console.log(`Product names found: ${bestSellingNames.join(', ')}`);
        }

        if (bestSellingNames.length > 0) {
          const matchedIds = matchProductsByName(bestSellingNames, products);
          console.log(`Matched ${matchedIds.length} products from website 'Best Selling' section`);
          console.log(`Matched product IDs: ${matchedIds.slice(0, 10).join(', ')}`);

          matchedIds.forEach(productId => {
            const product = products.find(p => p.id === productId);
            if (product) {
              product.isTopSelling = true;
              console.log(`Marked product "${product.name}" (ID: ${product.id}) as best selling from website match`);
            }
          });

          const newBestSellingCount = products.filter(p => p.isTopSelling).length;
          console.log(`After website matching: ${newBestSellingCount} products marked as best selling (was ${currentBestSellingCount})`);
        } else {
          console.warn("No product names extracted from website 'Best Selling' section. Website content may not contain the section or extraction failed.");
          console.warn("Checking if 'best selling' text exists in content:", websiteContent.toLowerCase().includes('best selling'));

          // FINAL FALLBACK: If extraction failed but "best selling" section exists, 
          // try to match products that contain common best-selling keywords
          if (websiteContent.toLowerCase().includes('best selling')) {
            console.log("'Best Selling' text found but no products extracted. Trying keyword-based matching...");

            // Look for products with names that might appear in best selling section
            // Common best sellers are usually Microsoft 365 E3/E5 variants
            const bestSellingKeywords = ['E3', 'E5', '365'];
            const potentialBestSellers = products.filter(p => {
              const name = (p.name || '').toLowerCase();
              return bestSellingKeywords.some(keyword => name.includes(keyword.toLowerCase())) &&
                name.includes('microsoft') &&
                !name.includes('security') &&
                !name.includes('compliance');
            });

            if (potentialBestSellers.length > 0) {
              console.log(`Found ${potentialBestSellers.length} potential best sellers based on keywords`);
              // Mark top 10 as best selling
              potentialBestSellers.slice(0, 10).forEach(product => {
                product.isTopSelling = true;
                console.log(`Marked "${product.name}" as best selling (keyword fallback)`);
              });
            }
          }
        }
      } catch (error) {
        console.error("Error in website scraping fallback for best selling:", error.message);
        console.error("Error stack:", error.stack);
        // Continue without marking products - don't crash the whole process
      }
    }

    if (intentInfo && Array.isArray(intentInfo.listingUrls) && intentInfo.listingUrls.length > 0) {
      try {
        console.log(`Scraping listing pages for intent fallback: ${intentInfo.listingUrls.join(', ')}`);
        const scraped = await scrapeListingProducts(intentInfo.listingUrls);
        if (scraped.length > 0) {
          const existingKey = (p) => `${(p.name || '').toLowerCase()}|${(p.vendor || '').toLowerCase()}`;
          const existing = new Set(products.map(existingKey));
          scraped.forEach((sp) => {
            const key = `${(sp.name || '').toLowerCase()}|${(sp.vendor || '').toLowerCase()}`;
            if (!existing.has(key)) {
              const id = `scraped-${Buffer.from(key).toString('base64').replace(/=+$/, '')}`;
              products.push({
                id,
                name: sp.name,
                description: "",
                vendor: sp.vendor || "",
                category: intentInfo.categoryName || "",
                subCategory: intentInfo.categoryName || "",
                price: 0,
                billingCycle: "",
                rating: 0,
                reviewCount: 0,
                features: [],
                tags: [],
                createdAt: null,
                createdAtDate: null,
                oemId: intentInfo.oemId || null,
                oemDetails: [],
                isFeatured: false,
                isTopSelling: false,
                isLatest: false,
                productUrl: sp.url || "",
              });
            }
          });
          console.log(`Added ${products.length} total products after listing fallback`);
        }
      } catch (e) {
        console.warn("Listing fallback failed:", e.message);
      }
    }

    productCache.data = products;
    productCache.lastFetch = now;

    // FINAL DYNAMIC LOGGING: Summary of all products
    console.log(`\n${'='.repeat(80)}`);
    console.log(`✅ FINAL PRODUCT FETCH SUMMARY`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Total Products Available: ${products.length}`);
    console.log(`Featured Products: ${products.filter(p => p.isFeatured).length}`);
    console.log(`Top Selling Products: ${products.filter(p => p.isTopSelling).length}`);
    console.log(`Recently Added Products: ${products.filter(p => p.isLatest).length}`);

    // Dynamic search categories
    const sqlProducts = products.filter(p => {
      const name = (p.name || '').toLowerCase();
      const desc = (p.description || '').toLowerCase();
      return name.includes('sql') || desc.includes('sql') || name.includes('database');
    });

    const emailProducts = products.filter(p => {
      const name = (p.name || '').toLowerCase();
      const desc = (p.description || '').toLowerCase();
      return name.includes('email') || desc.includes('email') || name.includes('exchange') || name.includes('outlook');
    });

    const collaborationProducts = products.filter(p => {
      const name = (p.name || '').toLowerCase();
      const desc = (p.description || '').toLowerCase();
      const subCat = (p.subCategory || '').toLowerCase();
      return name.includes('teams') || name.includes('sharepoint') || name.includes('onedrive') ||
        subCat.includes('collaboration');
    });

    console.log(`\n🔍 DYNAMIC SEARCH CATEGORIES:`);
    console.log(`${'-'.repeat(80)}`);
    console.log(`SQL/Database Products: ${sqlProducts.length}`);
    if (sqlProducts.length > 0) {
      sqlProducts.forEach((p, idx) => {
        console.log(`  ${idx + 1}. ${p.name} (${p.vendor}) - ${p.subCategory || p.category}`);
      });
    }

    console.log(`Email Products: ${emailProducts.length}`);
    if (emailProducts.length > 0) {
      emailProducts.forEach((p, idx) => {
        console.log(`  ${idx + 1}. ${p.name} (${p.vendor}) - ${p.subCategory || p.category}`);
      });
    }

    console.log(`Collaboration Products: ${collaborationProducts.length}`);
    if (collaborationProducts.length > 0) {
      collaborationProducts.forEach((p, idx) => {
        console.log(`  ${idx + 1}. ${p.name} (${p.vendor}) - ${p.subCategory || p.category}`);
      });
    }

    // Group final products by category
    const finalByCategory = {};
    products.forEach(p => {
      const cat = p.category || 'Uncategorized';
      if (!finalByCategory[cat]) finalByCategory[cat] = [];
      finalByCategory[cat].push(p);
    });

    console.log(`\n📦 FINAL PRODUCTS BY CATEGORY:`);
    console.log(`${'-'.repeat(80)}`);
    Object.entries(finalByCategory).sort((a, b) => b[1].length - a[1].length).forEach(([category, categoryProducts]) => {
      console.log(`  ${category}: ${categoryProducts.length} products`);
      categoryProducts.slice(0, 5).forEach((p, idx) => {
        console.log(`    ${idx + 1}. ${p.name}`);
      });
      if (categoryProducts.length > 5) {
        console.log(`    ... and ${categoryProducts.length - 5} more`);
      }
    });

    console.log(`${'='.repeat(80)}\n`);

    return products;
  } catch (error) {
    console.error("Error fetching products:", error.message);
    console.error("Stack trace:", error.stack);

    // Return cached data if available, otherwise empty array
    if (productCache.data && productCache.data.length > 0) {
      console.warn("Using cached product data due to fetch error");
      return productCache.data;
    }

    // If no cache, return empty array - server.js will handle the error message
    console.error("No cached data available, returning empty array");
    return [];
  }
}

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
        .forEach((product) => {
          knowledgeBase += `  - ${product.name} (${product.vendor}): ${formatPriceDetails(product)}\n`;
          if (product.url) knowledgeBase += `    Link: ${product.url}\n`;
        });
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

    // Also check if product is in Data Management subcategory
    const isDataManagement = subCat.includes('data management') ||
      subCat.includes('data-management') ||
      category.includes('data');

    return hasSqlKeyword || isDataManagement;
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
    sqlProducts.forEach((product, index) => {
      knowledgeBase += `${index + 1}. **${product.name}**\n`;
      knowledgeBase += `   ${product.name}\n`; // Duplicate name for search results format
      knowledgeBase += `   Vendor: ${product.vendor}\n`;

      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;

      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      if (product.id) {
        knowledgeBase += `   Product ID: ${product.id}\n`;
        knowledgeBase += `   Link: https://shop.skysecure.ai/product/${product.id}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 200)}\n`;
      }
      knowledgeBase += `\n`;
    });
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
    emailCollabProducts.forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      if (product.url) {
        knowledgeBase += `   Link: ${product.url}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 150)}...\n`;
      }
      knowledgeBase += `\n`;
    });
    knowledgeBase += `=== END EMAIL & COLLABORATION PRODUCTS ===\n\n`;
  }

  if (includeFullList) {
    // Add ALL products list (comprehensive)
    knowledgeBase += `\nALL PRODUCTS LIST:\n`;
    products.slice(0, 100).forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name} (${product.vendor})\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      if (product.url) {
        knowledgeBase += `   Link: ${product.url}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 100)}...\n`;
      }
      knowledgeBase += `\n`;
    });
    if (products.length > 100) {
      knowledgeBase += `... and ${products.length - 100} more products\n\n`;
    }
  } else {
    knowledgeBase += `\nNOTE: The comprehensive product list is omitted for brevity. Use semantic search results to find specific products.\n\n`;
  }

  // Add featured products - CRITICAL SECTION
  const featured = products.filter((p) => p.isFeatured);
  if (featured.length > 0) {
    knowledgeBase += `\n=== FEATURED PRODUCTS (${featured.length} products) ===\n`;
    knowledgeBase += `These are the FEATURED products in SkySecure Marketplace:\n\n`;
    featured.forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      if (product.url) {
        knowledgeBase += `   Link: ${product.url}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 150)}...\n`;
      }
      knowledgeBase += `\n`;
    });
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
    topSelling.slice(0, 50).forEach((product, index) => { // Limit to 50 for token management
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      if (product.url) {
        knowledgeBase += `   Link: ${product.url}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 150)}...\n`;
      }
      knowledgeBase += `\n`;
    });
    if (topSelling.length > 50) {
      knowledgeBase += `... and ${topSelling.length - 50} more best selling products\n\n`;
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
    sortedRecentlyAdded.forEach((product, index) => {
      knowledgeBase += `${index + 1}. ${product.name}\n`;
      knowledgeBase += `   Vendor: ${product.vendor}\n`;
      knowledgeBase += `   Price: ${formatPriceDetails(product)}\n`;
      knowledgeBase += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;
      if (product.url) {
        knowledgeBase += `   Link: ${product.url}\n`;
      }
      if (product.createdAt) {
        const date = new Date(product.createdAt);
        knowledgeBase += `   Added: ${date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}\n`;
      }
      if (product.description) {
        knowledgeBase += `   Description: ${product.description.substring(0, 150)}...\n`;
      }
      knowledgeBase += `\n`;
    });
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
