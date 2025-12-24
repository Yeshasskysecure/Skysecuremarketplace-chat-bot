/**
 * Extracts product names from website scraped content and matches them with products
 * This is a fallback when API doesn't return best selling/recently added flags
 */

/**
 * Extracts product names from scraped website content for best selling section
 * @param {string} websiteContent - Scraped website content
 * @returns {Array<string>} - Array of product names found in best selling section
 */
export function extractBestSellingProductsFromWebsite(websiteContent) {
  if (!websiteContent) {
    console.log("No website content provided for best selling extraction");
    return [];
  }

  const productNames = [];
  const lines = websiteContent.split('\n');
  
  console.log(`Extracting best selling products from ${lines.length} lines of content`);

  // Strategy 1: Look for "Best Selling" section and extract from it
  let bestSellingSectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    
    // Detect best selling section
    if (line.includes('best selling') || line.includes('bestselling') || line.includes('top selling')) {
      bestSellingSectionStart = i;
      console.log(`Found "Best Selling" section at line ${i}`);
      
      // Extract product names from next 200 lines (very expanded range)
      for (let j = i + 1; j < Math.min(i + 200, lines.length); j++) {
        const productLine = lines[j];
        const lowerLine = productLine.toLowerCase();
        
        // Skip if it's still part of the section header
        if (lowerLine.includes('best selling') && lowerLine.length < 50) continue;
        
        // Look for "Best Selling Product Name:" prefix
        if (productLine.includes('Best Selling Product Name:')) {
          const name = productLine.split('Best Selling Product Name:')[1]?.trim();
          if (name && name.length > 10 && name.length < 200) {
            if (!productNames.includes(name)) {
              productNames.push(name);
              console.log(`Found product name from prefix: ${name}`);
            }
          }
        }
        
        // Look for "Best Selling Product:" prefix
        if (productLine.includes('Best Selling Product:')) {
          const name = productLine.split('Best Selling Product:')[1]?.trim();
          if (name && name.length > 10 && name.length < 200) {
            if (!productNames.includes(name)) {
              productNames.push(name);
              console.log(`Found product name from prefix: ${name}`);
            }
          }
        }
        
        // Look for Microsoft product patterns in any line
        if (productLine.includes('Microsoft') && productLine.length > 15 && productLine.length < 250) {
          // Extract product name - multiple patterns
          const patterns = [
            /Microsoft\s+365\s+E[35]\s+[A-Z0-9\s\(\)]+/i,  // Microsoft 365 E3/E5 with details
            /Microsoft\s+365\s+[A-Z0-9\s\(\)]+/i,         // Microsoft 365 anything
            /Microsoft\s+Copilot\s+[A-Z\s]+/i,            // Microsoft Copilot
            /Microsoft\s+[\d\w\s\(\)]+/i,                // Any Microsoft product
          ];
          
          for (const pattern of patterns) {
            const match = productLine.match(pattern);
            if (match) {
              let productName = match[0].trim();
              // Clean up the name - remove common suffixes that aren't part of the name
              productName = productName.replace(/\s+(Monthly|Yearly|One Time|\/.*)$/i, '').trim();
              
              if (productName.length > 10 && productName.length < 150 && !productNames.includes(productName)) {
                productNames.push(productName);
                console.log(`Found product name from pattern: ${productName}`);
                break; // Found a match, move to next line
              }
            }
          }
        }
        
        // Look for product card text and extract names from it
        if (productLine.includes('Best Selling Product Card:')) {
          const cardText = productLine.split('Best Selling Product Card:')[1]?.trim();
          if (cardText) {
            // Try multiple extraction patterns
            const patterns = [
              /Microsoft\s+365\s+E[35]\s+[A-Z0-9\s\(\)]+/i,
              /Microsoft\s+365\s+[A-Z0-9\s\(\)]+/i,
              /Microsoft\s+[\d\w\s\(\)]+/i,
            ];
            
            for (const pattern of patterns) {
              const nameMatch = cardText.match(pattern);
              if (nameMatch) {
                let productName = nameMatch[0].trim();
                productName = productName.replace(/\s+(Monthly|Yearly|One Time|\/.*)$/i, '').trim();
                
                if (productName.length > 10 && productName.length < 150 && !productNames.includes(productName)) {
                  productNames.push(productName);
                  console.log(`Found product name from card: ${productName}`);
                  break;
                }
              }
            }
          }
        }
      }
      break; // Found the section, stop looking
    }
  }

  // Strategy 2: If no products found, extract from "BEST SELLING FULL TEXT SECTION"
  if (productNames.length === 0) {
    console.log("No products found in structured section, trying full text section...");
    const fullTextSection = websiteContent.match(/BEST SELLING FULL TEXT SECTION:([\s\S]{1,5000})/i);
    if (fullTextSection) {
      const sectionText = fullTextSection[1];
      console.log(`Found full text section, length: ${sectionText.length}`);
      
      // Extract all Microsoft product names from this section
      const patterns = [
        /Microsoft\s+365\s+E[35]\s+[A-Z0-9\s\(\)]+/gi,
        /Microsoft\s+365\s+[A-Z0-9\s\(\)]+/gi,
        /Microsoft\s+[\d\w\s\(\)]+/gi,
      ];
      
      patterns.forEach(pattern => {
        const matches = sectionText.match(pattern);
        if (matches) {
          matches.forEach(match => {
            let productName = match.trim();
            productName = productName.replace(/\s+(Monthly|Yearly|One Time|\/.*)$/i, '').trim();
            
            if (productName.length > 10 && productName.length < 150 && !productNames.includes(productName)) {
              productNames.push(productName);
              console.log(`Found product name from full text: ${productName}`);
            }
          });
        }
      });
    }
  }

  // Strategy 3: Last resort - extract ALL Microsoft products from entire content after "best selling"
  if (productNames.length === 0) {
    console.log("No products found in sections, trying aggressive extraction from entire content...");
    const bestSellingIndex = websiteContent.toLowerCase().indexOf('best selling');
    if (bestSellingIndex !== -1) {
      const afterBestSelling = websiteContent.substring(bestSellingIndex, bestSellingIndex + 10000);
      const patterns = [
        /Microsoft\s+365\s+E[35]\s+[A-Z0-9\s\(\)]+/gi,
        /Microsoft\s+365\s+[A-Z0-9\s\(\)]+/gi,
      ];
      
      patterns.forEach(pattern => {
        const matches = afterBestSelling.match(pattern);
        if (matches) {
          matches.forEach(match => {
            let productName = match.trim();
            productName = productName.replace(/\s+(Monthly|Yearly|One Time|\/.*)$/i, '').trim();
            
            if (productName.length > 10 && productName.length < 150 && !productNames.includes(productName)) {
              productNames.push(productName);
              console.log(`Found product name from aggressive extraction: ${productName}`);
            }
          });
        }
      });
    }
  }

  console.log(`Extracted ${productNames.length} best selling product names from website:`, productNames.slice(0, 10));
  return productNames;
}

/**
 * Extracts product names from scraped website content for recently added section
 * @param {string} websiteContent - Scraped website content
 * @returns {Array<string>} - Array of product names found in recently added section
 */
export function extractRecentlyAddedProductsFromWebsite(websiteContent) {
  if (!websiteContent) return [];

  const productNames = [];
  const lines = websiteContent.split('\n');

  // Look for "Recently Added" or "Recently Added Products" sections
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    
    // Detect recently added section
    if (line.includes('recently added') || line.includes('recently') || line.includes('new products') || line.includes('latest')) {
      // Extract product names from next 100 lines (expanded range)
      for (let j = i + 1; j < Math.min(i + 100, lines.length); j++) {
        const productLine = lines[j];
        const lowerLine = productLine.toLowerCase();
        
        // Skip if it's still part of the section header
        if (lowerLine.includes('recently added') && lowerLine.length < 50) continue;
        
        // Look for "Recently Added Product Name:" prefix
        if (productLine.includes('Recently Added Product Name:')) {
          const name = productLine.split('Recently Added Product Name:')[1]?.trim();
          if (name && name.length > 10 && name.length < 200) {
            if (!productNames.includes(name)) {
              productNames.push(name);
            }
          }
        }
        
        // Look for "Recently Added Product:" prefix
        if (productLine.includes('Recently Added Product:')) {
          const name = productLine.split('Recently Added Product:')[1]?.trim();
          if (name && name.length > 10 && name.length < 200) {
            if (!productNames.includes(name)) {
              productNames.push(name);
            }
          }
        }
        
        // Look for Microsoft/Office product patterns in any line
        if ((productLine.includes('Microsoft') || productLine.includes('Office')) && productLine.length > 15 && productLine.length < 250) {
          // Extract product name - multiple patterns
          const patterns = [
            /Microsoft\s+365\s+E[35]\s+[A-Z0-9\s\(\)]+/i,  // Microsoft 365 E5 Security, E5 Compliance
            /Office\s+LTSC\s+[\w\s]+/i,                     // Office LTSC Professional Plus 2024
            /Microsoft\s+365\s+[A-Z0-9\s\(\)]+/i,         // Microsoft 365 anything
            /Microsoft\s+[\d\w\s\(\)]+/i,                // Any Microsoft product
          ];
          
          for (const pattern of patterns) {
            const match = productLine.match(pattern);
            if (match) {
              let productName = match[0].trim();
              // Clean up the name - remove common suffixes
              productName = productName.replace(/\s+(Monthly|Yearly|One Time|\/.*)$/i, '').trim();
              
              if (productName.length > 10 && productName.length < 150 && !productNames.includes(productName)) {
                productNames.push(productName);
                break; // Found a match, move to next line
              }
            }
          }
        }
        
        // Look for product card text and extract names from it
        if (productLine.includes('Recently Added Product Card:')) {
          const cardText = productLine.split('Recently Added Product Card:')[1]?.trim();
          if (cardText) {
            // Try multiple extraction patterns
            const patterns = [
              /Microsoft\s+365\s+E[35]\s+[A-Z0-9\s\(\)]+/i,
              /Office\s+LTSC\s+[\w\s]+/i,
              /Microsoft\s+365\s+[A-Z0-9\s\(\)]+/i,
              /Microsoft\s+[\d\w\s\(\)]+/i,
            ];
            
            for (const pattern of patterns) {
              const nameMatch = cardText.match(pattern);
              if (nameMatch) {
                let productName = nameMatch[0].trim();
                productName = productName.replace(/\s+(Monthly|Yearly|One Time|\/.*)$/i, '').trim();
                
                if (productName.length > 10 && productName.length < 150 && !productNames.includes(productName)) {
                  productNames.push(productName);
                  break;
                }
              }
            }
          }
        }
      }
      break; // Found the section, stop looking
    }
  }

  console.log(`Extracted ${productNames.length} recently added product names from website:`, productNames.slice(0, 5));
  return productNames;
}

/**
 * Matches product names from website with products in the list
 * Uses fuzzy matching to handle variations
 * @param {Array<string>} productNamesFromWebsite - Product names extracted from website
 * @param {Array} products - Array of product objects
 * @returns {Array<string>} - Array of product IDs that match
 */
export function matchProductsByName(productNamesFromWebsite, products) {
  const matchedIds = [];

  productNamesFromWebsite.forEach(websiteName => {
    // Normalize website name (remove extra spaces, lowercase for comparison)
    const normalizedWebsiteName = websiteName.toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '') // Remove special characters for better matching
      .trim();
    
    products.forEach(product => {
      const productName = (product.name || '').toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s]/g, '') // Remove special characters
        .trim();
      
      if (!productName || productName.length < 5) return;
      
      // Exact match
      if (productName === normalizedWebsiteName) {
        if (!matchedIds.includes(product.id)) {
          matchedIds.push(product.id);
        }
        return;
      }
      
      // Partial match - check if website name contains product name or vice versa
      if (normalizedWebsiteName.includes(productName) || productName.includes(normalizedWebsiteName)) {
        // Make sure it's a significant match (at least 15 characters overlap)
        const overlapLength = Math.min(normalizedWebsiteName.length, productName.length);
        if (overlapLength >= 15) {
          if (!matchedIds.includes(product.id)) {
            matchedIds.push(product.id);
          }
        }
      }
      
      // Check for key words match (e.g., "Microsoft 365 E3" matches "Microsoft 365 E3 (no Teams)")
      const websiteWords = normalizedWebsiteName.split(/\s+/).filter(w => w.length > 2);
      const productWords = productName.split(/\s+/).filter(w => w.length > 2);
      
      if (websiteWords.length >= 3 && productWords.length >= 3) {
        // Check if at least 3 key words match (or 70% of words match)
        const matchingWords = websiteWords.filter(w => productWords.includes(w));
        const matchRatio = matchingWords.length / Math.max(websiteWords.length, productWords.length);
        
        if (matchingWords.length >= 3 || matchRatio >= 0.7) {
          if (!matchedIds.includes(product.id)) {
            matchedIds.push(product.id);
          }
        }
      }
      
      // Special handling for Microsoft products - match by version/edition
      // e.g., "Microsoft 365 E3" matches "Microsoft 365 E3 (no Teams)"
      if (normalizedWebsiteName.includes('microsoft') && productName.includes('microsoft')) {
        // Extract version/edition (E3, E5, Copilot, etc.)
        const websiteVersion = normalizedWebsiteName.match(/\b(e[35]|copilot|office|ltsc)\b/i);
        const productVersion = productName.match(/\b(e[35]|copilot|office|ltsc)\b/i);
        
        if (websiteVersion && productVersion && websiteVersion[0] === productVersion[0]) {
          // Versions match, check if other key words match
          const websiteKeyWords = normalizedWebsiteName.split(/\s+/).filter(w => 
            w.length > 3 && !['microsoft', 'for', 'and', 'the'].includes(w)
          );
          const productKeyWords = productName.split(/\s+/).filter(w => 
            w.length > 3 && !['microsoft', 'for', 'and', 'the'].includes(w)
          );
          
          const matchingKeyWords = websiteKeyWords.filter(w => productKeyWords.includes(w));
          if (matchingKeyWords.length >= 2) {
            if (!matchedIds.includes(product.id)) {
              matchedIds.push(product.id);
            }
          }
        }
      }
    });
  });

  return matchedIds;
}

