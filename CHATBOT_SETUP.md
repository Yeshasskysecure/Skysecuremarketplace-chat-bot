# Chatbot Integration Setup Guide

This guide will help you set up the chatbot with Azure OpenAI, web scraping, and tunneling for the SkySecure Marketplace.

## Quick Start

### 1. Backend Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Create .env file (copy from .env.example)
# Edit .env with your Azure OpenAI credentials

# Start the server
npm start

# OR start with tunneling
npm run tunnel
```

### 2. Frontend Configuration

Add to your root `.env.local` file:

```env
NEXT_PUBLIC_CHATBOT_API_URL=http://localhost:3001/api/chat
```

Or if using tunneling:
```env
NEXT_PUBLIC_CHATBOT_API_URL=https://your-ngrok-url.ngrok.io/api/chat
```

### 3. Test It

1. Start your Next.js frontend: `npm run dev`
2. Open the chatbot widget (bottom-right corner)
3. Send a test message

## Detailed Setup

### Backend Configuration

The backend requires these environment variables in `backend/.env`:

```env
# Azure OpenAI (Required)
AZURE_OPENAI_API_KEY=2Hcf7EkLSg88ySVEjrapikrQjIFA4F4BGgshU8Gwci15RkklqgGDJQQJ99BIACYeBjFXJ3w3AAABACOGHLjU
AZURE_OPENAI_ENDPOINT=https://engineeringteamopenai.openai.azure.com
AZURE_AI_AGENT_MODEL_DEPLOYMENT_NAME=gpt-4o

# Server (Optional - defaults shown)
PORT=3001
FRONTEND_URL=http://localhost:3000

# Web Scraping (Optional)
WEBSITE_URL_TO_SCRAPE=https://www.skysecure.ai

# Tunneling (Optional)
NGROK_AUTH_TOKEN=your_token_here
```

**Important:** 
- Remove trailing slash from `AZURE_OPENAI_ENDPOINT`
- The endpoint format should be: `https://your-resource.openai.azure.com` (no `/` at the end)

### Tunneling Setup

#### Option 1: Using npm script (Recommended)

```bash
cd backend
npm run tunnel
```

This will:
- Start the backend server
- Create an ngrok tunnel
- Display the public URL

#### Option 2: Manual ngrok

1. Start backend: `npm start` (in backend directory)
2. In another terminal: `ngrok http 3001`
3. Copy the HTTPS URL from ngrok
4. Update frontend `.env.local` with the ngrok URL

#### Getting Ngrok Auth Token (for persistent URLs)

1. Sign up at [ngrok.com](https://ngrok.com)
2. Get your auth token from dashboard
3. Add to `backend/.env` as `NGROK_AUTH_TOKEN`

## Project Structure

```
backend/
├── server.js                    # Main Express server
├── routes/
│   ├── chat.js                 # Chat API endpoint
│   └── health.js               # Health check endpoint
├── services/
│   ├── azureOpenAIService.js   # Azure OpenAI integration
│   └── webScraperService.js     # Web scraping for context
├── tunnel.js                    # Ngrok tunneling script
├── .env                         # Environment variables (create from .env.example)
└── package.json                 # Dependencies

src/
├── components/shared/
│   └── ChatbotWidget.jsx       # Frontend chatbot component
└── services/
    └── chatbotService.js       # API service for chatbot
```

## Features

✅ **Azure OpenAI Integration**
- Uses GPT-4o model
- Conversation history support
- Context-aware responses

✅ **Web Scraping**
- Automatically scrapes website content for context
- Configurable via `WEBSITE_URL_TO_SCRAPE`
- Gracefully handles failures

✅ **Tunneling Support**
- Ngrok integration for public access
- Persistent URLs with auth token
- Easy local development

✅ **Error Handling**
- Comprehensive error messages
- Loading states in UI
- Graceful fallbacks

## Testing

### Test Backend Health

```bash
curl http://localhost:3001/health
```

### Test Chat API

```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello, what products do you offer?",
    "conversationHistory": []
  }'
```

### Test from Frontend

1. Open browser console
2. Click chatbot widget
3. Send a message
4. Check console for any errors

## Troubleshooting

### Backend won't start
- Check that port 3001 is not in use
- Verify Node.js version (18+)
- Check `.env` file exists and has correct values

### Azure OpenAI errors
- Verify API key is correct
- Check endpoint URL (no trailing slash)
- Ensure deployment name matches Azure portal
- Check Azure subscription has quota

### Frontend can't connect
- Verify `NEXT_PUBLIC_CHATBOT_API_URL` in `.env.local`
- Check backend is running
- Check CORS settings in backend
- Look for errors in browser console

### Tunneling issues
- Install ngrok: `npm install -g ngrok`
- Check firewall settings
- Verify backend is running before starting tunnel
- Try different ngrok region

### Web scraping fails
- Check website is accessible
- Some sites block scraping (this is OK, chatbot still works)
- Increase timeout if needed
- Check network connectivity

## Next Steps

1. ✅ Backend setup complete
2. ✅ Frontend integration complete
3. ⏭️ Customize system prompt in `backend/services/azureOpenAIService.js`
4. ⏭️ Adjust web scraping settings if needed
5. ⏭️ Test with various questions
6. ⏭️ Set up production deployment

## Production Considerations

- Use proper reverse proxy (nginx) instead of ngrok
- Add authentication/authorization
- Implement rate limiting
- Set up monitoring and logging
- Use HTTPS for all connections
- Secure API keys properly
- Add request validation

## Support

For issues:
1. Check `backend/README.md` for detailed documentation
2. Check `backend/SETUP.md` for setup instructions
3. Review error messages in console
4. Verify all environment variables are set correctly

