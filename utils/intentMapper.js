import { fetchCategoryHierarchy } from "./categoryFetcher.js";

// Cache for dynamic category mapping (refresh every 10 minutes)
let dynamicCategoryCache = {
  subCategoryMap: null,
  oemMap: null,
  lastFetch: null,
  ttl: 10 * 60 * 1000, // 10 minutes
};

// Fallback hardcoded mappings (used if API fails)
const fallbackSubCategoryMap = [
  {
    id: "6942ac81d91c1f7c88d02bbb",
    names: ["cloud management", "cloud services", "cloud", "azure", "aws", "cloud platform"],
    label: "Cloud services"
  },
  {
    id: "6942ac70d91c1f7c88d02bad",
    names: ["data management", "data", "database", "data products", "storage", "data storage", "sql", "nosql"],
    label: "Data Management"
  },
  {
    id: "6942ac61d91c1f7c88d02b9f",
    names: ["collaboration", "collaboration tools", "teams", "chat", "sharepoint", "onedrive", "teamwork"],
    label: "Collaboration Tools"
  },
  {
    id: "6942ac51d91c1f7c88d02b91",
    names: ["enterprise applications", "enterprise apps", "erp", "crm", "business apps"],
    label: "Enterprise Applications"
  },
  {
    id: "6942ac3ed91c1f7c88d02b83",
    names: ["governance", "compliance", "governance and compliance", "regulatory", "audit"],
    label: "Governance And Compliance"
  },
  {
    id: "6942ac2dd91c1f7c88d02b75",
    names: ["identity", "identity and access", "iam", "security", "authentication", "access management"],
    label: "Identity and Access Management"
  },
  {
    id: "6942ab6ad91c1f7c88d02b5a",
    names: ["communication", "communication tools", "calling", "video", "conferencing"],
    label: "Communication"
  },
];

const fallbackOemMap = [
  { id: "68931b8d7874310ffca28d65", names: ["microsoft", "office", "azure", "ms"] },
];

/**
 * Builds dynamic category mapping from API data
 * @returns {Promise<{subCategoryMap: Array, oemMap: Array}>}
 */
async function buildDynamicCategoryMapping() {
  const now = Date.now();

  // Check cache first
  if (dynamicCategoryCache.subCategoryMap &&
    dynamicCategoryCache.lastFetch &&
    (now - dynamicCategoryCache.lastFetch) < dynamicCategoryCache.ttl) {
    console.log("Using cached dynamic category mapping");
    return {
      subCategoryMap: dynamicCategoryCache.subCategoryMap,
      oemMap: dynamicCategoryCache.oemMap
    };
  }

  try {
    console.log("Building dynamic category mapping from API...");
    const categoryData = await fetchCategoryHierarchy();

    const subCategoryMap = [];
    const oemMap = [];

    // Build subcategory mapping from API categories
    if (categoryData.categories && Array.isArray(categoryData.categories)) {
      categoryData.categories.forEach(category => {
        const subCategories = category.subcategories || category.subCategories || [];

        subCategories.forEach(subCategory => {
          const subCategoryName = (subCategory.name || subCategory.title || '').toLowerCase();
          const subCategoryId = subCategory._id || subCategory.id;

          if (subCategoryId && subCategoryName) {
            // Build keyword variations from subcategory name
            const nameWords = subCategoryName.split(/[\s-]+/).filter(w => w.length > 2);
            const names = [subCategoryName, ...nameWords];

            // Add common variations based on subcategory name
            if (subCategoryName.includes('data') || subCategoryName.includes('database')) {
              names.push('sql', 'nosql', 'data products', 'data storage');
            }
            if (subCategoryName.includes('cloud')) {
              names.push('azure', 'aws', 'cloud platform', 'cloud management');
            }
            if (subCategoryName.includes('collaboration')) {
              names.push('teams', 'sharepoint', 'onedrive', 'teamwork', 'chat');
            }
            if (subCategoryName.includes('enterprise')) {
              names.push('erp', 'crm', 'business apps', 'enterprise apps');
            }
            if (subCategoryName.includes('governance') || subCategoryName.includes('compliance')) {
              names.push('regulatory', 'audit');
            }
            if (subCategoryName.includes('identity') || subCategoryName.includes('access')) {
              names.push('iam', 'security', 'authentication', 'access management');
            }
            if (subCategoryName.includes('communication')) {
              names.push('calling', 'video', 'conferencing');
            }

            subCategoryMap.push({
              id: subCategoryId,
              names: [...new Set(names)], // Remove duplicates
              label: subCategory.name || subCategory.title || subCategoryName
            });
          }
        });
      });

      console.log(`✅ Built dynamic subcategory mapping: ${subCategoryMap.length} subcategories`);
      // Log first few subcategories for debugging
      subCategoryMap.slice(0, 5).forEach((sc, idx) => {
        console.log(`   ${idx + 1}. ${sc.label} (ID: ${sc.id}) - Keywords: ${sc.names.slice(0, 3).join(', ')}...`);
      });
    }

    // Build OEM mapping from API
    if (categoryData.oems && Array.isArray(categoryData.oems)) {
      categoryData.oems.forEach(oem => {
        const oemName = (oem.title || oem.name || '').toLowerCase();
        const oemId = oem._id || oem.id;

        if (oemId && oemName) {
          // Build keyword variations from OEM name
          const nameWords = oemName.split(/[\s-]+/).filter(w => w.length > 2);
          const names = [oemName, ...nameWords];

          // Add common variations
          if (oemName.includes('microsoft')) {
            names.push('office', 'azure', 'ms', 'microsoft 365', 'office 365');
          }

          oemMap.push({
            id: oemId,
            names: [...new Set(names)] // Remove duplicates
          });
        }
      });

      console.log(`✅ Built dynamic OEM mapping: ${oemMap.length} OEMs`);
      // Log OEMs for debugging
      oemMap.forEach((oem, idx) => {
        console.log(`   ${idx + 1}. OEM ID: ${oem.id} - Keywords: ${oem.names.slice(0, 3).join(', ')}...`);
      });
    }

    // Update cache
    dynamicCategoryCache.subCategoryMap = subCategoryMap.length > 0 ? subCategoryMap : fallbackSubCategoryMap;
    dynamicCategoryCache.oemMap = oemMap.length > 0 ? oemMap : fallbackOemMap;
    dynamicCategoryCache.lastFetch = now;

    return {
      subCategoryMap: dynamicCategoryCache.subCategoryMap,
      oemMap: dynamicCategoryCache.oemMap
    };
  } catch (error) {
    console.error("Error building dynamic category mapping:", error.message);
    console.warn("Using fallback hardcoded category mapping");

    // Return fallback if API fails
    return {
      subCategoryMap: fallbackSubCategoryMap,
      oemMap: fallbackOemMap
    };
  }
}

export async function resolveIntent(message, baseUrl = "https://shop.skysecure.ai/") {
  const text = (message || "").toLowerCase();

  // DYNAMIC: Fetch category mapping from API
  const { subCategoryMap, oemMap } = await buildDynamicCategoryMapping();

  const matches = { subCategoryId: null, categoryName: null, oemId: null, listingUrls: [], confidence: 0 };

  // Try exact and partial matches for subcategories
  for (const entry of subCategoryMap) {
    // Check for exact keyword match
    const exactMatch = entry.names.some(n => text.includes(n));

    // Check for fuzzy match (e.g., "data products" should match "data management")
    const fuzzyMatch = entry.names.some(n => {
      const keywords = n.split(' ');
      return keywords.every(keyword => text.includes(keyword));
    });

    if (exactMatch || fuzzyMatch) {
      matches.subCategoryId = entry.id;
      matches.categoryName = entry.label;
      matches.confidence = exactMatch ? 0.95 : 0.85;
      console.log(`Intent matched: "${text}" -> ${entry.label} (confidence: ${matches.confidence})`);
      break;
    }
  }

  for (const entry of oemMap) {
    if (entry.names.some(n => text.includes(n))) {
      matches.oemId = entry.id;
      matches.confidence = Math.max(matches.confidence, 0.8);
      console.log(`OEM matched: "${text}" -> ${entry.id}`);
      break;
    }
  }

  const listingUrls = [];
  try {
    const base = new URL(baseUrl);
    if (matches.subCategoryId) {
      listingUrls.push(`${base.origin}/products?subCategoryId=${matches.subCategoryId}`);
      // Add search fallback for subcategory
      if (matches.categoryName) {
        const searchParam = encodeURIComponent(matches.categoryName);
        listingUrls.push(`${base.origin}/products?search=${searchParam}`);
      }
    }
    if (matches.oemId) {
      listingUrls.push(`${base.origin}/products?oemId=${matches.oemId}`);
    }
  } catch { }

  matches.listingUrls = listingUrls;

  // Log final intent resolution
  if (matches.subCategoryId || matches.oemId) {
    console.log(`Final intent resolution:`, JSON.stringify(matches, null, 2));
  } else {
    console.log(`No specific intent matched for: "${text}"`);
  }

  return matches;
}

export function inferConversationStage(conversationHistory = [], message = "", intent = {}) {
  const history = conversationHistory || [];
  const lower = (message || "").toLowerCase();
  if (history.length < 2) return "Discovery";
  if (intent?.subCategoryId || intent?.oemId) return "Recommendation";
  if (lower.includes("buy") || lower.includes("purchase") || lower.includes("price")) return "Conversion";
  return "Narrowing";
}

/**
 * Checks if the message is related to the SkySecure domain (Software, IT, Marketplace)
 * @param {string} message - User message
 * @param {Object} intent - Resolved intent object
 * @returns {boolean} - True if related to domain
 */
export function isDomainRelated(message, intent) {
  // If we already matched a category or OEM, it's definitely in-domain
  if (intent.subCategoryId || intent.oemId) return true;

  const text = (message || "").toLowerCase();

  // High-confidence tech/marketplace keywords
  const techKeywords = [
    'software', 'license', 'subscription', 'price', 'plan', 'billing',
    'microsoft', 'google', 'aws', 'azure', 'cloud', 'security',
    'teams', 'office', 'defender', 'sql', 'database', 'server',
    'marketplace', 'buy', 'purchase', 'trial', 'download', 'install',
    'it services', 'enterprise', 'saas', 'crm', 'erp',
    'categories', 'oems', 'best selling', 'best sellers', 'featured', 'browse',
    'compare', 'comparison', 'options', 'details', 'pricing', 'features', 'show', 'see'
  ];

  if (techKeywords.some(k => text.includes(k))) return true;

  // Very common "intro" questions that are about the bot itself
  const botKeywords = ['what can you do', 'who are you', 'how do you work', 'help me', 'products'];
  if (botKeywords.some(k => text.includes(k))) return true;

  return false;
}

/**
 * Checks if the message is a simple greeting
 * @param {string} message 
 * @returns {boolean}
 */
export function isGreeting(message) {
  const text = (message || "").toLowerCase().trim();
  const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'hola'];
  return greetings.some(g => text === g || text.startsWith(g + ' '));
}
