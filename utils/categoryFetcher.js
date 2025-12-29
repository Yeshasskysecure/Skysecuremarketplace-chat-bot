import { makeRequest } from "./httpClient.js";

const PRODUCT_SERVICE_BACKEND_URL = process.env.PRODUCT_SERVICE_BACKEND_URL ||
  process.env.NEXT_PUBLIC_PRODUCT_SERVICE_BACKEND_URL ||
  "https://devshop-backend.skysecure.ai/api/product";

// Cache for category and OEM data (refresh every 10 minutes)
let categoryCache = {
  data: null,
  lastFetch: null,
  ttl: 10 * 60 * 1000, // 10 minutes
};

// Cache for formatted hierarchy string
let hierarchyCache = {
  formattedString: null,
  productCount: 0,
  lastUpdate: null
};

/**
 * Fetches hierarchical category structure from the API
 * @returns {Promise<Object>} - Category hierarchy with sub-categories
 */
export async function fetchCategoryHierarchy() {
  try {
    const now = Date.now();
    if (categoryCache.data && categoryCache.lastFetch &&
      (now - categoryCache.lastFetch) < categoryCache.ttl) {
      console.log("Using cached category data");
      return categoryCache.data;
    }

    console.log("Fetching category hierarchy from API...");
    const categoryUrl = `${PRODUCT_SERVICE_BACKEND_URL}/categories/get-grouped-categories?page=1&limit=100&subCategoryLimit=100`;
    const categoryResponse = await makeRequest(categoryUrl, {
      timeout: 15000,
    });

    let categories = [];
    if (categoryResponse.ok) {
      const categoryData = await categoryResponse.json();
      // Handle both array and object with docs property
      if (Array.isArray(categoryData?.data)) {
        categories = categoryData.data;
      } else if (categoryData?.data?.docs && Array.isArray(categoryData.data.docs)) {
        categories = categoryData.data.docs;
      } else if (categoryData?.data && Array.isArray(categoryData.data)) {
        categories = categoryData.data;
      }

      // Log category structure for debugging
      if (categories.length > 0) {
        const firstCategory = categories[0];
        console.log(`Sample category structure:`, {
          name: firstCategory.name,
          hasSubcategories: !!(firstCategory.subcategories || firstCategory.subCategories),
          subcategoryCount: (firstCategory.subcategories || firstCategory.subCategories || []).length
        });
      }

      console.log(`Fetched ${categories.length} categories with hierarchy`);
    } else {
      console.warn(`Category API returned status ${categoryResponse.status}`);
      const errorText = await categoryResponse.text().catch(() => '');
      console.warn(`Category API error response: ${errorText.substring(0, 200)}`);
    }

    // Fetch OEMs
    console.log("Fetching OEMs from API...");
    const oemUrl = `${PRODUCT_SERVICE_BACKEND_URL}/oems/public/get-all-oems?page=1&limit=100`;
    const oemResponse = await makeRequest(oemUrl, {
      timeout: 15000,
    });

    let oems = [];
    if (oemResponse.ok) {
      const oemData = await oemResponse.json();
      if (oemData?.data?.docs && Array.isArray(oemData.data.docs)) {
        oems = oemData.data.docs;
      } else if (Array.isArray(oemData?.data)) {
        oems = oemData.data;
      }
      console.log(`Fetched ${oems.length} OEMs`);
    } else {
      console.warn(`OEM API returned status ${oemResponse.status}`);
    }

    const result = {
      categories: categories,
      oems: oems,
      fetchedAt: now,
    };

    // Update cache
    categoryCache.data = result;
    categoryCache.lastFetch = now;

    return result;
  } catch (error) {
    console.error("Error fetching category hierarchy:", error.message);
    // Return cached data if available
    if (categoryCache.data) {
      console.warn("Using cached category data due to fetch error");
      return categoryCache.data;
    }
    return { categories: [], oems: [], fetchedAt: Date.now() };
  }
}

/**
 * Formats category hierarchy into a knowledge base string
 * @param {Array} categories - Array of category objects with sub-categories
 * @param {Array} oems - Array of OEM objects
 * @param {Array} products - Array of products to calculate counts
 * @returns {string} - Formatted category knowledge base
 */
export function formatCategoryHierarchyForKnowledgeBase(categories, oems, products) {
  // Check cache first
  if (hierarchyCache.formattedString &&
    hierarchyCache.productCount === products.length &&
    hierarchyCache.lastUpdate &&
    (Date.now() - hierarchyCache.lastUpdate < categoryCache.ttl)) {
    console.log("Using cached formatted category hierarchy");
    return hierarchyCache.formattedString;
  }

  let knowledgeBase = `\n=== MARKETPLACE CATEGORY HIERARCHY (Live Data from API) ===\n\n`;
  knowledgeBase += `This section shows the COMPLETE hierarchical structure of categories in SkySecure Marketplace.\n`;
  knowledgeBase += `Main categories are numbered (1., 2., etc.), sub-categories are indented (1.1, 1.2, etc.), and sub-sub-categories are further indented (1.1.1, 1.1.2, etc.).\n\n`;

  if (!categories || categories.length === 0) {
    knowledgeBase += `No category hierarchy available from API.\n\n`;
  } else {
    // Build category hierarchy
    categories.forEach((category, index) => {
      const categoryName = category.name || category.title || `Category ${index + 1}`;
      const categoryId = category._id || category.id;

      // Count products in this category - check multiple possible field names
      const productsInCategory = products.filter(p => {
        // Check direct category name match
        if (p.category === categoryName) return true;
        // Check if product has categoryId that matches
        if (p.categoryId === categoryId || p.categoryId?.toString() === categoryId?.toString()) return true;
        // Check if product has categoryDetails array with matching ID
        if (p.categoryDetails && Array.isArray(p.categoryDetails)) {
          return p.categoryDetails.some(c => {
            const cId = c._id || c.id;
            return cId === categoryId || cId?.toString() === categoryId?.toString();
          });
        }
        return false;
      }).length;

      knowledgeBase += `${index + 1}. ${categoryName} (${productsInCategory} products)\n`;

      // Add sub-categories - API uses lowercase "subcategories" and "subSubcategories"
      const subCategories = category.subcategories || category.subCategories || [];
      if (Array.isArray(subCategories) && subCategories.length > 0) {
        subCategories.forEach((subCategory, subIndex) => {
          const subCategoryName = subCategory.name || subCategory.title || `Sub-category ${subIndex + 1}`;
          const subCategoryId = subCategory._id || subCategory.id;

          // Count products in this sub-category - check multiple possible field names
          const productsInSubCategory = products.filter(p => {
            // Check direct sub-category name match
            if (p.subCategory === subCategoryName) return true;
            // Check if product has subCategoryId that matches
            if (p.subCategoryId === subCategoryId || p.subCategoryId?.toString() === subCategoryId?.toString()) return true;
            // Check if product has subCategoryDetails array with matching ID
            if (p.subCategoryDetails && Array.isArray(p.subCategoryDetails)) {
              return p.subCategoryDetails.some(sc => {
                const scId = sc._id || sc.id;
                return scId === subCategoryId || scId?.toString() === subCategoryId?.toString();
              });
            }
            return false;
          }).length;

          knowledgeBase += `   ${index + 1}.${subIndex + 1} ${subCategoryName} (${productsInSubCategory} products)\n`;

          // Add sub-sub-categories - API uses lowercase "subSubcategories"
          const subSubCategories = subCategory.subSubcategories || subCategory.subSubCategories || [];
          if (Array.isArray(subSubCategories) && subSubCategories.length > 0) {
            subSubCategories.forEach((subSubCategory, subSubIndex) => {
              const subSubCategoryName = subSubCategory.name || subSubCategory.title || `Sub-sub-category ${subSubIndex + 1}`;
              const subSubCategoryId = subSubCategory._id || subSubCategory.id;

              // Count products in this sub-sub-category - check multiple possible field names
              const productsInSubSubCategory = products.filter(p => {
                // Check direct sub-sub-category name match
                if (p.subSubCategory === subSubCategoryName) return true;
                // Check if product has subSubCategoryId that matches
                if (p.subSubCategoryId === subSubCategoryId || p.subSubCategoryId?.toString() === subSubCategoryId?.toString()) return true;
                // Check if product has subSubCategoryDetails array with matching ID
                if (p.subSubCategoryDetails && Array.isArray(p.subSubCategoryDetails)) {
                  return p.subSubCategoryDetails.some(ssc => {
                    const sscId = ssc._id || ssc.id;
                    return sscId === subSubCategoryId || sscId?.toString() === subSubCategoryId?.toString();
                  });
                }
                return false;
              }).length;

              knowledgeBase += `      ${index + 1}.${subIndex + 1}.${subSubIndex + 1} ${subSubCategoryName} (${productsInSubSubCategory} products)\n`;
            });
          }
        });
      }
      knowledgeBase += `\n`;
    });
  }

  knowledgeBase += `=== END CATEGORY HIERARCHY ===\n\n`;

  // Add OEMs section
  knowledgeBase += `\n=== ORIGINAL EQUIPMENT MANUFACTURERS (OEMs) ===\n\n`;
  knowledgeBase += `OEMs (Original Equipment Manufacturers) are vendors/brands that provide products in SkySecure Marketplace.\n`;
  knowledgeBase += `OEMs are separate from categories and represent companies like Microsoft, Google, Adobe, Intel, AWS, etc.\n\n`;

  if (!oems || oems.length === 0) {
    knowledgeBase += `No OEMs available from API.\n\n`;
  } else {
    knowledgeBase += `Available OEMs:\n`;
    oems.forEach((oem, index) => {
      const oemName = oem.title || oem.name || `OEM ${index + 1}`;

      // Count products from this OEM - check multiple possible field names
      const productsFromOEM = products.filter(p => {
        // Check direct vendor name match
        if (p.vendor === oemName) return true;
        // Check if product has oemId that matches
        const oemId = oem._id || oem.id;
        if (p.oemId === oemId || p.oemId?.toString() === oemId?.toString()) return true;
        // Check if product has oemDetails array with matching ID
        if (p.oemDetails && Array.isArray(p.oemDetails)) {
          return p.oemDetails.some(o => {
            const oId = o._id || o.id;
            return oId === oemId || oId?.toString() === oemId?.toString();
          });
        }
        return false;
      }).length;

      knowledgeBase += `${index + 1}. ${oemName} (${productsFromOEM} products)\n`;
    });
  }
  knowledgeBase += `=== END OEMs ===\n\n`;

  // Update cache
  hierarchyCache.formattedString = knowledgeBase;
  hierarchyCache.productCount = products.length;
  hierarchyCache.lastUpdate = Date.now();

  return knowledgeBase;
}

