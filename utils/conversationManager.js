/**
 * Conversation Manager - Handles conversation state and guided sales logic
 * Implements Discovery → Narrowing → Recommendation → Conversion flow
 */

/**
 * Conversation stages enum
 */
export const ConversationStage = {
  DISCOVERY: 'Discovery',
  NARROWING: 'Narrowing',
  RECOMMENDATION: 'Recommendation',
  CONVERSION: 'Conversion',
};

/**
 * Tracks conversation state and determines current stage
 * @param {Array} conversationHistory - Array of previous messages
 * @param {string} currentMessage - Current user message
 * @param {Object} intent - Resolved intent from intentMapper
 * @returns {Object} - Conversation state with stage, confidence, and context
 */
export function trackConversationState(conversationHistory = [], currentMessage = '', intent = {}) {
  const history = conversationHistory || [];
  const messageCount = history.length;
  const lower = (currentMessage || '').toLowerCase();

  // Initialize state
  const state = {
    stage: ConversationStage.DISCOVERY,
    confidence: 0.5,
    messageCount,
    context: {},
    previousStage: null,
  };

  // Stage 1: Discovery (1-3 messages) - Understanding user type and goals
  if (messageCount < 3) {
    state.stage = ConversationStage.DISCOVERY;
    state.confidence = 0.9;
    state.context = {
      goal: 'Understand user type (individual, business, enterprise) and primary needs',
      nextAction: 'Ask about team size, business type, or specific use case',
    };
    return state;
  }

  // Stage 2: Narrowing (4-8 messages) - Selecting category/subcategory
  if (messageCount >= 3 && messageCount < 8) {
    // Check if user has specific intent (category/subcategory identified)
    if (intent?.subCategoryId || intent?.categoryName) {
      // User has narrowed down to a category, moving to recommendation
      state.stage = ConversationStage.RECOMMENDATION;
      state.confidence = 0.85;
      state.context = {
        goal: 'Recommend 1-2 best-fit products based on identified category',
        category: intent.categoryName,
        subCategoryId: intent.subCategoryId,
        nextAction: 'Suggest specific products with reasoning',
      };
    } else {
      // Still narrowing down
      state.stage = ConversationStage.NARROWING;
      state.confidence = 0.8;
      state.context = {
        goal: 'Help user select the right category or subcategory',
        nextAction: 'Ask clarifying questions about specific needs (email, security, collaboration, etc.)',
      };
    }
    return state;
  }

  // Stage 3: Recommendation (8-12 messages) - Suggesting products
  if (messageCount >= 8 && messageCount < 12) {
    // Check for conversion signals
    const conversionKeywords = ['buy', 'purchase', 'price', 'cost', 'how much', 'checkout', 'order'];
    const hasConversionIntent = conversionKeywords.some(keyword => lower.includes(keyword));

    if (hasConversionIntent) {
      state.stage = ConversationStage.CONVERSION;
      state.confidence = 0.9;
      state.context = {
        goal: 'Help user complete purchase or get detailed pricing',
        nextAction: 'Provide pricing details and direct to product page',
      };
    } else {
      state.stage = ConversationStage.RECOMMENDATION;
      state.confidence = 0.85;
      state.context = {
        goal: 'Recommend and explain product options',
        nextAction: 'Compare products, explain features, or suggest upgrades',
      };
    }
    return state;
  }

  // Stage 4: Conversion (12+ messages) - Closing the sale
  if (messageCount >= 12) {
    state.stage = ConversationStage.CONVERSION;
    state.confidence = 0.9;
    state.context = {
      goal: 'Help user complete purchase or provide final information',
      nextAction: 'Direct to product page, offer checkout assistance, or provide contact info',
    };
    return state;
  }

  return state;
}

/**
 * Gets stage-specific system prompt additions
 * @param {string} stage - Current conversation stage
 * @param {Object} context - Conversation context
 * @returns {string} - Stage-specific prompt instructions
 */
export function getStagePrompt(stage, context = {}) {
  const prompts = {
    [ConversationStage.DISCOVERY]: `
CURRENT STAGE: DISCOVERY
Your goal: Understand the user's type and primary needs.

BEHAVIOR:
- Ask ONE clarifying question about their business/use case
- Determine if they are: individual, small business (1-50 employees), or enterprise (50+ employees)
- Identify primary goal: email, collaboration, security, cloud storage, or other
- Be warm and conversational, not interrogative
- DO NOT list products yet - focus on understanding needs

EXAMPLE QUESTIONS:
- "How big is your team right now?"
- "What's your primary need - email, collaboration, security, or something else?"
- "Are you looking for a solution for yourself or your business?"

TRANSITION: Move to Narrowing stage once you understand user type and primary goal.
`,

    [ConversationStage.NARROWING]: `
CURRENT STAGE: NARROWING
Your goal: Help user select the right category or subcategory.

BEHAVIOR:
- Ask ONE specific question to narrow down to a category/subcategory
- Based on their previous answers, suggest 2-3 relevant categories
- DO NOT list all products - just help them choose the right category
- Use their business size and goals to guide recommendations
- Be consultative, not pushy

EXAMPLE QUESTIONS:
- "Do you mainly need email and collaboration, or also security and device management?"
- "Are you looking for cloud storage, data management, or both?"
- "Would you prefer an all-in-one solution or separate tools?"

TRANSITION: Move to Recommendation stage once category/subcategory is identified.
`,

    [ConversationStage.RECOMMENDATION]: `
CURRENT STAGE: RECOMMENDATION
Your goal: Recommend 1-2 best-fit products with clear reasoning.

BEHAVIOR:
- Recommend ONLY 1-2 products that best fit their needs
- Explain WHY each product is a good fit based on their stated needs
- Highlight key features relevant to their use case
- Mention pricing if available
- ALWAYS include the direct "Link:" from the data for each recommended product
- Mention pricing clearly for each option
- Offer to compare options if they're unsure
- DO NOT dump a list of all products - be selective and strategic

EXAMPLE RESPONSES:
- "Based on your team size and security needs, I'd recommend Microsoft 365 Business Premium. It includes..."
- "For your use case, you have two great options: [Product A] if you need [feature], or [Product B] if you prioritize [other feature]."

TRANSITION: Move to Conversion stage when user asks about pricing, purchasing, or shows buying intent.
`,

    [ConversationStage.CONVERSION]: `
CURRENT STAGE: CONVERSION
Your goal: Help user complete purchase or get detailed information.

BEHAVIOR:
- Provide exact pricing and billing details
- Include direct product page links
- Offer to help with checkout process
- Mention any current promotions or discounts
- Provide contact information for sales support if needed
- Soft upsell: mention upgrade paths only if genuinely beneficial

EXAMPLE RESPONSES:
- "Microsoft 365 Business Premium is ₹X/month per user. You can purchase it here: [Direct Link from Data]"
- "If your team grows beyond 50 people, you might want to consider the E3 plan for better scalability."
- "Would you like help with the checkout process, or do you have any other questions regarding the purchase of [Product Name]?"

TRANSITION: Offer continued support or return to Discovery if user has new questions.
`,
  };

  return prompts[stage] || prompts[ConversationStage.DISCOVERY];
}

/**
 * Generates a guiding question based on current stage and context
 * @param {string} stage - Current conversation stage
 * @param {Object} intent - Resolved intent
 * @param {Array} products - Available products (optional)
 * @returns {string} - Contextual follow-up question
 */
export function generateGuidingQuestion(stage, intent = {}, products = []) {
  switch (stage) {
    case ConversationStage.DISCOVERY:
      return "To help you find the perfect solution, could you tell me a bit about your team size or business type?";

    case ConversationStage.NARROWING:
      if (intent.categoryName) {
        return `Great! For ${intent.categoryName}, do you have any specific requirements like pricing range or features you need?`;
      }
      return "What's most important to you - collaboration tools, security features, or cloud storage?";

    case ConversationStage.RECOMMENDATION:
      if (products && products.length > 1) {
        return "Would you like me to compare these options for you, or do you have questions about a specific product?";
      }
      return "Does this solution meet your needs, or would you like to explore other options?";

    case ConversationStage.CONVERSION:
      return "Would you like the direct link to purchase, or do you have any final questions?";

    default:
      return "How can I help you find the right solution today?";
  }
}

/**
 * Suggests quick-reply buttons based on stage and context
 * @param {string} stage - Current conversation stage
 * @param {Object} intent - Resolved intent
 * @returns {Array} - Array of quick-reply button options
 */
export function suggestQuickReplies(stage, intent = {}) {
  const replies = {
    [ConversationStage.DISCOVERY]: [
      { text: "Small Business (1-50)", value: "small_business" },
      { text: "Enterprise (50+)", value: "enterprise" },
      { text: "Individual Use", value: "individual" },
    ],

    [ConversationStage.NARROWING]: [
      { text: "Email & Collaboration", value: "email_collaboration" },
      { text: "Security & Compliance", value: "security" },
      { text: "Cloud Storage", value: "cloud_storage" },
    ],

    [ConversationStage.RECOMMENDATION]: [
      { text: "Compare Options", value: "compare" },
      { text: "Show Pricing", value: "pricing" },
      { text: "See Features", value: "features" },
    ],

    [ConversationStage.CONVERSION]: [
      { text: "View Product Page", value: "product_page" },
      { text: "Contact Sales", value: "contact_sales" },
      { text: "Check Other Options", value: "other_options" },
    ],
  };

  return replies[stage] || [];
}

/**
 * Determines if user wants to restart conversation
 * @param {string} message - User message
 * @returns {boolean} - True if restart intent detected
 */
export function detectRestartIntent(message = '') {
  const restartKeywords = ['start over', 'restart', 'begin again', 'new search', 'different product'];
  const lower = (message || '').toLowerCase();
  return restartKeywords.some(keyword => lower.includes(keyword));
}

/**
 * Extracts user preferences from conversation history
 * @param {Array} conversationHistory - Array of previous messages
 * @returns {Object} - Extracted preferences (team size, budget, features, etc.)
 */
export function extractUserPreferences(conversationHistory = []) {
  const preferences = {
    teamSize: null,
    businessType: null,
    budget: null,
    primaryNeeds: [],
    mentionedFeatures: [],
  };

  conversationHistory.forEach(msg => {
    if (msg.from !== 'user') return;

    const text = (msg.text || '').toLowerCase();

    // Extract team size
    const teamSizeMatch = text.match(/(\d+)\s*(people|employees|users|team)/i);
    if (teamSizeMatch) {
      preferences.teamSize = parseInt(teamSizeMatch[1]);
      if (preferences.teamSize <= 50) {
        preferences.businessType = 'small_business';
      } else {
        preferences.businessType = 'enterprise';
      }
    }

    // Extract budget
    const budgetMatch = text.match(/budget.*?(\d+)/i) || text.match(/₹\s*(\d+)/);
    if (budgetMatch) {
      preferences.budget = parseInt(budgetMatch[1]);
    }

    // Extract primary needs
    const needsKeywords = {
      email: ['email', 'outlook', 'mail'],
      collaboration: ['collaboration', 'teams', 'sharepoint', 'onedrive'],
      security: ['security', 'compliance', 'protection', 'defender'],
      cloud: ['cloud', 'storage', 'azure'],
    };

    Object.entries(needsKeywords).forEach(([need, keywords]) => {
      if (keywords.some(keyword => text.includes(keyword))) {
        if (!preferences.primaryNeeds.includes(need)) {
          preferences.primaryNeeds.push(need);
        }
      }
    });
  });

  return preferences;
}
