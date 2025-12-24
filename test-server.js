// Simple test script to verify the server is running
import axios from "axios";

const SERVER_URL = "http://localhost:3001";

async function testServer() {
  console.log("Testing server connection...\n");

  // Test health endpoint
  try {
    console.log(`1. Testing health endpoint: ${SERVER_URL}/health`);
    const healthResponse = await axios.get(`${SERVER_URL}/health`);
    console.log("✅ Health check passed:", healthResponse.data);
  } catch (error) {
    console.error("❌ Health check failed:", error.message);
    if (error.code === "ECONNREFUSED") {
      console.error("   → Server is not running. Please start it with: npm start");
    }
    return;
  }

  // Test CORS headers
  try {
    console.log(`\n2. Testing CORS headers on chat endpoint...`);
    const optionsResponse = await axios.options(`${SERVER_URL}/api/chat`, {
      headers: {
        "Origin": "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type"
      }
    });
    console.log("✅ OPTIONS request successful");
    console.log("   CORS Headers:", optionsResponse.headers);
  } catch (error) {
    console.error("❌ OPTIONS request failed:", error.message);
  }

  // Test actual chat endpoint
  try {
    console.log(`\n3. Testing chat endpoint: ${SERVER_URL}/api/chat`);
    const chatResponse = await axios.post(`${SERVER_URL}/api/chat`, {
      message: "Hello, test message",
      conversationHistory: []
    });
    console.log("✅ Chat endpoint working:", chatResponse.data);
  } catch (error) {
    console.error("❌ Chat endpoint failed:", error.message);
    if (error.response) {
      console.error("   Response status:", error.response.status);
      console.error("   Response data:", error.response.data);
    }
  }

  console.log("\n✅ All tests completed!");
}

testServer().catch(console.error);


