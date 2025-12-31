
import fetch from 'node-fetch';

const API_URL = 'http://localhost:3001/api/chat';

async function testBot(testName, message) {
  console.log(`\n--- Testing: ${testName} ---`);
  console.log(`User: "${message}"`);

  try {
    const start = Date.now();
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    const data = await response.json();
    const duration = Date.now() - start;

    if (data.success) {
      console.log(`Bot (${duration}ms): ${data.message.substring(0, 100)}...`);
      if (data.quickReplies && data.quickReplies.length > 0) {
        console.log('Quick Replies:', data.quickReplies.map(q => q.text).join(', '));
      }
    } else {
      console.error('Error:', data.message);
    }
  } catch (error) {
    console.error('Request failed:', error.message);
  }
}

async function runTests() {
  // 1. Health Check
  try {
    const health = await fetch('http://localhost:3001/health');
    const healthData = await health.json();
    console.log('Health Check:', healthData);
  } catch (e) {
    console.error('Backend not running! Start it with `npm run dev`');
    process.exit(1);
  }

  // 2. Greeting (Fast Track)
  await testBot('Greeting', 'Hello, how are you?');

  // 3. Product Query (Domain Specific)
  await testBot('Product Query', 'I need a good antivirus software');

  // 4. Specific Product/Category (Knowledge Base)
  await testBot('Category Query', 'What cloud management tools do you have?');

  // 5. Out of Domain (Fast Track)
  await testBot('Out of Domain', 'What is the capital of France?');
  
  // 6. Marketplace Signals
  await testBot('Best Sellers', 'Show me your best selling products');
}

runTests();
