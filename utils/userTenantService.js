import { makeRequest } from "./httpClient.js";

// AUTH_SERVICE_URL can be base URL or include /api/auth
// Examples: "http://localhost:3000" or "http://localhost:3000/api/auth" or "https://auth.skysecure.ai"
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://localhost:3002";

/**
 * Constructs the full API URL, handling cases where AUTH_SERVICE_URL may or may not include /api/auth
 * @param {string} endpointPath - The endpoint path (e.g., "/api/auth/users/profile")
 * @returns {string} - Full URL
 */
function constructAuthServiceUrl(endpointPath) {
  // Remove leading slash from endpointPath if present
  const cleanPath = endpointPath.startsWith('/') ? endpointPath.substring(1) : endpointPath;
  
  // Check if AUTH_SERVICE_URL already ends with /api/auth
  if (AUTH_SERVICE_URL.endsWith('/api/auth')) {
    // Base already has /api/auth, so we need to extract just the part after /api/auth
    // endpointPath is like "api/auth/users/profile", so we need just "users/profile"
    // Remove "api/auth/" prefix if it exists
    let pathWithoutPrefix = cleanPath;
    if (cleanPath.startsWith('api/auth/')) {
      pathWithoutPrefix = cleanPath.substring('api/auth/'.length);
    }
    
    // Ensure base URL doesn't have trailing slash
    const baseUrl = AUTH_SERVICE_URL.endsWith('/') 
      ? AUTH_SERVICE_URL.slice(0, -1) 
      : AUTH_SERVICE_URL;
    
    const finalUrl = `${baseUrl}/${pathWithoutPrefix}`;
    console.log(`🔗 URL Construction: ${AUTH_SERVICE_URL} + /${cleanPath} -> ${finalUrl}`);
    return finalUrl;
  } else {
    // Base doesn't have /api/auth, so append the full path
    const baseUrl = AUTH_SERVICE_URL.endsWith('/') 
      ? AUTH_SERVICE_URL.slice(0, -1) 
      : AUTH_SERVICE_URL;
    const finalUrl = `${baseUrl}/${cleanPath}`;
    console.log(`🔗 URL Construction: ${AUTH_SERVICE_URL} + /${cleanPath} -> ${finalUrl}`);
    return finalUrl;
  }
}

/**
 * Attempts to extract userId from JWT token (without verification)
 * This is a fallback when userId is not provided directly
 * @param {string} token - JWT access token
 * @returns {string|null} - User ID from token payload or null
 */
function extractUserIdFromToken(token) {
  try {
    if (!token || typeof token !== 'string') {
      return null;
    }

    // JWT format: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    // Decode payload (second part)
    const payload = parts[1];
    // Add padding if needed for base64 decoding
    const paddedPayload = payload + '='.repeat((4 - payload.length % 4) % 4);
    const decoded = Buffer.from(paddedPayload, 'base64').toString('utf-8');
    const payloadObj = JSON.parse(decoded);

    // Try common JWT payload fields for user ID
    const userId = payloadObj.userId || payloadObj.user_id || payloadObj.sub || payloadObj.id || payloadObj._id || null;
    
    if (userId) {
      console.log(`✅ Extracted userId from token: ${userId}`);
      return userId;
    }
    
    return null;
  } catch (error) {
    console.warn(`⚠️  Could not extract userId from token: ${error.message}`);
    return null;
  }
}

// Cache for user tenant data (per conversation session)
const userTenantCache = new Map();

/**
 * Fetches user tenant data from the auth service
 * @param {string} userId - User ID
 * @param {string} accessToken - User's access token (optional, for authenticated requests)
 * @returns {Promise<Object|null>} - User object with tenant details or null if unavailable
 */
export async function fetchUserTenantData(userId, accessToken = null) {
  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔍 fetchUserTenantData CALLED`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Input - userId: ${userId || 'null'}, accessToken: ${accessToken ? `${accessToken.substring(0, 20)}...` : 'null'}`);
    console.log(`AUTH_SERVICE_URL: ${AUTH_SERVICE_URL}`);

    // Try to extract userId from token if not provided (do this before cache check)
    let finalUserId = userId;
    if (!finalUserId && accessToken) {
      console.log(`⚠️  userId not provided, attempting to extract from accessToken...`);
      finalUserId = extractUserIdFromToken(accessToken);
      if (finalUserId) {
        console.log(`✅ Successfully extracted userId from token`);
      } else {
        console.log(`⚠️  Could not extract userId from token`);
      }
    }

    // Check cache first (cache for 5 minutes) - use finalUserId for cache key
    const cacheKey = finalUserId || 'anonymous';
    const cached = userTenantCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < 5 * 60 * 1000) {
      console.log(`✅ Using cached tenant data for user: ${finalUserId || 'anonymous'}`);
      console.log(`Cached data keys: ${Object.keys(cached.data || {}).join(', ')}`);
      return cached.data;
    }

    if (!finalUserId && !accessToken) {
      console.log(`⚠️  No userId or accessToken provided, skipping tenant data fetch`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }

    let userData = null;

    // Try authenticated endpoint first if accessToken is available
    if (accessToken) {
      try {
        console.log(`\n📡 Attempting authenticated endpoint...`);
        // Construct URL properly (handles both base URL and URL with /api/auth)
        const profileUrl = constructAuthServiceUrl('/api/auth/users/profile');
        console.log(`URL: ${profileUrl}`);
        console.log(`Headers: Authorization: Bearer ${accessToken.substring(0, 20)}...`);
        
        const response = await makeRequest(profileUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        });

        console.log(`Response Status: ${response.status} ${response.statusText}`);
        console.log(`Response OK: ${response.ok}`);

        if (response.ok) {
          const responseData = await response.json();
          console.log(`✅ Successfully fetched user tenant data via authenticated endpoint`);
          console.log(`Response data type: ${typeof responseData}`);
          console.log(`Response data keys: ${Object.keys(responseData || {}).join(', ')}`);
          
          // Handle wrapped response structure: { code, status, message, data }
          // Extract actual user data from responseData.data if it exists
          if (responseData && responseData.data) {
            userData = responseData.data;
            console.log(`✅ Extracted user data from wrapped response`);
            console.log(`User data keys: ${Object.keys(userData || {}).join(', ')}`);
          } else {
            // If no wrapping, use response directly
            userData = responseData;
            console.log(`✅ Using response data directly (no wrapping detected)`);
          }
          
          console.log(`tenantConnected: ${userData?.tenantConnected}`);
          console.log(`tenantDetails present: ${!!userData?.tenantDetails}`);
          if (userData?.tenantDetails) {
            console.log(`tenantDetails keys: ${Object.keys(userData.tenantDetails).join(', ')}`);
            console.log(`subscriptions count: ${userData.tenantDetails?.subscriptions?.length || 0}`);
          }
        } else if (response.status === 401) {
          console.warn(`⚠️  Access token expired or invalid (401), trying alternative endpoint`);
          const errorText = await response.text().catch(() => '');
          console.warn(`Error response: ${errorText.substring(0, 200)}`);
        } else {
          console.warn(`⚠️  Auth service returned status ${response.status}`);
          const errorText = await response.text().catch(() => '');
          console.warn(`Error response: ${errorText.substring(0, 200)}`);
        }
      } catch (error) {
        console.error(`❌ Error fetching via authenticated endpoint: ${error.message}`);
        console.error(`Stack: ${error.stack}`);
        
        // Check if it's a DNS/network error
        if (error.code === 'ENOTFOUND' || error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
          console.error(`⚠️  DNS Error: Cannot resolve ${AUTH_SERVICE_URL}`);
          console.error(`   This usually means:`);
          console.error(`   1. The AUTH_SERVICE_URL is incorrect`);
          console.error(`   2. The auth service is not accessible from this network`);
          console.error(`   3. DNS resolution is failing`);
          console.error(`   Please check your .env file and ensure AUTH_SERVICE_URL is correct`);
        }
      }
    }

    // Fallback to public endpoint if authenticated request failed or no token
    if (!userData && finalUserId) {
      try {
        console.log(`\n📡 Attempting public endpoint (fallback)...`);
        // Construct URL properly (handles both base URL and URL with /api/auth)
        const publicUrl = constructAuthServiceUrl(`/api/auth/users/me/${finalUserId}`);
        console.log(`URL: ${publicUrl}`);
        
        const response = await makeRequest(publicUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        });

        console.log(`Response Status: ${response.status} ${response.statusText}`);
        console.log(`Response OK: ${response.ok}`);

        if (response.ok) {
          const responseData = await response.json();
          console.log(`✅ Successfully fetched user tenant data via public endpoint`);
          console.log(`Response data type: ${typeof responseData}`);
          console.log(`Response data keys: ${Object.keys(responseData || {}).join(', ')}`);
          
          // Handle wrapped response structure: { code, status, message, data }
          // Extract actual user data from responseData.data if it exists
          if (responseData && responseData.data) {
            userData = responseData.data;
            console.log(`✅ Extracted user data from wrapped response`);
            console.log(`User data keys: ${Object.keys(userData || {}).join(', ')}`);
          } else {
            // If no wrapping, use response directly
            userData = responseData;
            console.log(`✅ Using response data directly (no wrapping detected)`);
          }
          
          console.log(`tenantConnected: ${userData?.tenantConnected}`);
          console.log(`tenantDetails present: ${!!userData?.tenantDetails}`);
          if (userData?.tenantDetails) {
            console.log(`tenantDetails keys: ${Object.keys(userData.tenantDetails).join(', ')}`);
            console.log(`subscriptions count: ${userData.tenantDetails?.subscriptions?.length || 0}`);
          }
        } else         if (response.status === 404) {
          console.warn(`⚠️  User not found (404) for userId: ${finalUserId}`);
          const errorText = await response.text().catch(() => '');
          console.warn(`Error response: ${errorText.substring(0, 200)}`);
        } else {
          console.warn(`⚠️  Auth service returned status ${response.status} for userId: ${finalUserId}`);
          const errorText = await response.text().catch(() => '');
          console.warn(`Error response: ${errorText.substring(0, 200)}`);
        }
      } catch (error) {
        console.error(`❌ Error fetching user tenant data: ${error.message}`);
        console.error(`Stack: ${error.stack}`);
        
        // Check if it's a DNS/network error
        if (error.code === 'ENOTFOUND' || error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
          console.error(`⚠️  DNS Error: Cannot resolve ${AUTH_SERVICE_URL}`);
          console.error(`   This usually means:`);
          console.error(`   1. The AUTH_SERVICE_URL is incorrect`);
          console.error(`   2. The auth service is not accessible from this network`);
          console.error(`   3. DNS resolution is failing`);
          console.error(`   Please check your .env file and ensure AUTH_SERVICE_URL is correct`);
        }
      }
    }

    // Update cache (use finalUserId for cache key)
    if (userData) {
      const finalCacheKey = finalUserId || 'anonymous';
      userTenantCache.set(finalCacheKey, {
        data: userData,
        timestamp: Date.now(),
      });
      console.log(`✅ Cached user tenant data for key: ${finalCacheKey}`);
    } else {
      console.log(`⚠️  No user data to cache`);
    }

    console.log(`Returning userData: ${userData ? 'PRESENT' : 'NULL'}`);
    if (userData) {
      console.log(`Final userData structure:`);
      console.log(`  - tenantConnected: ${userData.tenantConnected}`);
      console.log(`  - tenantConnExpiresAt: ${userData.tenantConnExpiresAt || 'null'}`);
      console.log(`  - tenantDetails: ${userData.tenantDetails ? 'PRESENT' : 'MISSING'}`);
      if (userData.tenantDetails) {
        console.log(`    - tenantId: ${userData.tenantDetails.tenantId || 'null'}`);
        console.log(`    - tenantName: ${userData.tenantDetails.tenantName || 'null'}`);
        console.log(`    - subscriptions: ${userData.tenantDetails.subscriptions?.length || 0} items`);
      }
    }
    console.log(`${'='.repeat(80)}\n`);

    return userData;
  } catch (error) {
    console.error(`❌ Error in fetchUserTenantData: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    console.log(`${'='.repeat(80)}\n`);
    return null;
  }
}

/**
 * Formats user tenant subscription data into a readable context string
 * @param {Object} userData - User object from auth service
 * @returns {string} - Formatted context string or empty string if no data
 */
export function formatUserTenantContext(userData) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔍 formatUserTenantContext CALLED`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Input userData: ${userData ? 'PRESENT' : 'NULL'}`);
  
  if (!userData) {
    console.log(`⚠️  No userData provided, returning empty context`);
    console.log(`${'='.repeat(80)}\n`);
    return "";
  }

  console.log(`userData structure:`);
  console.log(`  - tenantConnected: ${userData.tenantConnected}`);
  console.log(`  - tenantConnExpiresAt: ${userData.tenantConnExpiresAt || 'null'}`);
  console.log(`  - tenantDetails: ${userData.tenantDetails ? 'PRESENT' : 'MISSING'}`);

  const contextParts = [];

  // Check if user has connected tenant
  if (!userData.tenantConnected) {
    console.log(`⚠️  User has not connected tenant (tenantConnected: false)`);
    contextParts.push("User has not connected their Microsoft 365 tenant to SkySecure.");
    const result = contextParts.join("\n");
    console.log(`Returning context (${result.length} chars): ${result.substring(0, 100)}...`);
    console.log(`${'='.repeat(80)}\n`);
    return result;
  }

  // Check tenant connection expiration
  if (userData.tenantConnExpiresAt) {
    const expiresAt = new Date(userData.tenantConnExpiresAt);
    const now = new Date();
    if (expiresAt < now) {
      contextParts.push("⚠️ User's tenant connection has expired. They need to reconnect their tenant.");
      return contextParts.join("\n");
    }
  }

  // Get tenant details
  const tenantDetails = userData.tenantDetails;
  if (!tenantDetails) {
    console.log(`⚠️  tenantDetails is missing even though tenantConnected is true`);
    contextParts.push("User has connected their tenant, but tenant details are not available.");
    const result = contextParts.join("\n");
    console.log(`Returning context (${result.length} chars): ${result.substring(0, 100)}...`);
    console.log(`${'='.repeat(80)}\n`);
    return result;
  }

  console.log(`✅ tenantDetails found:`);
  console.log(`  - tenantId: ${tenantDetails.tenantId || 'null'}`);
  console.log(`  - tenantName: ${tenantDetails.tenantName || 'null'}`);
  console.log(`  - subscriptions: ${tenantDetails.subscriptions?.length || 0} items`);

  // Add tenant information
  contextParts.push(`\n=== USER'S MICROSOFT 365 TENANT INFORMATION ===`);
  contextParts.push(`Tenant Name: ${tenantDetails.tenantName || 'N/A'}`);
  contextParts.push(`Tenant ID: ${tenantDetails.tenantId || 'N/A'}`);
  
  if (tenantDetails.connectedAt) {
    const connectedDate = new Date(tenantDetails.connectedAt);
    contextParts.push(`Connected At: ${connectedDate.toLocaleDateString()}`);
  }
  
  if (tenantDetails.lastSyncAt) {
    const lastSyncDate = new Date(tenantDetails.lastSyncAt);
    contextParts.push(`Last Synced: ${lastSyncDate.toLocaleDateString()} ${lastSyncDate.toLocaleTimeString()}`);
  }

  // Add subscription information
  const subscriptions = tenantDetails.subscriptions || [];
  if (subscriptions.length === 0) {
    contextParts.push(`\n⚠️ User has no active subscriptions in their tenant.`);
  } else {
    contextParts.push(`\n=== USER'S ACTIVE SUBSCRIPTIONS (${subscriptions.length} total) ===`);
    
    subscriptions.forEach((subscription, index) => {
      contextParts.push(`\n${index + 1}. ${subscription.friendlyName || subscription.skuPartNumber || 'Unknown Product'}`);
      contextParts.push(`   SKU Part Number: ${subscription.skuPartNumber || 'N/A'}`);
      contextParts.push(`   SKU ID: ${subscription.skuId || 'N/A'}`);
      
      // License counts
      if (subscription.prepaidUnits) {
        const enabled = subscription.prepaidUnits.enabled || 0;
        const suspended = subscription.prepaidUnits.suspended || 0;
        const warning = subscription.prepaidUnits.warning || 0;
        const consumed = subscription.consumedUnits || 0;
        const available = enabled - consumed;
        
        contextParts.push(`   License Status:`);
        contextParts.push(`     - Total Enabled: ${enabled}`);
        contextParts.push(`     - Consumed: ${consumed}`);
        contextParts.push(`     - Available: ${available}`);
        if (suspended > 0) {
          contextParts.push(`     - Suspended: ${suspended}`);
        }
        if (warning > 0) {
          contextParts.push(`     - Warning: ${warning}`);
        }
      }
      
      // Capability status
      if (subscription.capabilityStatus) {
        contextParts.push(`   Capability Status: ${subscription.capabilityStatus}`);
      }
      
      // Applies to
      if (subscription.appliesTo) {
        contextParts.push(`   Applies To: ${subscription.appliesTo}`);
      }
      
      // Last updated
      if (subscription.lastUpdated) {
        const lastUpdated = new Date(subscription.lastUpdated);
        contextParts.push(`   Last Updated: ${lastUpdated.toLocaleDateString()}`);
      }
    });
  }

  contextParts.push(`\n=== END USER TENANT INFORMATION ===\n`);

  const result = contextParts.join("\n");
  console.log(`✅ Formatted context created (${result.length} characters)`);
  console.log(`Context preview (first 500 chars):\n${result.substring(0, 500)}...`);
  console.log(`${'='.repeat(80)}\n`);
  return result;
}

/**
 * Gets formatted user tenant context for chatbot
 * @param {string} userId - User ID
 * @param {string} accessToken - User's access token (optional)
 * @returns {Promise<string>} - Formatted context string
 */
export async function getUserTenantContext(userId, accessToken = null) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔍 getUserTenantContext CALLED`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Input - userId: ${userId || 'null'}, accessToken: ${accessToken ? 'PRESENT' : 'null'}`);
  
  try {
    const userData = await fetchUserTenantData(userId, accessToken);
    console.log(`fetchUserTenantData returned: ${userData ? 'DATA' : 'NULL'}`);
    
    const context = formatUserTenantContext(userData);
    console.log(`formatUserTenantContext returned: ${context ? `${context.length} chars` : 'EMPTY'}`);
    console.log(`${'='.repeat(80)}\n`);
    
    return context;
  } catch (error) {
    console.error(`❌ Error getting user tenant context: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    console.log(`${'='.repeat(80)}\n`);
    return "";
  }
}

/**
 * Clears the cache for a specific user (useful when user reconnects tenant)
 * @param {string} userId - User ID
 */
export function clearUserTenantCache(userId) {
  if (userId) {
    userTenantCache.delete(userId);
    console.log(`Cleared tenant cache for user: ${userId}`);
  }
}

/**
 * Clears all cached tenant data (useful for testing or cache invalidation)
 */
export function clearAllTenantCache() {
  userTenantCache.clear();
  console.log("Cleared all tenant cache");
}

