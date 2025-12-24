# SkySecure Chatbot Backend

Backend service for the SkySecure Marketplace chatbot, powered by Azure OpenAI.

## Features

- Azure OpenAI integration (GPT-4o)
- Knowledge base from SkySecure website
- RESTful API for chatbot communication
- CORS enabled for frontend integration

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

## API Endpoints

### Health Check
```
GET /health
```

### Chat
```
POST /api/chat
Body: {
  "message": "User message",
  "conversationHistory": [
    { "from": "user", "text": "Hello" },
    { "from": "bot", "text": "Hi there!" }
  ]
}

Response: {
  "success": true,
  "message": "Bot response"
}
```

## Notes

- The server fetches content from the knowledge base URL on each request
- Conversation history is limited to the last 10 messages to manage token usage
- The knowledge base content is limited to 5000 characters to avoid token limits


