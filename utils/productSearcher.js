/**
 * Product Search Utility - Fuzzy and Partial Matching
 * Handles product name searches with typos, partial matches, and variations
 */

/**
 * Performs fuzzy search on products by name, description, tags, and features
 * @param {string} searchQuery - User's search query
 * @param {Array} products - Array of all products
 * @param {number} threshold - Minimum match score (0-1)
 * @returns {Array} - Matching products sorted by relevance
 */
export function searchProducts(searchQuery, products, threshold = 0.2) { // Lowered default threshold from 0.3 to 0.2
  if (!searchQuery || !products || products.length === 0) {
    return [];
  }

  const query = searchQuery.toLowerCase().trim();
  const queryWords = query.split(/\s+/).filter(w => w.length > 2);

  const results = products.map(product => {
    const score = calculateProductMatchScore(query, queryWords, product);
    return { product, score };
  })
    .filter(result => result.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(result => ({
      ...result.product,
      _matchScore: result.score,
      _matchReason: result.score > 0.8 ? 'Exact Match' : result.score > 0.6 ? 'Strong Match' : 'Partial Match'
    }));

  // DETAILED SEARCH LOGGING
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔍 PRODUCT SEARCH EXECUTED`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Search Query: "${searchQuery}"`);
  console.log(`Total Products Searched: ${products.length}`);
  console.log(`Matches Found: ${results.length}`);
  console.log(`Match Threshold: ${threshold * 100}%`);
  console.log(`${'-'.repeat(80)}`);

  if (results.length > 0) {
    console.log(`\n📊 SEARCH RESULTS (Top ${Math.min(10, results.length)}):`);
    console.log(`${'-'.repeat(80)}`);
    results.slice(0, 10).forEach((r, i) => {
      console.log(`${String(i + 1).padStart(3, ' ')}. ${r.name}`);
      console.log(`     Match Score: ${(r._matchScore * 100).toFixed(1)}% (${r._matchReason})`);
      console.log(`     Vendor: ${r.vendor} | Category: ${r.category}${r.subCategory ? ` > ${r.subCategory}` : ''}`);
      console.log(`     Price: ₹${r.price || 0}/${r.billingCycle || 'Monthly'}`);
      if (r.subscriptions && r.subscriptions.length > 0) {
        console.log(`     Plans: ${r.subscriptions.map(s => s.plan).join(', ')}`);
      }
    });
    console.log(`${'-'.repeat(80)}`);
    
    // DYNAMIC GROUPING: Group results by category
    const resultsByCategory = {};
    results.forEach(r => {
      const cat = r.category || 'Uncategorized';
      if (!resultsByCategory[cat]) resultsByCategory[cat] = [];
      resultsByCategory[cat].push(r);
    });
    
    console.log(`\n📦 SEARCH RESULTS BY CATEGORY:`);
    Object.entries(resultsByCategory).forEach(([cat, catResults]) => {
      console.log(`  ${cat}: ${catResults.length} products`);
    });
  } else {
    console.log(`\n⚠️  NO MATCHES FOUND for "${searchQuery}"`);
    console.log(`${'-'.repeat(80)}`);
    console.log(`Possible reasons:`);
    console.log(`  1. Product name doesn't match search query`);
    console.log(`  2. Match score below threshold (${threshold * 100}%)`);
    console.log(`  3. Product not present in API response`);
    console.log(`${'-'.repeat(80)}`);

    // Show closest partial matches (even below threshold)
    const allScores = products.map(product => {
      const score = calculateProductMatchScore(query, queryWords, product);
      return { product, score };
    })
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (allScores.length > 0) {
      console.log(`\n🔍 CLOSEST PARTIAL MATCHES (Below threshold):`);
      console.log(`${'-'.repeat(80)}`);
      allScores.forEach((r, i) => {
        console.log(`${String(i + 1).padStart(3, ' ')}. ${r.product.name}`);
        console.log(`     Score: ${(r.score * 100).toFixed(1)}% (below ${threshold * 100}% threshold)`);
      });
      console.log(`${'-'.repeat(80)}`);
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ SEARCH COMPLETE`);
  console.log(`${'='.repeat(80)}\n`);

  return results;
}

/**
 * Calculates match score between search query and product
 * @param {string} query - Normalized search query
 * @param {Array<string>} queryWords - Individual query words
 * @param {Object} product - Product object
 * @returns {number} - Match score (0-1)
 */
function calculateProductMatchScore(query, queryWords, product) {
  let score = 0;
  const weights = {
    exactName: 1.0,
    nameContains: 0.8,
    nameWordMatch: 0.6,
    description: 0.4,
    tags: 0.5,
    features: 0.3,
    vendor: 0.2,
    category: 0.15
  };

  const productName = (product.name || '').toLowerCase();
  const productDescription = (product.description || '').toLowerCase();
  const productVendor = (product.vendor || '').toLowerCase();
  const productCategory = (product.category || '').toLowerCase();
  const productSubCategory = (product.subCategory || '').toLowerCase();

  // Exact name match
  if (productName === query) {
    return 1.0; // Perfect match
  }

  // Product name contains query (or vice versa)
  if (productName.includes(query)) {
    score += weights.nameContains;
  } else if (query.includes(productName) && productName.length > 10) {
    score += weights.nameContains * 0.8;
  }

  // Word-level matching in product name
  const productNameWords = productName.split(/\s+/).filter(w => w.length > 2);
  const matchingWords = queryWords.filter(qw =>
    productNameWords.some(pw => pw.includes(qw) || qw.includes(pw))
  );

  if (queryWords.length > 0) {
    const wordMatchRatio = matchingWords.length / queryWords.length;
    score += weights.nameWordMatch * wordMatchRatio;
  }

  // Check description
  if (productDescription.includes(query)) {
    score += weights.description;
  } else {
    const descMatchCount = queryWords.filter(qw => productDescription.includes(qw)).length;
    if (descMatchCount > 0) {
      score += weights.description * (descMatchCount / queryWords.length);
    }
  }

  // Check tags
  if (product.tags && Array.isArray(product.tags)) {
    const tagMatches = product.tags.some(tag =>
      (tag || '').toLowerCase().includes(query) || query.includes((tag || '').toLowerCase())
    );
    if (tagMatches) {
      score += weights.tags;
    }
  }

  // Check features
  if (product.features && Array.isArray(product.features)) {
    const featureMatches = product.features.some(feature => {
      const featureText = typeof feature === 'string' ? feature : (feature.name || feature.title || '');
      return featureText.toLowerCase().includes(query);
    });
    if (featureMatches) {
      score += weights.features;
    }
  }

  // Check vendor
  if (productVendor.includes(query) || query.includes(productVendor)) {
    score += weights.vendor;
  }

  // Check category/subcategory
  if (productCategory.includes(query) || productSubCategory.includes(query)) {
    score += weights.category;
  }

  // Special handling for common patterns
  score += handleSpecialPatterns(query, queryWords, product);

  return Math.min(score, 1.0); // Cap at 1.0
}

/**
 * Handles special matching patterns (e.g., "GPU" matching "vCPU", version numbers, etc.)
 * @param {string} query - Search query
 * @param {Array<string>} queryWords - Query words
 * @param {Object} product - Product object
 * @returns {number} - Additional score bonus
 */
function handleSpecialPatterns(query, queryWords, product) {
  let bonus = 0;
  const productName = (product.name || '').toLowerCase();

  // Pattern 1: Windows 365 variations
  if (query.includes('windows 365') || query.includes('windows365')) {
    if (productName.includes('windows 365') || productName.includes('windows365')) {
      bonus += 0.2;

      // Check for specific variants (Frontline, Enterprise, Business)
      const variants = ['frontline', 'enterprise', 'business', 'shared'];
      for (const variant of variants) {
        if (query.includes(variant) && productName.includes(variant)) {
          bonus += 0.3;
        }
      }

      // Check for specs (GPU, vCPU, RAM, Storage)
      const specPatterns = [
        { query: ['gpu', 'graphic'], product: ['gpu', 'graphic'] },
        { query: ['vcpu', 'cpu', 'core'], product: ['vcpu', 'cpu', 'core'] },
        { query: ['ram', 'memory', 'gb'], product: ['gb', 'ram', 'memory'] },
        { query: ['storage', 'disk'], product: ['storage', 'disk', 'gb'] }
      ];

      for (const pattern of specPatterns) {
        const queryHasSpec = pattern.query.some(s => query.includes(s));
        const productHasSpec = pattern.product.some(s => productName.includes(s));
        if (queryHasSpec && productHasSpec) {
          bonus += 0.25;
        }
      }
    }
  }

  // Pattern 2: Microsoft 365 variations
  if (query.includes('365') || query.includes('office')) {
    if (productName.includes('365') || productName.includes('office')) {
      bonus += 0.1;

      // Check for plan variants (E3, E5, F1, F3, Business, Apps)
      const plans = ['e3', 'e5', 'f1', 'f3', 'a3', 'a5', 'business', 'apps', 'copilot'];
      for (const plan of plans) {
        if (query.includes(plan) && productName.includes(plan)) {
          bonus += 0.3;
        }
      }
    }
  }

  // Pattern 3: SQL Server variations
  if (query.includes('sql')) {
    if (productName.includes('sql')) {
      bonus += 0.4; // Increased from 0.2

      // Check for editions (Standard, Enterprise, Express, Web)
      const editions = ['standard', 'enterprise', 'express', 'web', 'developer'];
      for (const edition of editions) {
        if (query.includes(edition) && productName.includes(edition)) {
          bonus += 0.2;
        }
      }

      // Check for licensing types (Core, CAL, User, Device)
      const licenses = ['core', 'cal', 'user', 'device'];
      for (const license of licenses) {
        if (query.includes(license) && productName.includes(license)) {
          bonus += 0.15;
        }
      }
    }
  }

  // Pattern 4: Version numbers (2019, 2022, 365, etc.)
  const queryVersions = query.match(/\b(201\d|202\d|365)\b/g) || [];
  const productVersions = productName.match(/\b(201\d|202\d|365)\b/g) || [];
  if (queryVersions.length > 0 && productVersions.length > 0) {
    const matchingVersions = queryVersions.filter(qv => productVersions.includes(qv));
    if (matchingVersions.length > 0) {
      bonus += 0.2;
    }
  }

  // Pattern 5: Acronyms and abbreviations
  const acronymPatterns = [
    { full: ['defender'], short: ['def', 'atp', 'edr'] },
    { full: ['intune'], short: ['mdm', 'mem'] },
    { full: ['entra'], short: ['aad', 'azure ad'] },
    { full: ['exchange'], short: ['exo', 'exchange online'] }
  ];

  for (const pattern of acronymPatterns) {
    const queryHasFull = pattern.full.some(f => query.includes(f));
    const queryHasShort = pattern.short.some(s => query.includes(s));
    const productHasFull = pattern.full.some(f => productName.includes(f));

    if ((queryHasFull || queryHasShort) && productHasFull) {
      bonus += 0.2;
    }
  }

  return bonus;
}

/**
 * Extracts key product specifications from product name
 * @param {string} productName - Product name
 * @returns {Object} - Extracted specs (vcpu, ram, storage, gpu, etc.)
 */
export function extractProductSpecs(productName) {
  const specs = {
    vcpu: null,
    ram: null,
    storage: null,
    gpu: false,
    cores: null
  };

  const name = productName.toLowerCase();

  // Extract vCPU/cores (e.g., "2vCPU", "4 vCPU", "8-core")
  const vcpuMatch = name.match(/(\d+)\s*v?cpu/i) || name.match(/(\d+)\s*core/i);
  if (vcpuMatch) {
    specs.vcpu = parseInt(vcpuMatch[1]);
    specs.cores = parseInt(vcpuMatch[1]);
  }

  // Extract RAM (e.g., "8GB", "16 GB RAM")
  const ramMatch = name.match(/(\d+)\s*gb(?:\s+ram)?/i);
  if (ramMatch) {
    specs.ram = parseInt(ramMatch[1]);
  }

  // Extract Storage (e.g., "128GB", "256 GB")
  const storageMatch = name.match(/(\d+)\s*gb/i);
  if (storageMatch && !ramMatch) { // Avoid double-counting RAM as storage
    specs.storage = parseInt(storageMatch[1]);
  }

  // Check for GPU
  if (name.includes('gpu') || name.includes('graphic')) {
    specs.gpu = true;
  }

  return specs;
}

/**
 * Formats search results for knowledge base
 * @param {Array} searchResults - Search results with products
 * @param {string} originalQuery - Original search query
 * @returns {string} - Formatted knowledge base text
 */
export function formatSearchResultsForKnowledgeBase(searchResults, originalQuery) {
  if (!searchResults || searchResults.length === 0) {
    return `\nPRODUCT SEARCH RESULTS for "${originalQuery}": No matching products found.\n`;
  }

  let kb = `\n=== PRODUCT SEARCH RESULTS for "${originalQuery}" ===\n`;
  kb += `Found ${searchResults.length} matching products:\n\n`;

  searchResults.slice(0, 20).forEach((product, index) => {
    kb += `${index + 1}. ${product.name}\n`;
    kb += `   Vendor: ${product.vendor}\n`;

    // Show ALL subscription plans
    if (product.subscriptions && product.subscriptions.length > 0) {
      kb += `   Pricing Options:\n`;
      product.subscriptions.forEach((sub) => {
        const planName = sub.plan || "Monthly";
        const price = sub.sellingPrice || sub.price || 0;
        kb += `     - ${planName}: ₹${price.toLocaleString('en-IN')}\n`;
      });
    } else {
      kb += `   Price: ₹${product.price || 0}/${product.billingCycle || "Monthly"}\n`;
    }

    kb += `   Category: ${product.category}${product.subCategory ? ` > ${product.subCategory}` : ''}\n`;

    if (product.id) {
      kb += `   Link: https://shop.skysecure.ai/product/${product.id}\n`;
    }

    if (product.description && product.description.length > 0) {
      kb += `   Description: ${product.description.substring(0, 150)}...\n`;
    }

    if (product._matchScore) {
      kb += `   Match Quality: ${product._matchReason} (${(product._matchScore * 100).toFixed(0)}%)\n`;
    }

    kb += `\n`;
  });

  if (searchResults.length > 20) {
    kb += `... and ${searchResults.length - 20} more matching products\n`;
  }

  kb += `=== END PRODUCT SEARCH RESULTS ===\n\n`;

  return kb;
}

