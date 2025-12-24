# Backend Setup Instructions

## Quick Start

1. **Navigate to the backend folder:**
   ```bash
   cd backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create `.env` file:**
   Create a `.env` file in the `backend` folder with the following content:
   ```
   PORT=3001
   AZURE_OPENAI_ENDPOINT=https://engineeringteamopenai.openai.azure.com/
   AZURE_OPENAI_API_KEY=2Hcf7EkLSg88ySVEjrapikrQjIFA4F4BGgshU8Gwci15RkklqgGDJQQJ99BIACYeBjFXJ3w3AAABACOGHLjU
   AZURE_AI_AGENT_MODEL_DEPLOYMENT_NAME=gpt-4o
   KNOWLEDGE_BASE_URL=https://shop.skysecure.ai/
   PRODUCT_SERVICE_BACKEND_URL=https://devshop-backend.skysecure.ai/api/product
   ```

4. **Start the server:**
   ```bash
   npm start
   ```

   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

## Frontend Configuration

Make sure your frontend has the chatbot API URL configured. You can set it in your `.env.local` file:

```
NEXT_PUBLIC_CHATBOT_API_URL=https://j6pgw21g-3001.inc1.devtunnels.ms/api/chat
```

Or update the `CHATBOT_API_URL` constant in `src/components/shared/ChatbotWidget.jsx` if needed.

## Testing

Once the server is running, you can test it:

1. Health check: `http://localhost:3001/health`
2. Chat endpoint: `POST http://localhost:3001/api/chat`

## Troubleshooting

- If you get connection errors, make sure the backend server is running
- Check that the Azure OpenAI credentials are correct
- Verify the port matches your dev tunnel configuration
- Ensure CORS is properly configured (already set up in server.js)

