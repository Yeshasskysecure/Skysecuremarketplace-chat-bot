# Quick Start Guide

## Step 1: Create .env File

In the `backend` folder, create a file named `.env` with:

```
PORT=3001
AZURE_OPENAI_ENDPOINT=https://engineeringteamopenai.openai.azure.com/
AZURE_OPENAI_API_KEY=2Hcf7EkLSg88ySVEjrapikrQjIFA4F4BGgshU8Gwci15RkklqgGDJQQJ99BIACYeBjFXJ3w3AAABACOGHLjU
AZURE_AI_AGENT_MODEL_DEPLOYMENT_NAME=gpt-4o
KNOWLEDGE_BASE_URL=https://shop.skysecure.ai/
```

## Step 2: Start Backend Server

Open Terminal 1:
```bash
cd backend
npm start
```

You should see:
```
Chatbot backend server running on port 3001
Health check: http://localhost:3001/health
Chat endpoint: http://localhost:3001/api/chat
```

## Step 3: Start Frontend

Open Terminal 2 (new terminal):
```bash
npm run dev
```

## Step 4: Test

1. Open browser: `http://localhost:3000`
2. Open the chatbot widget
3. Send a message

The frontend will now use `http://localhost:3001/api/chat` automatically when running on localhost.

## Troubleshooting

### If you still get CORS errors:

1. **Check backend is running**: Open `http://localhost:3001/health` in browser
   - Should show: `{"status":"ok","message":"Chatbot backend is running"}`

2. **Check backend logs**: Look for request logs like:
   ```
   2024-XX-XX - OPTIONS /api/chat
   2024-XX-XX - POST /api/chat
   ```

3. **Verify .env file exists**: Make sure `backend/.env` file exists with all variables

4. **Restart both servers**: Stop both terminals (Ctrl+C) and restart them

### Test the API directly:

```bash
# Test health endpoint
curl http://localhost:3001/health

# Test chat endpoint
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","conversationHistory":[]}'
```


