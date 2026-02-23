import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache for loaded products
let productCache = null;

/**
 * Loads products from products_normalized.json file
 * @returns {Promise<Array>} - Array of product objects
 */
export async function loadProductsFromJSON() {
  try {
    // Return cached data if available
    if (productCache) {
      console.log("Using cached products from memory");
      return productCache;
    }

    const jsonPath = path.join(__dirname, 'data', 'products_normalized.json');
    console.log(`Loading products from: ${jsonPath}`);

    const fileContent = fs.readFileSync(jsonPath, 'utf-8');
    const products = JSON.parse(fileContent);

    console.log(`✅ Loaded ${products.length} products from JSON file`);

    // Convert JSON format to expected format for the system
    productCache = products.map(product => ({
      id: product.id,
      _id: product.id,
      name: product.name,
      category: product.category || 'Uncategorized',
      subCategory: product.subCategory || (product.category !== 'Software' ? product.category : 'General'),
      subSubCategory: product.subSubCategory || (product.subCategory !== product.category ? product.subCategory : null),
      vendor: extractVendorFromProduct(product),
      price: getPrice(product),
      billingCycle: getBillingCycle(product),
      description: product.description?.clean || product.description?.raw || '',
      descriptionRaw: product.description?.raw || '',
      url: product.url || '',
      features: product.features || [],
      pricing: product.pricing || {},
      currency: product.currency || 'INR',
      isFeatured: false,
      isTopSelling: false,
      isLatest: false,
      // Store full product data for semantic search
      _fullData: product
    }));

    return productCache;
  } catch (error) {
    console.error("Error loading products from JSON:", error.message);
    console.error("Stack:", error.stack);
    return [];
  }
}

/**
 * Extracts vendor/OEM from product data
 */
function extractVendorFromProduct(product) {
  // 1. Try to extract from raw priceText (most accurate if available from scraper)
  if (product.raw && product.raw.priceText) {
    const lines = product.raw.priceText.split('\n');
    // Usually line 4 (index 4) is the vendor in the standard layout
    // Home > Software > Category > Name > Vendor
    if (lines.length > 5) {
      const potentialVendor = lines[4].trim();
      const ignoredLines = ['home', 'software', 'category', 'in stock', 'out of stock', 'add to cart', 'buy now'];
      if (potentialVendor && !ignoredLines.includes(potentialVendor.toLowerCase()) && potentialVendor.length < 50) {
        return potentialVendor;
      }
    }
  }

  // 2. Keyword matching from name/description (STRICT WHOLE WORD)
  const name = (product.name || '').toLowerCase();
  const desc = (product.description?.raw || product.description?.clean || '').toLowerCase();
  const searchableText = `${name} ${desc}`;

  // Prioritize Microsoft and specific product brands first
  const vendorMap = {
    'microsoft': 'Microsoft',
    'dynamics': 'Microsoft',
    'office 365': 'Microsoft',
    'azure': 'Microsoft',
    'office': 'Microsoft',
    'windows': 'Microsoft',
    'exchange': 'Microsoft',
    'sql server': 'Microsoft',
    'skype': 'Microsoft',
    'sharepoint': 'Microsoft',
    'biztalk': 'Microsoft',
    'intune': 'Microsoft',
    'defender': 'Microsoft',
    'teams': 'Microsoft',
    'copilot': 'Microsoft',
    'power bi': 'Microsoft',
    'power automate': 'Microsoft',
    'power apps': 'Microsoft',
    'power pages': 'Microsoft',
    'power platform': 'Microsoft',
    'esu for sql': 'Microsoft',
    'esu for windows': 'Microsoft',
    'win server': 'Microsoft',
    'google': 'Google',
    'adobe': 'Adobe',
    'oracle': 'Oracle',
    'intel': 'Intel',
    'aws': 'AWS',
    'amazon web services': 'AWS',
    'vmware': 'VMware',
    'cisco': 'Cisco',
    'sophos': 'Sophos',
    'tally': 'Tally',
    'kaspersky': 'Kaspersky',
    'bitdefender': 'Bitdefender',
    'autodesk': 'Autodesk',
    'veeam': 'Veeam',
    'veritas': 'Veritas',
    'acronis': 'Acronis',
    'trend micro': 'Trend Micro',
    'symantec': 'Symantec',
    'mcafee': 'McAfee',
    'skysecure': 'SkySecure',
    'crowdstrike': 'CrowdStrike',
    'sentinelone': 'SentinelOne',
    'fortinet': 'Fortinet',
    'palo alto': 'Palo Alto Networks',
    'checkpoint': 'Check Point',
    'zscaler': 'Zscaler',
    'okta': 'Okta',
    'sailpoint': 'SailPoint',
    'cyberark': 'CyberArk',
    'netapp': 'NetApp',
    'dell': 'Dell',
    'hp': 'HP',
    'lenovo': 'Lenovo',
    'ibm': 'IBM',
    'red hat': 'Red Hat',
    'ubuntu': 'Canonical',
    'suse': 'SUSE',
    'zoom': 'Zoom',
    'slack': 'Slack',
    'atlassian': 'Atlassian',
    'jira': 'Atlassian',
    'confluence': 'Atlassian',
    'salesforce': 'Salesforce',
    'sap': 'SAP',
    'servicenow': 'ServiceNow',
    'workday': 'Workday',
    'dropbox': 'Dropbox',
    'box': 'Box',
    'docusign': 'DocuSign'
  };

  for (const [key, value] of Object.entries(vendorMap)) {
    // Whole-word regex to avoid "Intelligence" matching "Intel"
    const regex = new RegExp(`\\b${key}\\b`, 'i');
    if (regex.test(searchableText)) {
      return value;
    }
  }

  return 'Microsoft'; // Default to Microsoft for SkySecure Marketplace
}

/**
 * Gets price from product
 */
function getPrice(product) {
  if (product.pricing) {
    const p = product.pricing;
    // Ignore emoji junk key (🔗) and return first real numeric price
    if (p.triennial && p.triennial > 0) return p.triennial;
    if (p.yearly && p.yearly > 0) return p.yearly;
    if (p.monthly && p.monthly > 0) return p.monthly;
    const oneTime = p.oneTime || p['one time'] || p['one-time'];
    if (oneTime && oneTime > 0) return oneTime;
  }
  return 0;
}

/**
 * Gets billing cycle from product
 */
function getBillingCycle(product) {
  if (product.pricing) {
    const p = product.pricing;
    // Ignore emoji junk key (🔗)
    if (p.triennial && p.triennial > 0) return '3 Years';
    if (p.yearly && p.yearly > 0) return 'Yearly';
    if (p.monthly && p.monthly > 0) return 'Monthly';
    const oneTime = p.oneTime || p['one time'] || p['one-time'];
    if (oneTime && oneTime > 0) return 'One Time';
  }
  if (product.defaultPlan) {
    const dp = product.defaultPlan.toLowerCase();
    if (dp === 'triennial') return '3 Years';
    if (dp === 'yearly') return 'Yearly';
    if (dp === 'monthly') return 'Monthly';
    if (dp === 'one time' || dp === 'one-time' || dp === 'onetime') return 'One Time';
  }
  if (product.raw?.subscriptionHint) {
    return product.raw.subscriptionHint;
  }
  return 'Monthly';
}

/**
 * Converts products to searchable text chunks for semantic search
 * @param {Array} products - Array of product objects
 * @returns {Array<string>} - Array of text chunks
 */
export function productsToTextChunks(products) {
  const chunks = [];

  products.forEach((product, index) => {
    // Create a comprehensive text chunk for each product
    let chunk = `Product: ${product.name}\n`;

    if (product.category) {
      chunk += `Category: ${product.category}\n`;
    }

    if (product.subCategory) {
      chunk += `SubCategory: ${product.subCategory}\n`;
    }

    if (product.vendor) {
      chunk += `Vendor: ${product.vendor}\n`;
    }

    // Include all pricing options
    if (product.pricing && Object.keys(product.pricing).length > 0) {
      const prices = [];
      if (product.pricing.monthly) prices.push(`₹${product.pricing.monthly.toLocaleString('en-IN')} / Monthly`);
      if (product.pricing.yearly) prices.push(`₹${product.pricing.yearly.toLocaleString('en-IN')} / Yearly`);

      const isTriennial = product.pricing.triennial ||
        (product.pricing.oneTime &&
          ((product.name && product.name.toLowerCase().includes("3 year")) ||
            (product.subscriptionHint && product.subscriptionHint.toLowerCase().includes("3 year")) ||
            (product.raw && product.raw.subscriptionHint && product.raw.subscriptionHint.toLowerCase().includes("3 year")) ||
            (product.billingCycle && product.billingCycle.toLowerCase().includes("3 year"))));

      if (product.pricing.triennial) {
        prices.push(`₹${product.pricing.triennial.toLocaleString('en-IN')} / 3 Years`);
      } else if (isTriennial && product.pricing.oneTime) {
        prices.push(`₹${product.pricing.oneTime.toLocaleString('en-IN')} / 3 Years`);
      } else if (product.pricing.oneTime) {
        prices.push(`₹${product.pricing.oneTime.toLocaleString('en-IN')} / One Time`);
      }

      if (prices.length > 0) {
        chunk += `Pricing: ${prices.join(' | ')}\n`;
      }
    } else if (product.price > 0) {
      chunk += `Price: ₹${product.price.toLocaleString('en-IN')} / ${product.billingCycle}\n`;
    }

    if (product.description) {
      // Use clean description if available, otherwise raw
      const desc = product.description.length > 500
        ? product.description.substring(0, 500) + '...'
        : product.description;
      chunk += `Description: ${desc}\n`;
    }

    if (product.features && product.features.length > 0) {
      chunk += `Features: ${product.features.join(', ')}\n`;
    }

    if (product.url) {
      chunk += `Link: ${product.url}\n`;
    }

    // Add full product name for better searchability
    chunk += `\nFull Product Name: ${product.name}`;

    chunks.push(chunk);
  });

  return chunks;
}


