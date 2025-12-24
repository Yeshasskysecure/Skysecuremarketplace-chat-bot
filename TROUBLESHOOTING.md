# Troubleshooting CORS Issues

## Common CORS Error: "No 'Access-Control-Allow-Origin' header is present"

This error typically means one of the following:

### 1. Server is Not Running
**Symptom**: Network error or connection refused

**Solution**:
- Make sure the backend server is running:
  ```bash
  cd backend
  npm start
  ```
- You should see: `Chatbot backend server running on port 3001`

### 2. Dev Tunnel Not Configured Properly
**Symptom**: Can't reach the server through the dev tunnel URL

**Solution**:
- Verify your dev tunnel is forwarding port 3001
- Check that the tunnel URL matches: `https://j6pgw21g-3001.inc1.devtunnels.ms`
- Test the health endpoint: `https://j6pgw21g-3001.inc1.devtunnels.ms/health`

### 3. Server Not Listening on All Interfaces
**Symptom**: Server runs but dev tunnel can't connect

**Solution**:
- The server should be configured to listen on `0.0.0.0` (already done in server.js)
- Restart the server after any changes

### 4. Missing .env File
**Symptom**: Server starts but shows configuration errors

**Solution**:
- Create a `.env` file in the `backend` folder with:
  ```
  PORT=3001
  AZURE_OPENAI_ENDPOINT=https://engineeringteamopenai.openai.azure.com/
  AZURE_OPENAI_API_KEY=your_key_here
  AZURE_AI_AGENT_MODEL_DEPLOYMENT_NAME=gpt-4o
  KNOWLEDGE_BASE_URL=https://shop.skysecure.ai/
  ```

## Testing the Server

### Test 1: Local Health Check
```bash
curl http://localhost:3001/health
```
Should return: `{"status":"ok","message":"Chatbot backend is running"}`

### Test 2: Test Server Script
```bash
cd backend
node test-server.js
```
This will test all endpoints and CORS configuration.

### Test 3: Browser Test
Open in browser: `https://j6pgw21g-3001.inc1.devtunnels.ms/health`

Should see: `{"status":"ok","message":"Chatbot backend is running"}`

### Test 4: CORS Preflight Test
Use browser DevTools Network tab to check:
1. OPTIONS request to `/api/chat` should return 200
2. Response headers should include `Access-Control-Allow-Origin: *`

## Debugging Steps

1. **Check if server is running**:
   ```bash
   # In backend folder
   npm start
   ```

2. **Check server logs**:
   - You should see request logs: `2024-XX-XX - POST /api/chat`
   - If you don't see logs, requests aren't reaching the server

3. **Test locally first**:
   - Test with `http://localhost:3001/api/chat` before using dev tunnel
   - If local works but tunnel doesn't, it's a tunnel configuration issue

4. **Check browser console**:
   - Look for the exact error message
   - Check Network tab to see the actual request/response

5. **Verify .env file exists**:
   - File should be in `backend/.env`
   - Check that all variables are set correctly

## Quick Fix Checklist

- [ ] Backend server is running (`npm start` in backend folder)
- [ ] `.env` file exists with correct credentials
- [ ] Dev tunnel is running and forwarding port 3001
- [ ] Server logs show incoming requests
- [ ] Health endpoint works: `https://j6pgw21g-3001.inc1.devtunnels.ms/health`
- [ ] CORS headers are present in response (check Network tab)

## Still Having Issues?

1. **Restart everything**:
   - Stop the backend server (Ctrl+C)
   - Restart: `npm start`
   - Refresh your frontend

2. **Check the exact error**:
   - Open browser DevTools → Network tab
   - Try sending a message
   - Look at the failed request details

3. **Verify URL**:
   - Make sure the frontend is using: `https://j6pgw21g-3001.inc1.devtunnels.ms/api/chat`
   - Check for typos in the URL


