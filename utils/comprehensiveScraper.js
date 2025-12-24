import { makeRequest } from "./httpClient.js";
import * as cheerio from "cheerio";

// Cache for comprehensive website data
let comprehensiveCache = {
  data: null,
  lastFetch: null,
  ttl: 24 * 60 * 60 * 1000, // 24 hour cache (longer to avoid re-scraping)
};

/**
 * Comprehensive web scraper that crawls ALL pages of the website
 * Similar to how Amazon's Rufus works
 */
export async function scrapeEntireWebsite(baseUrl = "https://shop.skysecure.ai/") {
  // Check cache
  const now = Date.now();
  if (comprehensiveCache.data && comprehensiveCache.lastFetch && 
      (now - comprehensiveCache.lastFetch) < comprehensiveCache.ttl) {
    console.log("Using cached comprehensive website data");
    return comprehensiveCache.data;
  }

  console.log("Starting comprehensive website crawl...");
  const visitedUrls = new Set();
  const allContent = [];
  const urlsToVisit = [baseUrl];
  const maxPages = 50; // Reduced from 200 to prevent timeouts
  let pagesScraped = 0;

  // Normalize URL
  const normalizeUrl = (url) => {
    try {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      if (url.startsWith('//')) return `https:${url}`;
      if (url.startsWith('/')) return new URL(url, baseUrl).href;
      return new URL(url, baseUrl).href;
    } catch {
      return null;
    }
  };

  // Check if URL should be scraped
  const shouldScrape = (url) => {
    if (!url) return false;
    const normalized = normalizeUrl(url);
    if (!normalized) return false;
    
    // Only scrape same domain
    try {
      const urlObj = new URL(normalized);
      const baseObj = new URL(baseUrl);
      if (urlObj.hostname !== baseObj.hostname) return false;
    } catch {
      return false;
    }

    // Skip certain file types
    const skipExtensions = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.css', '.js', '.json', '.xml'];
    if (skipExtensions.some(ext => normalized.toLowerCase().endsWith(ext))) return false;

    // Skip fragments and query params for same page
    const urlWithoutParams = normalized.split('#')[0].split('?')[0];
    if (visitedUrls.has(urlWithoutParams)) return false;

    return true;
  };

  // Extract all links from a page
  const extractLinks = (html, currentUrl) => {
    const $ = cheerio.load(html);
    const links = new Set();

    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        const normalized = normalizeUrl(href);
        if (normalized && shouldScrape(normalized)) {
          links.add(normalized.split('#')[0].split('?')[0]); // Remove fragments and query params
        }
      }
    });

    return Array.from(links);
  };

  // Scrape a single page comprehensively
  const scrapePageComprehensive = async (url) => {
    try {
      const response = await makeRequest(url, {
        timeout: 20000,
      });

      if (!response.ok) {
        return null;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      const pageData = {
        url: url,
        title: $('title').text().trim(),
        metaDescription: $('meta[name="description"]').attr('content') || '',
        headings: [],
        paragraphs: [],
        lists: [],
        products: [],
        links: [],
        structuredData: {},
      };

      // Extract all headings
      $('h1, h2, h3, h4, h5, h6').each((i, elem) => {
        const text = $(elem).text().trim();
        const level = elem.tagName.toLowerCase();
        if (text) {
          pageData.headings.push({ level, text });
        }
      });

      // Extract all paragraphs
      $('p').each((i, elem) => {
        const text = $(elem).text().trim();
        if (text && text.length > 20) {
          pageData.paragraphs.push(text);
        }
      });

      // Extract all list items
      $('ul li, ol li').each((i, elem) => {
        const text = $(elem).text().trim();
        if (text && text.length > 10) {
          pageData.lists.push(text);
        }
      });

      // Extract product information (comprehensive)
      $('[class*="product"], [id*="product"], [class*="Product"], [id*="Product"], [data-product], [data-product-id]').each((i, elem) => {
        const productInfo = {
          name: $(elem).find('h1, h2, h3, h4, [class*="name"], [class*="title"]').first().text().trim(),
          price: $(elem).find('[class*="price"], [class*="Price"]').text().trim(),
          description: $(elem).find('[class*="description"], [class*="desc"], p').first().text().trim(),
          image: $(elem).find('img').attr('src') || '',
          fullText: $(elem).text().trim(),
        };
        
        if (productInfo.fullText && productInfo.fullText.length > 30) {
          pageData.products.push(productInfo);
        }
      });

      // Extract structured data (JSON-LD, microdata)
      $('script[type="application/ld+json"]').each((i, elem) => {
        try {
          const jsonData = JSON.parse($(elem).html());
          pageData.structuredData = { ...pageData.structuredData, ...jsonData };
        } catch (e) {
          // Ignore parse errors
        }
      });

      // Extract links for crawling
      pageData.links = extractLinks(html, url);

      // Format page content for knowledge base
      let formattedContent = `\n=== PAGE: ${url} ===\n`;
      formattedContent += `Title: ${pageData.title}\n`;
      if (pageData.metaDescription) {
        formattedContent += `Description: ${pageData.metaDescription}\n`;
      }

      if (pageData.headings.length > 0) {
        formattedContent += `\nHeadings:\n`;
        pageData.headings.forEach(h => {
          formattedContent += `${h.level.toUpperCase()}: ${h.text}\n`;
        });
      }

      if (pageData.products.length > 0) {
        formattedContent += `\nProducts Found (${pageData.products.length}):\n`;
        pageData.products.forEach((product, idx) => {
          formattedContent += `Product ${idx + 1}:\n`;
          if (product.name) formattedContent += `  Name: ${product.name}\n`;
          if (product.price) formattedContent += `  Price: ${product.price}\n`;
          if (product.description) formattedContent += `  Description: ${product.description.substring(0, 150)}...\n`;
          formattedContent += `  Full Info: ${product.fullText.substring(0, 200)}...\n\n`;
        });
      }

      if (pageData.paragraphs.length > 0) {
        formattedContent += `\nContent:\n`;
        pageData.paragraphs.slice(0, 20).forEach(p => {
          formattedContent += `${p}\n`;
        });
      }

      if (pageData.lists.length > 0) {
        formattedContent += `\nLists:\n`;
        pageData.lists.slice(0, 30).forEach(item => {
          formattedContent += `- ${item}\n`;
        });
      }

      formattedContent += `\n=== END PAGE ===\n`;

      return {
        content: formattedContent,
        links: pageData.links,
        pageData: pageData,
      };
    } catch (error) {
      console.error(`Error scraping ${url}:`, error.message);
      return null;
    }
  };

  // Main crawling loop
  while (urlsToVisit.length > 0 && pagesScraped < maxPages) {
    const currentUrl = urlsToVisit.shift();
    const urlWithoutParams = currentUrl.split('#')[0].split('?')[0];

    if (visitedUrls.has(urlWithoutParams)) {
      continue;
    }

    visitedUrls.add(urlWithoutParams);
    pagesScraped++;

    console.log(`[${pagesScraped}/${maxPages}] Scraping: ${currentUrl}`);

    const result = await scrapePageComprehensive(currentUrl);

    if (result) {
      allContent.push(result.content);

      // Add new links to queue
      result.links.forEach(link => {
        const normalized = normalizeUrl(link);
        if (normalized && !visitedUrls.has(normalized.split('#')[0].split('?')[0])) {
          urlsToVisit.push(normalized);
        }
      });
    }

    // Small delay to be respectful
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const combinedContent = allContent.join('\n\n');
  console.log(`\nCrawl complete! Scraped ${pagesScraped} pages, ${visitedUrls.size} unique URLs`);
  console.log(`Total content length: ${combinedContent.length} characters`);

  // Update cache
  comprehensiveCache.data = combinedContent;
  comprehensiveCache.lastFetch = now;

  return combinedContent;
}

