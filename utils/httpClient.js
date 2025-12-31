import https from 'https';
import http from 'http';
import { URL } from 'url';

/**
 * Simple HTTP client using Node's built-in modules
 * Includes retry logic for ECONNRESET and transient errors
 */
export async function makeRequest(url, options = {}, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        const requestTimeout = options.timeout || 30000;

        const requestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: options.method || 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Connection': 'close', // Explicitly close to avoid ECONNRESET from pool cleanup
            ...options.headers,
          },
          timeout: requestTimeout,
        };

        const req = client.request(requestOptions, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            const response = {
              status: res.statusCode,
              statusText: res.statusMessage,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              headers: res.headers,
              text: () => Promise.resolve(data),
              json: () => {
                try {
                  return Promise.resolve(JSON.parse(data));
                } catch (e) {
                  return Promise.reject(new Error(`Invalid JSON response: ${data.substring(0, 100)}...`));
                }
              },
            };
            resolve(response);
          });
        });

        req.on('error', (error) => {
          reject(error);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });

        if (options.body) {
          req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }

        req.end();
      });
    } catch (error) {
      lastError = error;
      const shouldRetry = error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.message === 'Request timeout';

      if (shouldRetry && i < retries - 1) {
        const delay = Math.pow(2, i) * 1000;
        console.warn(`⚠️ Request failed (${error.code || error.message}). Retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
}


