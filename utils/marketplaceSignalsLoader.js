import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory cache for marketplace signals
let signalsCache = {
  marketplaceSignals: null,
  categoryRankings: null,
  oemRankings: null,
  lastLoad: null,
};

/**
 * Loads marketplace signals from JSON files
 * @returns {Promise<Object>} - Object containing marketplaceSignals, categoryRankings, and oemRankings
 */
export async function loadMarketplaceSignals() {
  try {
    // Return cached data if available (cache for 1 hour)
    const now = Date.now();
    const cacheAge = 60 * 60 * 1000; // 1 hour
    if (signalsCache.marketplaceSignals &&
      signalsCache.categoryRankings &&
      signalsCache.oemRankings &&
      signalsCache.lastLoad &&
      (now - signalsCache.lastLoad) < cacheAge) {
      console.log("Using cached marketplace signals");
      return {
        marketplaceSignals: signalsCache.marketplaceSignals,
        categoryRankings: signalsCache.categoryRankings,
        oemRankings: signalsCache.oemRankings,
      };
    }

    console.log("Loading marketplace signals from JSON files...");

    // Load marketplace_signals.json
    const signalsPath = path.join(__dirname, 'data', 'marketplace_signals.json');
    const signalsContent = fs.readFileSync(signalsPath, 'utf-8');
    const signalsData = JSON.parse(signalsContent);

    // Normalize keys (handle both original and suffixed versions)
    const marketplaceSignals = {
      bestSelling: signalsData.bestSellingProducts || signalsData.bestSelling || [],
      featured: signalsData.featuredProducts || signalsData.featured || [],
      recentlyAdded: signalsData.recentlyAddedProducts || signalsData.recentlyAdded || [],
      scanDate: signalsData.scanDate,
      totalProducts: signalsData.totalProducts,
      topCategories: signalsData.topCategories || [],
      topOems: signalsData.topOems || []
    };

    // Load category_rankings.json
    const categoryPath = path.join(__dirname, 'data', 'category_rankings.json');
    const categoryContent = fs.readFileSync(categoryPath, 'utf-8');
    const categoryRankings = JSON.parse(categoryContent);

    // Load oem_rankings.json
    const oemPath = path.join(__dirname, 'data', 'oem_rankings.json');
    const oemContent = fs.readFileSync(oemPath, 'utf-8');
    const oemRankings = JSON.parse(oemContent);

    // Update cache
    signalsCache.marketplaceSignals = marketplaceSignals;
    signalsCache.categoryRankings = categoryRankings;
    signalsCache.oemRankings = oemRankings;
    signalsCache.lastLoad = now;

    console.log(`✅ Loaded marketplace signals:`);
    console.log(`   - Best Selling: ${marketplaceSignals.bestSelling.length} products`);
    console.log(`   - Featured: ${marketplaceSignals.featured.length} products`);
    console.log(`   - Recently Added: ${marketplaceSignals.recentlyAdded.length} products`);
    console.log(`   - Categories: ${Array.isArray(categoryRankings) ? categoryRankings.length : Object.keys(categoryRankings).length} categories`);
    console.log(`   - OEMs: ${Array.isArray(oemRankings) ? oemRankings.length : Object.keys(oemRankings).length} OEMs`);

    return {
      marketplaceSignals,
      categoryRankings,
      oemRankings,
    };
  } catch (error) {
    console.error("Error loading marketplace signals:", error.message);
    console.error("Stack:", error.stack);
    // Return empty structure on error
    return {
      marketplaceSignals: { bestSelling: [], featured: [], recentlyAdded: [] },
      categoryRankings: [],
      oemRankings: [],
    };
  }
}

/**
 * Resolves product IDs to actual product objects
 * @param {Array<string|Object>} productIds - Array of product IDs or objects containing IDs
 * @param {Array} products - Array of all products
 * @returns {Array} - Array of resolved product objects
 */
export function resolveProductsByIds(productIds, products) {
  if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
    return [];
  }

  if (!products || !Array.isArray(products) || products.length === 0) {
    return [];
  }

  // Create a map for fast lookup
  const productMap = new Map();
  products.forEach(product => {
    const id = product.id || product._id;
    if (id) {
      productMap.set(id.toString(), product);
    }
  });

  // Resolve products
  const resolvedProducts = [];
  productIds.forEach(item => {
    if (!item) return; // Skip null/undefined items
    const productId = typeof item === 'string'
      ? item
      : (item.id || item.productId || item._id);

    if (productId) {
      const product = productMap.get(productId.toString());
      if (product) {
        resolvedProducts.push(product);
      }
    }
  });

  return resolvedProducts;
}


