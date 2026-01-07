# SkySecure Chatbot Backend

Backend service for the SkySecure Marketplace chatbot, powered by Azure OpenAI.

## Features

- Azure OpenAI integration (GPT-4o)
- Knowledge base from SkySecure website
- RESTful API for chatbot communication
- CORS enabled for frontend integration
- User tenant context integration (personalized license and subscription information)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Update the `.env` file with your Azure OpenAI credentials

3. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Environment Variables

- `PORT` - Server port (default: 3001)
- `AZURE_OPENAI_ENDPOINT` - Azure OpenAI endpoint URL
- `AZURE_OPENAI_API_KEY` - Azure OpenAI API key
- `AZURE_AI_AGENT_MODEL_DEPLOYMENT_NAME` - Model deployment name (default: gpt-4o)
- `KNOWLEDGE_BASE_URL` - URL for knowledge base scraping (default: https://shop.skysecure.ai/)
- `AUTH_SERVICE_URL` - Auth service base URL for fetching user tenant data (default: https://auth.skysecure.ai)

## API Endpoints

### Health Check
```
GET /health
```

### Chat
```
POST /api/chat
Headers: {
  "Authorization": "Bearer <accessToken>",  // Optional: for authenticated requests
  "X-User-Id": "<userId>"                    // Optional: alternative to accessToken
}
Body: {
  "message": "User message",
  "conversationHistory": [
    { "from": "user", "text": "Hello" },
    { "from": "bot", "text": "Hi there!" }
  ],
  "userId": "<userId>",                      // Optional: user ID for tenant context
  "accessToken": "<accessToken>"             // Optional: access token for authenticated requests
}

Response: {
  "success": true,
  "message": "Bot response",
  "quickReplies": [...],
  "conversationStage": "Discovery"
}
```

**User Authentication & Tenant Context:**
- The chatbot can fetch user's Microsoft 365 tenant subscription data from the auth service
- Provide either `userId` (in body or `X-User-Id` header) or `accessToken` (in `Authorization` header or body)
- If authenticated, the chatbot will include personalized license and subscription information in responses
- The chatbot can answer questions like:
  - "What licenses do I have?"
  - "How many licenses are available?"
  - "What products am I subscribed to?"
  - "What's my license status?"

## Notes

- The server fetches content from the knowledge base URL on each request
- Conversation history is limited to the last 10 messages to manage token usage
- The knowledge base content is limited to 5000 characters to avoid token limits
- User tenant context is fetched from the auth service and cached for 5 minutes per user
- If the auth service is unavailable or user is not authenticated, the chatbot continues without tenant context
- User tenant data includes: tenant name, connected subscriptions, license counts (enabled/consumed/available), and subscription status
