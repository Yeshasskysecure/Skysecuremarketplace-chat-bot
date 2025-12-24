import * as cheerio from "cheerio";
import { makeRequest } from "./httpClient.js";

/**
 * Fetches and extracts content from the SkySecure website
 * @param {string} url - The URL to fetch content from
 * @returns {Promise<string>} - Extracted text content from the website
 */
export async function fetchWebsiteContent(url) {
  try {
    const response = await makeRequest(url, {
      timeout: 10000,
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove script and style elements
    $("script, style, nav, footer").remove();

    // Extract text from main content areas
    const content = [];

    // Get page title
    const title = $("title").text().trim();
    if (title) {
      content.push(`Page Title: ${title}`);
    }

    // Get headings
    $("h1, h2, h3, h4, h5, h6").each((i, elem) => {
      const text = $(elem).text().trim();
      if (text) {
        content.push(text);
      }
    });

    // Get paragraph text
    $("p").each((i, elem) => {
      const text = $(elem).text().trim();
      if (text && text.length > 20) {
        content.push(text);
      }
    });

    // Get list items
    $("li").each((i, elem) => {
      const text = $(elem).text().trim();
      if (text && text.length > 10) {
        content.push(`- ${text}`);
      }
    });

    // Get product information if available
    $("[class*='product'], [id*='product']").each((i, elem) => {
      const text = $(elem).text().trim();
      if (text && text.length > 20) {
        content.push(text);
      }
    });

    // Clean and format the content
    let knowledgeBase = content
      .filter((text) => text.length > 0)
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();

    // Limit content size to avoid token limits (keep first 5000 characters)
    if (knowledgeBase.length > 5000) {
      knowledgeBase = knowledgeBase.substring(0, 5000) + "...";
    }

    return knowledgeBase || "SkySecure Marketplace offers various security products and services.";
  } catch (error) {
    console.error("Error fetching website content:", error.message);
    // Return a fallback knowledge base
    return `SkySecure Marketplace is an online platform offering security products and services. 
    The website includes information about:
    - Featured Products
    - Best Selling items
    - Recently Added products
    - Software products
    - Company information and support
    
    For specific product details or inquiries, users can browse categories, compare products, and contact support.`;
  }
}

