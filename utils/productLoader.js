import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads products from products_normalized.json file
 * @returns {Promise<Array>} - Array of product objects
 */
export async function loadProductsFromJSON() {
  try {
    const jsonPath = path.join(__dirname, 'data', 'products_normalized.json');
    console.log(`Loading products from: ${jsonPath}`);
    
    const fileContent = fs.readFileSync(jsonPath, 'utf-8');
    const products = JSON.parse(fileContent);
    
    console.log(`✅ Loaded ${products.length} products from JSON file`);
    
    // Convert JSON format to expected format for the system
    return products.map(product => ({
      id: product.id,
      _id: product.id,
      name: product.name,
      category: product.category || 'Uncategorized',
      subCategory: product.category || 'General', // Use category as subCategory if not specified
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
  // Try to extract from name or description
  const name = (product.name || '').toLowerCase();
  const desc = (product.description?.raw || product.description?.clean || '').toLowerCase();
  
  // Common vendors
  const vendors = ['microsoft', 'google', 'adobe', 'oracle', 'intel', 'aws', 'azure', 'vmware', 'cisco'];
  for (const vendor of vendors) {
    if (name.includes(vendor) || desc.includes(vendor)) {
      return vendor.charAt(0).toUpperCase() + vendor.slice(1);
    }
  }
  
  return 'Unknown Vendor';
}

/**
 * Gets price from product
 */
function getPrice(product) {
  if (product.pricing) {
    if (product.pricing.yearly) return product.pricing.yearly;
    if (product.pricing.monthly) return product.pricing.monthly;
    if (product.pricing.oneTime) return product.pricing.oneTime;
  }
  return 0;
}

/**
 * Gets billing cycle from product
 */
function getBillingCycle(product) {
  if (product.pricing) {
    if (product.pricing.yearly) return 'Yearly';
    if (product.pricing.monthly) return 'Monthly';
    if (product.pricing.oneTime) return 'One Time';
  }
  if (product.defaultPlan) {
    if (product.defaultPlan === 'yearly') return 'Yearly';
    if (product.defaultPlan === 'monthly') return 'Monthly';
    if (product.defaultPlan === 'oneTime') return 'One Time';
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
    
    if (product.price > 0) {
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
      chunk += `URL: ${product.url}\n`;
    }
    
    // Add full product name for better searchability
    chunk += `\nFull Product Name: ${product.name}`;
    
    chunks.push(chunk);
  });
  
  return chunks;
}

