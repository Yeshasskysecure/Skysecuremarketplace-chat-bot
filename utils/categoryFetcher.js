import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeRequest } from "./httpClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * Fetches hierarchical category structure from the API with local fallback
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

    let categories = [];
    let oems = [];

    // 1. Try to fetch from API
    try {
      console.log("Fetching category hierarchy from API...");
      const categoryUrl = `${PRODUCT_SERVICE_BACKEND_URL}/categories/get-grouped-categories?page=1&limit=100&subCategoryLimit=100`;
      const categoryResponse = await makeRequest(categoryUrl, { timeout: 8000 });

      if (categoryResponse.ok) {
        const categoryData = await categoryResponse.json();
        if (Array.isArray(categoryData?.data)) {
          categories = categoryData.data;
        } else if (categoryData?.data?.docs && Array.isArray(categoryData.data.docs)) {
          categories = categoryData.data.docs;
        }
      }

      console.log("Fetching OEMs from API...");
      const oemUrl = `${PRODUCT_SERVICE_BACKEND_URL}/oems/public/get-all-oems?page=1&limit=100`;
      const oemResponse = await makeRequest(oemUrl, { timeout: 8000 });

      if (oemResponse.ok) {
        const oemData = await oemResponse.json();
        if (oemData?.data?.docs && Array.isArray(oemData.data.docs)) {
          oems = oemData.data.docs;
        } else if (Array.isArray(oemData?.data)) {
          oems = oemData.data;
        }
      }
    } catch (apiError) {
      console.warn("Category API fetch failed, falling back to local files:", apiError.message);
    }

    // 2. Fallback/Merge with local JSON if API data is missing
    if (categories.length === 0) {
      console.log("Loading category hierarchy from local JSON fallback...");
      try {
        const categoryPath = path.join(__dirname, 'data', 'category_rankings.json');
        if (fs.existsSync(categoryPath)) {
          const content = fs.readFileSync(categoryPath, 'utf-8');
          categories = JSON.parse(content);
        }
      } catch (err) {
        console.error("Local category fallback failed:", err.message);
      }
    }

    if (oems.length === 0) {
      console.log("Loading OEMs from local JSON fallback...");
      try {
        const oemPath = path.join(__dirname, 'data', 'oem_rankings.json');
        if (fs.existsSync(oemPath)) {
          const content = fs.readFileSync(oemPath, 'utf-8');
          oems = JSON.parse(content);
        }
      } catch (err) {
        console.error("Local OEM fallback failed:", err.message);
      }
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
    console.error("Error in fetchCategoryHierarchy:", error.message);
    if (categoryCache.data) return categoryCache.data;
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

  let knowledgeBase = `\n=== MARKETPLACE CATEGORY HIERARCHY ===\n\n`;
  knowledgeBase += `This section shows the COMPLETE hierarchical structure of categories in SkySecure Marketplace.\n`;
  knowledgeBase += `Main categories are numbered (1., 2., etc.), sub-categories are indented (1.1, 1.2, etc.), and sub-sub-categories are further indented (1.1.1, 1.1.2, etc.).\n\n`;

  if (!categories || categories.length === 0) {
    knowledgeBase += `No category hierarchy available.\n\n`;
  } else {
    // Build category hierarchy
    categories.forEach((category, index) => {
      const categoryName = category.category || category.name || category.title || `Category ${index + 1}`;
      const categoryId = category._id || category.id;

      // Count products in this category
      let productsInCategory = category.productCount || category.count || 0;
      if (productsInCategory === 0 && products.length > 0) {
        productsInCategory = products.filter(p => {
          if (p.category === categoryName) return true;
          if (p.categoryId === categoryId || p.categoryId?.toString() === categoryId?.toString()) return true;
          return false;
        }).length;
      }

      knowledgeBase += `${index + 1}. ${categoryName} (${productsInCategory} products)\n`;

      // Add sub-categories (support both API and JSON field names)
      const subCategories = category.subCategories || category.subcategories || [];
      if (Array.isArray(subCategories) && subCategories.length > 0) {
        subCategories.forEach((subCategory, subIndex) => {
          const subCategoryName = subCategory.name || subCategory.title || `Sub-category ${subIndex + 1}`;
          const subCategoryId = subCategory._id || subCategory.id;

          let productsInSubCategory = subCategory.count || subCategory.productCount || 0;
          if (productsInSubCategory === 0 && products.length > 0) {
            productsInSubCategory = products.filter(p => {
              if (p.subCategory === subCategoryName) return true;
              if (p.subCategoryId === subCategoryId || p.subCategoryId?.toString() === subCategoryId?.toString()) return true;
              return false;
            }).length;
          }

          knowledgeBase += `   ${index + 1}.${subIndex + 1} ${subCategoryName} (${productsInSubCategory} products)\n`;

          // Add sub-sub-categories (support both API and JSON field names)
          const subSubCategories = subCategory.subSubs || subCategory.subSubcategories || subCategory.subSubCategories || [];
          if (Array.isArray(subSubCategories) && subSubCategories.length > 0) {
            subSubCategories.forEach((subSubCategory, subSubIndex) => {
              const subSubCategoryName = subSubCategory.name || subSubCategory.title || `Sub-sub-category ${subSubIndex + 1}`;
              const subSubCategoryId = subSubCategory._id || subSubCategory.id;

              let productsInSubSubCategory = subSubCategory.count || subSubCategory.productCount || 0;
              if (productsInSubSubCategory === 0 && products.length > 0) {
                productsInSubSubCategory = products.filter(p => {
                  if (p.subSubCategory === subSubCategoryName) return true;
                  if (p.subSubCategoryId === subSubCategoryId || p.subSubCategoryId?.toString() === subSubCategoryId?.toString()) return true;
                  return false;
                }).length;
              }

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
  knowledgeBase += `OEMs (Original Equipment Manufacturers) are vendors/brands that provide products in SkySecure Marketplace.\n\n`;

  if (!oems || oems.length === 0) {
    knowledgeBase += `No OEMs available.\n\n`;
  } else {
    knowledgeBase += `Available OEMs:\n`;
    oems.forEach((oem, index) => {
      const oemName = oem.oem || oem.name || oem.title || `OEM ${index + 1}`;
      const productsFromOEM = oem.count || oem.productCount || 0;

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


