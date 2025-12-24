/**
 * Smart Product Categorizer
 * Automatically assigns subcategories to products based on their name, description, and keywords
 * This is a WORKAROUND for products missing subCategoryDetails in the database
 */

// Category patterns with keywords and regex patterns
const categoryPatterns = {
  'Cloud services': {
    id: '6942ac81d91c1f7c88d02bbb',
    legacyId: '68931f427874310ffca28ea2',
    keywords: [
      'cloud', 'azure', 'aws', 'google cloud', 'windows 365', 'virtual desktop',
      'cloud pc', 'saas', 'paas', 'iaas', 'hosted', 'online service',
      'microsoft 365 apps', 'office 365 enterprise', 'enterprise mobility'
    ],
    patterns: [
      /windows\s+365/i,
      /microsoft\s+365\s+(e3|e5|f3|business|apps)/i,
      /azure\s+/i,
      /dynamics\s+365\s+online/i,
      /office\s+365\s+e/i,
      /cloud\s+(app|service|solution)/i
    ]
  },
  'Data Management': {
    id: '6942ac70d91c1f7c88d02bad',
    legacyId: '68931f337874310ffca28e96',
    keywords: [
      'sql', 'database', 'data', 'storage', 'backup', 'archive',
      'sql server', 'azure sql', 'cosmos db', 'data warehouse',
      'big data', 'analytics', 'reporting', 'audit log'
    ],
    patterns: [
      /sql\s+server/i,
      /azure\s+sql/i,
      /database/i,
      /data\s+(management|warehouse|lake|factory)/i,
      /big\s+data/i,
      /audit\s+log/i
    ]
  },
  'Collaboration Tools': {
    id: '6942ac61d91c1f7c88d02b9f',
    legacyId: '68931f257874310ffca28e8a',
    keywords: [
      'teams', 'sharepoint', 'onedrive', 'exchange', 'outlook',
      'collaboration', 'chat', 'meeting', 'video conference',
      'yammer', 'viva', 'project', 'planner'
    ],
    patterns: [
      /microsoft\s+teams/i,
      /sharepoint/i,
      /onedrive/i,
      /exchange\s+(online|server)/i,
      /project\s+(online|server)/i,
      /visio\s+(online|plan)/i,
      /viva/i
    ]
  },
  'Enterprise Applications': {
    id: '6942ac51d91c1f7c88d02b91',
    legacyId: '68931f137874310ffca28e7e',
    keywords: [
      'dynamics', 'crm', 'erp', 'business', 'enterprise',
      'sales', 'customer service', 'field service', 'finance',
      'supply chain', 'commerce'
    ],
    patterns: [
      /dynamics\s+365/i,
      /business\s+central/i,
      /power\s+(apps|automate|bi|pages)/i,
      /crm/i,
      /erp/i
    ]
  },
  'Governance and Compliance': {
    id: '6942ac3ed91c1f7c88d02b83',
    legacyId: '68931efb7874310ffca28e72',
    keywords: [
      'compliance', 'governance', 'security', 'compliance center',
      'advanced compliance', 'information protection', 'ediscovery',
      'audit', 'insider risk', 'communication compliance'
    ],
    patterns: [
      /compliance/i,
      /governance/i,
      /ediscovery/i,
      /information\s+protection/i,
      /insider\s+risk/i,
      /advanced\s+audit/i
    ]
  },
  'Identity and Access Management': {
    id: '6942ac2dd91c1f7c88d02b75',
    legacyId: '68931ee47874310ffca28e66',
    keywords: [
      'identity', 'entra', 'azure ad', 'active directory',
      'authentication', 'access', 'security', 'mfa', 'conditional access',
      'defender', 'intune', 'endpoint'
    ],
    patterns: [
      /azure\s+ad/i,
      /entra/i,
      /active\s+directory/i,
      /defender\s+for/i,
      /intune/i,
      /endpoint\s+(manager|protection)/i,
      /identity\s+(governance|protection)/i
    ]
  },
  'Communication': {
    id: '6942ab6ad91c1f7c88d02b5a',
    legacyId: '68931ec87874310ffca28e5a',
    keywords: [
      'calling', 'phone', 'pstn', 'audio conferencing',
      'communication', 'voice', 'telephony'
    ],
    patterns: [
      /calling/i,
      /audio\s+conferencing/i,
      /phone\s+system/i,
      /pstn/i,
      /domestic\s+calling/i
    ]
  }
};

/**
 * Intelligently categorize a product based on its attributes
 * @param {Object} product - Product object with name, description, etc.
 * @returns {Object} - { subCategory, subCategoryId, confidence }
 */
export function categorizeProduct(product) {
  const name = (product.name || '').toLowerCase();
  const description = (product.description || '').toLowerCase();
  const searchText = `${name} ${description}`;
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const [categoryName, categoryData] of Object.entries(categoryPatterns)) {
    let score = 0;
    
    // Check regex patterns (high weight)
    for (const pattern of categoryData.patterns) {
      if (pattern.test(name)) {
        score += 10; // Name match is very strong
      } else if (pattern.test(description)) {
        score += 5; // Description match is good
      }
    }
    
    // Check keywords (lower weight)
    for (const keyword of categoryData.keywords) {
      if (name.includes(keyword)) {
        score += 3;
      } else if (description.includes(keyword)) {
        score += 1;
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        subCategory: categoryName,
        subCategoryId: categoryData.id,
        legacySubCategoryId: categoryData.legacyId,
        confidence: Math.min(score / 10, 1.0) // Normalize to 0-1
      };
    }
  }
  
  return bestMatch || {
    subCategory: '',
    subCategoryId: null,
    legacySubCategoryId: null,
    confidence: 0
  };
}

/**
 * Enrich products with inferred subcategories
 * @param {Array} products - Array of product objects
 * @returns {Array} - Products with subcategories filled in
 */
export function enrichProductsWithCategories(products) {
  let enrichedCount = 0;
  
  const enrichedProducts = products.map(product => {
    // If product already has a subcategory, keep it
    if (product.subCategory && product.subCategory.trim() !== '') {
      return product;
    }
    
    // Otherwise, try to infer it
    const categorization = categorizeProduct(product);
    
    if (categorization.subCategory && categorization.confidence > 0.3) {
      enrichedCount++;
      
      // Add inferred subcategory data
      return {
        ...product,
        subCategory: categorization.subCategory,
        subCategoryId: product.subCategoryId || categorization.subCategoryId,
        subCategoryDetails: product.subCategoryDetails?.length > 0 
          ? product.subCategoryDetails 
          : [{
              subCategoryId: categorization.subCategoryId,
              subCategoryName: categorization.subCategory,
              _inferred: true, // Mark as inferred
              confidence: categorization.confidence
            }],
        _categoryInferred: true // Flag for debugging
      };
    }
    
    return product;
  });
  
  console.log(`🤖 Smart Categorization: Enriched ${enrichedCount} products with inferred subcategories`);
  
  return enrichedProducts;
}

/**
 * Get subcategory mapping for a given ID or name
 */
export function getSubcategoryInfo(idOrName) {
  for (const [categoryName, categoryData] of Object.entries(categoryPatterns)) {
    if (categoryData.id === idOrName || 
        categoryData.legacyId === idOrName ||
        categoryName.toLowerCase() === (idOrName || '').toLowerCase()) {
      return {
        name: categoryName,
        id: categoryData.id,
        legacyId: categoryData.legacyId
      };
    }
  }
  return null;
}

