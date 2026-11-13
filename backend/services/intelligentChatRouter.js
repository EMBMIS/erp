const axios = require('axios');
const OpenAI = require('openai');
const { pool } = require('../config/database');
require('dotenv').config();
const { AI_MODEL, AI_MODEL_FAST, getOpenAIClient } = require('../config/aiConfig');
const { safeJsonParse } = require('./aiJson');
const { classifyAiError } = require('./ai/errorClassifier');

/**
 * Intelligent Chat Router
 * Automatically determines message type and routes to appropriate handler:
 * 1. SIMPLE_CHAT - Basic questions AI already knows
 * 2. WEB_SEARCH - Current information requiring web search
 * 3. DATABASE_QUERY - ERP data queries via API endpoints
 * 4. HYBRID - Combination of web search + database queries
 */
class IntelligentChatRouter {
  constructor() {
    this.apiEndpoints = this._loadApiEndpoints();
    this.openai = getOpenAIClient();
  }

  /**
   * Analyze message and determine the type using AI contextual understanding
   */
  async analyzeMessageType(message) {
    const systemPrompt = `You are a message routing classifier for an ERP system. Analyze the user's message and determine which type of response is most appropriate.

**Available Types:**
1. SIMPLE_CHAT - Basic conversations, greetings, general questions that don't require data
2. WEB_SEARCH - Requests for current/external information (prices, news, trends, general knowledge)
3. DATABASE_QUERY - Requests for specific internal business data (orders, customers, inventory, financial reports)
4. BUSINESS_ANALYSIS - Business advice, strategy, recommendations that need comprehensive data analysis
5. HYBRID - Requests that need both web search AND internal business data
6. CREATE_OPERATION - Create new records (customers, orders, items, suppliers, etc.)
7. UPDATE_OPERATION - Update/edit existing records, change status, approve/reject items

**ERP System Context:**
Our ERP system has these modules:
- Inventory Management: Inventory, Inventory Items, Item Master, Warehouse, Warehouse Transactions
- Procurement: Procurement Dashboard, Suppliers, Contracts, Purchase Requisitions, Request for Quotations, Purchase Orders  
- Sales: Customers, Sales Contracts, RFQ to Suppliers, Sales Quotations, Sales Orders, Delivery Schedules
- Finance: Chart of Accounts, Journal Entries, Trial Balance, Balance Sheet, Income Statement
- Simeli AI

**Instructions:**
- If asking about external products, market prices, news, trends, or general knowledge → WEB_SEARCH
- If asking about specific business data (our orders, our customers, our inventory) → DATABASE_QUERY  
- If asking for business advice, solutions, strategies, or recommendations → BUSINESS_ANALYSIS
- If asking for both external info AND our business data → HYBRID
- If just chatting, greetings, or asking basic non-business questions → SIMPLE_CHAT

**Key Examples:**
- "suggest me what to do for my sales team" → BUSINESS_ANALYSIS
- "show me our purchase orders" → DATABASE_QUERY
- "what is the iPhone price?" → WEB_SEARCH
- "compare our sales with industry average" → HYBRID
- "create a new customer" → CREATE_OPERATION
- "add new purchase order" → CREATE_OPERATION  
- "approve purchase order PO-123456" → UPDATE_OPERATION
- "update customer details" → UPDATE_OPERATION
- "mark sales order as completed" → UPDATE_OPERATION

Respond ONLY with a JSON object in this exact format. Keep "reasoning" to one short sentence (under 15 words) — it is logged for debugging only, never shown to the user:
{
  "type": "SIMPLE_CHAT|WEB_SEARCH|DATABASE_QUERY|BUSINESS_ANALYSIS|HYBRID|CREATE_OPERATION|UPDATE_OPERATION",
  "confidence": 0.1-1.0,
  "reasoning": "brief explanation"
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: AI_MODEL_FAST,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `User Message: "${message}"` }
        ],
        // 200 was too tight for models that wrap JSON in a markdown fence and/or
        // write a fuller "reasoning" field before the closing brace — that
        // truncated the response mid-JSON and made routing fail on every call.
        max_tokens: 500,
        temperature: 0.3
      });

      const result = safeJsonParse(response.choices[0]?.message?.content);
      return {
        type: result.type,
        confidence: result.confidence,
        reasoning: result.reasoning
      };
    } catch (error) {
      console.error('AI routing failed:', error);

      // A quota/billing or auth failure will fail identically on every
      // subsequent AI call too — silently defaulting to WEB_SEARCH just means
      // the NEXT call fails the same way with an even less informative message
      // ("having trouble accessing current web information"). Surface the real,
      // actionable cause once here instead of hiding it behind a fake route.
      const classified = classifyAiError(error);
      if (!classified.retryable) {
        return {
          type: 'AI_UNAVAILABLE',
          confidence: 1.0,
          reasoning: classified.userMessage,
          errorCode: classified.code,
        };
      }

      // Genuinely transient/unknown errors: keep the existing safe fallback.
      return {
        type: 'WEB_SEARCH',
        confidence: 0.5,
        reasoning: 'AI routing failed, defaulting to web search'
      };
    }
  }

  /**
   * Intelligently determine business domain and related data needs
   */
  async mapToApiEndpoint(message) {
    // Use AI to understand the business context and determine what data is needed
    const systemPrompt = `You are an ERP data router. Analyze the user's message (in any language - English, Russian, etc.) and determine what specific ERP endpoints are needed.

**CRITICAL: Always return valid JSON array, never empty []**

If you're unsure, use context clues:
- "sales team" / "команда продаж" → need sales orders, customers, performance data
- "business analysis" / "анализ бизнеса" → need comprehensive data from multiple modules
- "inventory" / "инвентарь" → need inventory items and warehouse data
- "financial" / "финансовый" → need journal entries, accounts, financial reports

**Never return empty array - always map to the most relevant endpoints based on context.**

**IMPORTANT: Distinguish between DATA RETRIEVAL vs ANALYTICS:**

**DATA RETRIEVAL** (List/Show/Get specific records):
- "show me all customers" → [{"endpoint":"/api/customers","method":"GET","action":"list","description":"List all customers","priority":1}]
- "list purchase orders" → [{"endpoint":"/api/purchase-orders","method":"GET","action":"list","description":"List purchase orders","priority":1}]
- "get item masters" → [{"endpoint":"/api/items","method":"GET","action":"list","description":"List item masters","priority":1}]
- "show inventory items" → [{"endpoint":"/api/inventory-items","method":"GET","action":"list","description":"List inventory items","priority":1}]

**Examples (English and Russian):**
- "show me all customers" / "покажи всех клиентов" → [{"endpoint":"/api/customers","method":"GET","action":"list","description":"List all customers","priority":1}]
- "get purchase orders" / "получить заказы на покупку" → [{"endpoint":"/api/purchase-orders","method":"GET","action":"list","description":"List purchase orders","priority":1}]
- "display item masters" / "показать мастер-данные товаров" → [{"endpoint":"/api/items","method":"GET","action":"list","description":"List item masters","priority":1}]
- "analyze my business" / "проанализируй мой бизнес" → [{"endpoint":"/api/customers","method":"GET","action":"list","description":"List all customers","priority":1},{"endpoint":"/api/sales-orders","method":"GET","action":"list","description":"List sales orders","priority":1},{"endpoint":"/api/purchase-orders","method":"GET","action":"list","description":"List purchase orders","priority":1},{"endpoint":"/api/inventory-items","method":"GET","action":"list","description":"List inventory items","priority":1}]

**Key Distinctions:**
- Words like "show", "list", "get", "all", "display" → DATA RETRIEVAL endpoints
- Match user intent to the appropriate business function and corresponding API endpoint

**Available ERP API Endpoints:**

**Inventory Management:**
- /api/inventory-items (list all inventory items)
- /api/inventory-items/:id (specific inventory item details)
- /api/inventory-items/search (search inventory by criteria)
- /api/items (list all item masters)
- /api/items/:id (specific item master details)
- /api/items/search (search item masters by criteria)
- /api/warehouse/transactions (list warehouse transactions)
- /api/warehouse/transactions/:id (specific transaction details)
- /api/storage-locations (list storage locations)
- /api/storage-locations/:id (specific location details)
- /api/bins (list bins)
- /api/bins/:id (specific bin details)

**Procurement:**
- /api/suppliers (list all suppliers)
- /api/suppliers/:id (specific supplier details)
- /api/suppliers/search (search suppliers by criteria)
- /api/contracts (list procurement contracts)
- /api/contracts/:id (specific contract details)
- /api/purchase-requisitions (list purchase requisitions)
- /api/purchase-requisitions/:id (specific requisition details)
- /api/request-for-quotations (list RFQs to suppliers)
- /api/request-for-quotations/:id (specific RFQ details)
- /api/purchase-orders (list purchase orders)
- /api/purchase-orders/:id (specific PO details)
- /api/purchase-orders/search (search POs by criteria)
- /api/goods-receipts (list goods receipts)
- /api/goods-receipts/:id (specific receipt details)

**Sales:**
- /api/customers (list all customers)
- /api/customers/:id (specific customer details)
- /api/customers/search (search customers by criteria)
- /api/sales-contracts (list sales contracts)
- /api/sales-contracts/:id (specific sales contract details)
- /api/sales-rfqs (list sales RFQs)
- /api/sales-rfqs/:id (specific sales RFQ details)
- /api/sales-quotations (list sales quotations)
- /api/sales-quotations/:id (specific quotation details)
- /api/sales-orders (list sales orders)
- /api/sales-orders/:id (specific sales order details)
- /api/sales-orders/search (search sales orders by criteria)
- /api/delivery-schedules (list delivery schedules)
- /api/delivery-schedules/:id (specific delivery details)

**Finance:**
- /api/chart-of-accounts (list all accounts)
- /api/chart-of-accounts/:id (specific account details)
- /api/chart-of-accounts/search (search accounts by criteria)
- /api/journal-entries (list journal entries)
- /api/journal-entries/:id (specific entry details)
- /api/journal-entries/search (search entries by criteria)
- /api/finance/trial-balance (trial balance report)
- /api/finance/balance-sheet (balance sheet report)
- /api/finance/income-statement (income statement report)

Respond with a valid JSON array only. No explanations, no markdown, just the JSON:
[{"endpoint":"/api/endpoint-name","method":"GET","action":"list","description":"description","priority":1}]`;

    try {
      const response = await this.openai.chat.completions.create({
        model: AI_MODEL_FAST,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `User Message: "${message}"` }
        ],
        max_tokens: 800,
        temperature: 0.3
      });

      // Clean and parse the response  
      let cleanResponse = response.choices[0]?.message?.content.trim();
      
      console.log('🤖 Raw AI response:', cleanResponse);
      
      // Remove any markdown code blocks and explanatory text
      cleanResponse = cleanResponse.replace(/```json\s*|\s*```/g, '');
      
      // Try to extract and fix incomplete JSON
      let jsonMatch = cleanResponse.match(/\[[\s\S]*\]/);
      
      if (!jsonMatch) {
        // Look for incomplete JSON starting with [
        const incompleteMatch = cleanResponse.match(/\[[\s\S]*/);
        if (incompleteMatch) {
          console.log('⚠️ Incomplete JSON detected, attempting to fix...');
          let incompleteJson = incompleteMatch[0];
          
          // Try to complete the JSON if it's obviously truncated
          if (!incompleteJson.includes('}]') && incompleteJson.includes('"endpoint"')) {
            // Add missing closing for the object and array
            incompleteJson = incompleteJson.replace(/,\s*$/, '') + '}]';
            console.log('🔧 Fixed JSON:', incompleteJson);
            jsonMatch = [incompleteJson];
          }
        }
      }
      
      if (!jsonMatch) {
        console.log('❌ No JSON array found in response:', cleanResponse);
        // Create fallback based on message content
        return this._createFallbackEndpoint(message);
      }
      
      console.log('🔍 Extracted JSON:', jsonMatch[0]);
      const endpoints = JSON.parse(jsonMatch[0]);
      
      // Validate the structure
      if (Array.isArray(endpoints) && endpoints.length > 0) {
        return endpoints
          .filter(ep => ep.endpoint && ep.method) // Ensure required fields
          .sort((a, b) => (a.priority || 5) - (b.priority || 5))
          .slice(0, 4);
      } else {
        throw new Error('Invalid endpoint structure');
      }
    } catch (error) {
      console.error('AI endpoint mapping failed:', error.message);
      // Create fallback based on message content
      return this._createFallbackEndpoint(message);
    }
  }

  /**
   * Create fallback endpoint when AI mapping fails
   */
  _createFallbackEndpoint(message) {
    const messageLower = message.toLowerCase();
    
    // Business Analysis Keywords (English & Russian)
    const businessAnalysisKeywords = [
      'analyze', 'analysis', 'business', 'анализ', 'бизнес', 'проанализируй', 
      'весь', 'performance', 'производительность', 'отчет', 'report',
      'sales team', 'team', 'what to do', 'strategy', 'advice', 'recommend',
      'команда', 'стратегия', 'совет', 'рекомендация', 'что делать'
    ];
    
    const isBusinessAnalysis = businessAnalysisKeywords.some(keyword => 
      messageLower.includes(keyword)
    );
    
    if (isBusinessAnalysis) {
      // Return comprehensive endpoints for business analysis
      return [
        { endpoint: '/api/customers', method: 'GET', action: 'list', description: 'List all customers', priority: 1 },
        { endpoint: '/api/sales-orders', method: 'GET', action: 'list', description: 'List sales orders', priority: 1 },
        { endpoint: '/api/purchase-orders', method: 'GET', action: 'list', description: 'List purchase orders', priority: 1 },
        { endpoint: '/api/inventory-items', method: 'GET', action: 'list', description: 'List inventory items', priority: 1 },
        { endpoint: '/api/items', method: 'GET', action: 'list', description: 'List item masters', priority: 2 },
        { endpoint: '/api/suppliers', method: 'GET', action: 'list', description: 'List suppliers', priority: 2 },
        { endpoint: '/api/journal-entries', method: 'GET', action: 'list', description: 'List journal entries', priority: 2 }
      ];
    }
    
    // Basic keyword-based fallback for common patterns
    if (messageLower.includes('item') && (messageLower.includes('nv-') || messageLower.includes('inv-'))) {
      return [{ endpoint: '/api/items/:id', method: 'GET', action: 'details', description: 'Get item details', priority: 1 }];
    }
    
    if (messageLower.includes('inventory') || messageLower.includes('инвентарь')) {
      return [{ endpoint: '/api/inventory-items', method: 'GET', action: 'list', description: 'List inventory items', priority: 1 }];
    }
    
    if (messageLower.includes('customer') || messageLower.includes('клиент')) {
      return [{ endpoint: '/api/customers', method: 'GET', action: 'list', description: 'List customers', priority: 1 }];
    }
    
    if (messageLower.includes('supplier') || messageLower.includes('поставщик')) {
      return [{ endpoint: '/api/suppliers', method: 'GET', action: 'list', description: 'List suppliers', priority: 1 }];
    }
    
    if (messageLower.includes('purchase order') || messageLower.includes('po ') || messageLower.includes('заказ на покупку')) {
      return [{ endpoint: '/api/purchase-orders', method: 'GET', action: 'list', description: 'List purchase orders', priority: 1 }];
    }
    
    if (messageLower.includes('sales order') || messageLower.includes('заказ на продажу')) {
      return [{ endpoint: '/api/sales-orders', method: 'GET', action: 'list', description: 'List sales orders', priority: 1 }];
    }
    
    if (messageLower.includes('journal') || messageLower.includes('журнал') || messageLower.includes('entries') || messageLower.includes('записи')) {
      return [{ endpoint: '/api/journal-entries', method: 'GET', action: 'list', description: 'List journal entries', priority: 1 }];
    }
    
    if (messageLower.includes('chart') || messageLower.includes('account') || messageLower.includes('план счетов') || messageLower.includes('счета')) {
      return [{ endpoint: '/api/chart-of-accounts', method: 'GET', action: 'list', description: 'List chart of accounts', priority: 1 }];
    }
    
    console.log('⚠️ No fallback mapping found for message:', message);
    return [];
  }

  /**
   * Map message to create endpoints
   */
  async mapToCreateEndpoint(message) {
    const createEndpoints = {
      // Customer Operations
      'customer': { endpoint: '/api/customers', method: 'POST', description: 'Customer', type: 'customer' },
      
      // Supplier Operations  
      'supplier': { endpoint: '/api/suppliers', method: 'POST', description: 'Supplier', type: 'supplier' },
      
      // Item Operations
      'item': { endpoint: '/api/items', method: 'POST', description: 'Item Master', type: 'item' },
      'item master': { endpoint: '/api/items', method: 'POST', description: 'Item Master', type: 'item' },
      'inventory item': { endpoint: '/api/inventory-items', method: 'POST', description: 'Inventory Item', type: 'inventory_item' },
      
      // Warehouse Operations
      'storage location': { endpoint: '/api/storage-locations', method: 'POST', description: 'Storage Location', type: 'storage_location' },
      'warehouse': { endpoint: '/api/storage-locations', method: 'POST', description: 'Storage Location', type: 'storage_location' },
      'bin': { endpoint: '/api/bins', method: 'POST', description: 'Storage Bin', type: 'bin' },
      
      // Procurement Operations
      'purchase requisition': { endpoint: '/api/purchase-requisitions', method: 'POST', description: 'Purchase Requisition', type: 'purchase_requisition' },
      'pr': { endpoint: '/api/purchase-requisitions', method: 'POST', description: 'Purchase Requisition', type: 'purchase_requisition' },
      'requisition': { endpoint: '/api/purchase-requisitions', method: 'POST', description: 'Purchase Requisition', type: 'purchase_requisition' },
      'rfq': { endpoint: '/api/request-for-quotations', method: 'POST', description: 'Request for Quotation', type: 'rfq' },
      'request for quotation': { endpoint: '/api/request-for-quotations', method: 'POST', description: 'Request for Quotation', type: 'rfq' },
      'purchase order': { endpoint: '/api/purchase-orders', method: 'POST', description: 'Purchase Order', type: 'purchase_order' },
      'po': { endpoint: '/api/purchase-orders', method: 'POST', description: 'Purchase Order', type: 'purchase_order' },
      
      // Sales Operations
      'sales quotation': { endpoint: '/api/sales-quotations', method: 'POST', description: 'Sales Quotation', type: 'sales_quotation' },
      'quotation': { endpoint: '/api/sales-quotations', method: 'POST', description: 'Sales Quotation', type: 'sales_quotation' },
      'quote': { endpoint: '/api/sales-quotations', method: 'POST', description: 'Sales Quotation', type: 'sales_quotation' },
      'sales contract': { endpoint: '/api/sales-contracts', method: 'POST', description: 'Sales Contract', type: 'sales_contract' },
      'sales order': { endpoint: '/api/sales-orders', method: 'POST', description: 'Sales Order', type: 'sales_order' },
      'so': { endpoint: '/api/sales-orders', method: 'POST', description: 'Sales Order', type: 'sales_order' },
      'delivery schedule': { endpoint: '/api/delivery-schedules', method: 'POST', description: 'Delivery Schedule', type: 'delivery_schedule' },
      
      // Contract Operations
      'contract': { endpoint: '/api/contracts', method: 'POST', description: 'Procurement Contract', type: 'contract' },
      
      // Financial Operations
      'journal entry': { endpoint: '/api/journal-entries', method: 'POST', description: 'Journal Entry', type: 'journal_entry' },
      'account': { endpoint: '/api/chart-of-accounts', method: 'POST', description: 'Chart of Account', type: 'account' }
    };

    const messageLower = message.toLowerCase();
    
    // Find matching create operation with priority order (most specific first)
    const sortedEndpoints = Object.entries(createEndpoints).sort((a, b) => b[0].length - a[0].length);
    
    for (const [key, mapping] of sortedEndpoints) {
      if (messageLower.includes(key) && (messageLower.includes('create') || messageLower.includes('add') || messageLower.includes('new'))) {
        return [mapping];
      }
    }
    
    return [];
  }

  /**
   * Map message to update endpoints
   */
  async mapToUpdateEndpoint(message) {
    const messageLower = message.toLowerCase();
    
    // Handle approval operations first (specific endpoints)
    if (messageLower.includes('approve')) {
      // Check for inventory item by looking for INV- prefix or "inventory item" phrase
      if (messageLower.includes('inv-') || messageLower.includes('inventory item')) {
        return [{ endpoint: '/api/inventory-items/:id/approve', method: 'POST', description: 'Approve Inventory Item', type: 'approval' }];
      }
      // Check for item master by TEMP- prefix or "item master" or just "item" (but not inventory item)
      if ((messageLower.includes('temp-') || messageLower.includes('item master') || (messageLower.includes('item') && !messageLower.includes('inventory'))) && !messageLower.includes('requisition')) {
        return [{ endpoint: '/api/items/:id/approve', method: 'POST', description: 'Approve Item Master', type: 'approval' }];
      }
      if (messageLower.includes('customer')) {
        return [{ endpoint: '/api/customers/:id/approve', method: 'POST', description: 'Approve Customer', type: 'approval' }];
      }
      if (messageLower.includes('supplier')) {
        return [{ endpoint: '/api/suppliers/:id/approve', method: 'POST', description: 'Approve Supplier', type: 'approval' }];
      }
      if (messageLower.includes('purchase requisition') || messageLower.includes('requisition') || messageLower.includes('pr')) {
        return [{ endpoint: '/api/purchase-requisitions/:id/approve', method: 'POST', description: 'Approve Purchase Requisition', type: 'approval' }];
      }
      if (messageLower.includes('rfq') || messageLower.includes('request for quotation')) {
        return [{ endpoint: '/api/request-for-quotations/:id/approve', method: 'POST', description: 'Approve RFQ', type: 'approval' }];
      }
      if (messageLower.includes('purchase order') || messageLower.includes('po')) {
        return [{ endpoint: '/api/purchase-orders/:id/approve', method: 'POST', description: 'Approve Purchase Order', type: 'approval' }];
      }
      if (messageLower.includes('sales quotation') || messageLower.includes('quotation') || messageLower.includes('quote')) {
        return [{ endpoint: '/api/sales-quotations/:id/approve', method: 'POST', description: 'Approve Sales Quotation', type: 'approval' }];
      }
      if (messageLower.includes('sales contract') || messageLower.includes('contract')) {
        return [{ endpoint: '/api/sales-contracts/:id/approve', method: 'POST', description: 'Approve Sales Contract', type: 'approval' }];
      }
      if (messageLower.includes('sales order') || messageLower.includes('so')) {
        return [{ endpoint: '/api/sales-orders/:id/approve', method: 'POST', description: 'Approve Sales Order', type: 'approval' }];
      }
    }
    
    // Handle decline/reject operations
    if (messageLower.includes('decline') || messageLower.includes('reject')) {
      if (messageLower.includes('item')) {
        return [{ endpoint: '/api/items/:id/decline', method: 'POST', description: 'Decline Item', type: 'decline' }];
      }
      if (messageLower.includes('customer')) {
        return [{ endpoint: '/api/customers/:id/decline', method: 'POST', description: 'Decline Customer', type: 'decline' }];
      }
      if (messageLower.includes('supplier')) {
        return [{ endpoint: '/api/suppliers/:id/decline', method: 'POST', description: 'Decline Supplier', type: 'decline' }];
      }
    }
    
    // Regular update operations
    const updateEndpoints = {
      'customer': { endpoint: '/api/customers/:id', method: 'PUT', description: 'Customer', type: 'customer' },
      'supplier': { endpoint: '/api/suppliers/:id', method: 'PUT', description: 'Supplier', type: 'supplier' },
      'item': { endpoint: '/api/items/:id', method: 'PUT', description: 'Item Master', type: 'item' },
      'item master': { endpoint: '/api/items/:id', method: 'PUT', description: 'Item Master', type: 'item' },
      'inventory item': { endpoint: '/api/inventory-items/:id', method: 'PUT', description: 'Inventory Item', type: 'inventory_item' },
      'storage location': { endpoint: '/api/storage-locations/:id', method: 'PUT', description: 'Storage Location', type: 'storage_location' },
      'warehouse': { endpoint: '/api/storage-locations/:id', method: 'PUT', description: 'Storage Location', type: 'storage_location' },
      'bin': { endpoint: '/api/bins/:id', method: 'PUT', description: 'Storage Bin', type: 'bin' },
      'purchase requisition': { endpoint: '/api/purchase-requisitions/:id', method: 'PUT', description: 'Purchase Requisition', type: 'purchase_requisition' },
      'pr': { endpoint: '/api/purchase-requisitions/:id', method: 'PUT', description: 'Purchase Requisition', type: 'purchase_requisition' },
      'rfq': { endpoint: '/api/request-for-quotations/:id', method: 'PUT', description: 'Request for Quotation', type: 'rfq' },
      'request for quotation': { endpoint: '/api/request-for-quotations/:id', method: 'PUT', description: 'Request for Quotation', type: 'rfq' },
      'purchase order': { endpoint: '/api/purchase-orders/:id', method: 'PUT', description: 'Purchase Order', type: 'purchase_order' },
      'po': { endpoint: '/api/purchase-orders/:id', method: 'PUT', description: 'Purchase Order', type: 'purchase_order' },
      'sales quotation': { endpoint: '/api/sales-quotations/:id', method: 'PUT', description: 'Sales Quotation', type: 'sales_quotation' },
      'quotation': { endpoint: '/api/sales-quotations/:id', method: 'PUT', description: 'Sales Quotation', type: 'sales_quotation' },
      'sales contract': { endpoint: '/api/sales-contracts/:id', method: 'PUT', description: 'Sales Contract', type: 'sales_contract' },
      'contract': { endpoint: '/api/contracts/:id', method: 'PUT', description: 'Procurement Contract', type: 'contract' },
      'sales order': { endpoint: '/api/sales-orders/:id', method: 'PUT', description: 'Sales Order', type: 'sales_order' },
      'so': { endpoint: '/api/sales-orders/:id', method: 'PUT', description: 'Sales Order', type: 'sales_order' },
      'delivery schedule': { endpoint: '/api/delivery-schedules/:id', method: 'PUT', description: 'Delivery Schedule', type: 'delivery_schedule' }
    };
    
    // Find matching update operation
    for (const [key, mapping] of Object.entries(updateEndpoints)) {
      if (messageLower.includes(key) && (
        messageLower.includes('update') || 
        messageLower.includes('edit') || 
        messageLower.includes('change')
      )) {
        return [mapping];
      }
    }
    
    return [];
  }

  /**
   * Extract create data from message using AI
   */
  async extractCreateData(message, endpoint) {
    // Determine entity type from endpoint
    let entityType = 'item';
    if (endpoint.includes('/customers')) entityType = 'customer';
    else if (endpoint.includes('/suppliers')) entityType = 'supplier';
    else if (endpoint.includes('/items')) entityType = 'item';
    else if (endpoint.includes('/inventory-items')) entityType = 'inventory_item';
    else if (endpoint.includes('/storage-locations')) entityType = 'storage_location';
    else if (endpoint.includes('/bins')) entityType = 'bin';
    else if (endpoint.includes('/purchase-requisitions')) entityType = 'purchase_requisition';
    else if (endpoint.includes('/request-for-quotations')) entityType = 'rfq';
    else if (endpoint.includes('/purchase-orders')) entityType = 'purchase_order';
    else if (endpoint.includes('/sales-quotations')) entityType = 'sales_quotation';
    else if (endpoint.includes('/sales-contracts')) entityType = 'sales_contract';
    else if (endpoint.includes('/sales-orders')) entityType = 'sales_order';
    
    let systemPrompt = '';
    
    if (entityType === 'customer') {
      systemPrompt = `Extract customer data ONLY from: "${message}"

Create comprehensive customer record with ALL fields:
- customer_name (required), legal_entity_name, customer_type ("COMPANY", "INDIVIDUAL", "GOVERNMENT", "NON_PROFIT")
- primary_email, secondary_email, phone, mobile, fax, website
- billing_address_line1, billing_address_line2, billing_city, billing_state, billing_country, billing_postal_code
- shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_country, shipping_postal_code
- use_billing_as_shipping (boolean), currency, credit_limit (number), credit_days (number), payment_terms
- tax_number, vat_number, tax_exempt (boolean), tax_rate (number)
- primary_contact_name, primary_contact_title, primary_contact_email, primary_contact_phone
- secondary_contact_name, secondary_contact_title, secondary_contact_email, secondary_contact_phone
- status ("DRAFT"), customer_category, customer_group, credit_risk_level, credit_check_required (boolean)
- notes, internal_notes

Return ONLY JSON object with customer fields.`;
    } else if (entityType === 'supplier') {
      systemPrompt = `Extract supplier data ONLY from: "${message}"

Create comprehensive supplier record with ALL fields:
- legal_name (required), trade_name, email, phone, address, country, city, postal_code
- supplier_type ("TRANSACTIONAL", "STRATEGIC", "PREFERRED"), certification_status, payment_terms, currency
- status ("DRAFT"), partnership_status

Return ONLY JSON object with supplier fields.`;
    } else if (entityType === 'item') {
      systemPrompt = `Extract item data ONLY from: "${message}"

Create comprehensive item record with ALL fields:
- name (required), description, status ("DRAFT")
- criticality ("LOW", "MEDIUM", "HIGH", "CRITICAL"), unit_of_measure (required - "pcs", "each", "kg", "m", etc.), unspsc_code (required - generate appropriate code)
- manufacturer, manufacturer_part_number, item_category, serial_number, equipment_tag
- has_contract (boolean), contract_number (string or omit if false), has_barcode (boolean), barcode (string or omit if false)
- is_stock_item (boolean), planned_stock (boolean - true if stock item)
- mass_per_uom (number or null), volume_per_uom (number or null)

**CRITICAL RULES:**
- planned_stock must be boolean (true/false), not number!
- ALL string fields use empty string "" for no value, NOT null
- Numeric fields (mass_per_uom, volume_per_uom): use empty string "" if no value (matches frontend form)
- If has_contract is false, set contract_number to ""  
- If has_barcode is false, set barcode to ""
- unspsc_code: either 8-digit number string or empty string ""
- Match exact frontend form data structure

Return ONLY JSON object with item fields.`;
    } else if (entityType === 'inventory_item') {
      systemPrompt = `Extract inventory item data ONLY from: "${message}"

CRITICAL: Inventory items are created FROM existing approved item masters, not independently.

Create inventory item record:
- item_master_id (UUID - required, link to approved item master)
- unit_price (number - required), currency ("USD" default)
- condition_grade ("A", "B", "C", "D" - default "A")  
- condition_notes (optional description of condition)

If no specific item master is referenced, respond with error message requesting item master selection.

Return ONLY JSON object with inventory item fields.`;
    } else if (entityType === 'storage_location') {
      systemPrompt = `Extract storage location data ONLY from: "${message}"

Create comprehensive storage location record matching frontend form:
- code (required - generate using CITY INITIALS + sequence number format, e.g., "BRI001" for Brighton, "LON001" for London, "NYC001" for New York City. Take first 3 letters of city name in uppercase + "001")
- name (required - full name like "Brighton Warehouse") 
- country (required - "United Kingdom", "United States", etc.)
- city (required - "Brighton", "London", "New York", etc.)
- address (required - full street address)
- postal_code (required - "NS0R51", "SW1A 1AA", "10001", etc.)
- description (optional - additional notes)
- status (default: "DRAFT")

CRITICAL: Code must use city initials format (first 3 letters of city + 001), NOT generic codes like WH001.
Return ONLY JSON object with exact field names from frontend.`;
    } else if (entityType === 'bin') {
      systemPrompt = `Extract storage bin data ONLY from: "${message}"

Create comprehensive storage bin record matching frontend form:
- code (required - exactly 8 digits in format WWRRSSBB like "12345678")
- description (optional - bin description/notes)
- max_mass_capacity (required - number > 0, maximum mass capacity)
- max_volume_capacity (required - number > 0, maximum volume capacity) 
- current_mass_used (default: "0" - current mass used)
- current_volume_used (default: "0" - current volume used)
- storage_location_id (required - UUID of storage location)
- status (default: "DRAFT")

CRITICAL: 
- code must be exactly 8 digits
- If storage location mentioned, resolve to UUID
- All capacity values are numbers

Return ONLY JSON object with exact field names from frontend.`;
    } else if (entityType === 'purchase_requisition') {
      systemPrompt = `Extract purchase requisition data ONLY from: "${message}"

Create comprehensive purchase requisition record:
- cost_center (required), item_id (UUID if linking to catalog)
- item_description (required), unit_of_measure
- quantity (number - required, min 0.01), estimated_unit_price (number)
- currency ("USD"), recommended_supplier_id (UUID if provided)
- supplier_recommendation_text

Return ONLY JSON object with purchase requisition fields.`;
    } else if (entityType === 'rfq') {
      systemPrompt = `Extract RFQ data ONLY from: "${message}"

Create comprehensive RFQ record:
- title (required), description, purchase_requisition_id (UUID if linking)
- response_deadline (future date), currency ("USD")
- line_items (array with item_description, unit_of_measure, quantity, specifications)
- suppliers (array - min 1 supplier ID)

Return ONLY JSON object with RFQ fields.`;
    } else if (entityType === 'purchase_order') {
      systemPrompt = `Extract purchase order data ONLY from: "${message}"

Create comprehensive purchase order record:
- supplier_id (UUID - required), currency ("USD")
- delivery_date (future date), delivery_address
- payment_terms, priority ("NORMAL", "HIGH", "URGENT")
- line_items (array with item details, quantities, pricing)

Return ONLY JSON object with purchase order fields.`;
    } else if (entityType === 'sales_quotation') {
      systemPrompt = `Extract sales quotation data ONLY from: "${message}"

Create comprehensive sales quotation record:
- customer_id (UUID - required), quotation_date (today's date)
- valid_until (date - 30 days from today), reference_number
- currency ("USD"), priority ("NORMAL", "LOW", "HIGH", "URGENT")
- delivery_address, delivery_terms, estimated_delivery_days (number)
- payment_terms, items (array with item details, sourcing, pricing)

Return ONLY JSON object with sales quotation fields.`;
    } else if (entityType === 'sales_contract') {
      systemPrompt = `Extract sales contract data ONLY from: "${message}"

Create comprehensive sales contract record:
- contract_name (required), customer_id (UUID), supplier_id (UUID)
- contract_type ("SALES", "PURCHASE", "FRAMEWORK", "SERVICE")
- contract_value (number), currency ("USD")
- start_date (required), end_date (required - after start_date)
- auto_renewal (boolean), renewal_period_months (12)
- days_before_expiry_notification (30)
- items (array with contract terms), payment_terms, delivery_terms

Return ONLY JSON object with sales contract fields.`;
    } else if (entityType === 'sales_order') {
      systemPrompt = `Extract sales order data ONLY from: "${message}"

Create comprehensive sales order record:
- customer_id (UUID - required), order_date (today's date)
- delivery_date (future date), currency ("USD")
- priority ("NORMAL", "HIGH", "URGENT"), payment_terms
- delivery_address, delivery_terms, reference_number
- items (array with item details, quantities, pricing)

Return ONLY JSON object with sales order fields.`;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: AI_MODEL_FAST,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Create comprehensive draft record from: "${message}"` }
        ],
        max_tokens: 1000,
        temperature: 0.2
      });

      return safeJsonParse(response.choices[0]?.message?.content, {});
    } catch (error) {
      console.error('Extract create data error:', error);
      return {};
    }
  }

  /**
   * Extract update data from message using AI
   */
  async extractUpdateData(message, endpoint) {
    const systemPrompt = `Extract update data and target ID from the user's message.

CRITICAL - Smart ID Extraction Rules:
1. Look for complete business codes: INV-00000035, TEMP-20250914-915, CUST-001, etc.
2. If message says "INV number 35" or "item 35" or "customer 35", construct full code:
   - "INV number 35" → "INV-00000035" (pad with zeros to match common formats)
   - "item 35" → "TEMP-35" or search for item with number 35
   - "customer 35" → "CUST-00000035" 
3. If only number provided, try to infer from context and endpoint
4. Always return the COMPLETE business code, not just the number

Looking for:
1. Target identifier (complete business code or UUID)
2. Fields to update  
3. New values

Return JSON object with:
{
  "targetId": "COMPLETE business code or UUID",
  "changes": {
    "field1": "new_value1", 
    "field2": "new_value2"
  }
}

Examples:
- "approve INV number 35" → targetId: "INV-00000035"
- "approve item TEMP-123" → targetId: "TEMP-20250914-123" 
- "update customer 45" → targetId: "CUST-00000045"`;

    try {
      const response = await this.openai.chat.completions.create({
        model: AI_MODEL_FAST,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Extract update data from: "${message}"` }
        ],
        max_tokens: 500,
        temperature: 0.3
      });

      return safeJsonParse(response.choices[0]?.message?.content, { targetId: null, changes: {} });
    } catch (error) {
      console.error('Extract update data error:', error);
      return { targetId: null, changes: {} };
    }
  }

  /**
   * Execute create operation
   */
  async executeCreateOperation(mapping, data, authToken) {
    try {
      const url = `http://localhost:3001${mapping.endpoint}`;
      
      // Handle inventory item master ID resolution
      if (mapping.type === 'inventory_item' && data.item_master_id) {
        // If item_master_id looks like item code, convert to UUID
        if (!data.item_master_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          const itemUUID = await this._resolveItemCodeToUUID(data.item_master_id, authToken);
          if (!itemUUID) {
            return {
              success: false,
              error: `Item master with code "${data.item_master_id}" not found or not approved`
            };
          }
          data.item_master_id = itemUUID;
        }
      }
      
      // Set default status for new records
      if (!data.status) {
        data.status = 'DRAFT';
      }

      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        }
      });

      return {
        success: true,
        data: response.data.data || response.data,
        message: response.data.message || 'Record created successfully'
      };
    } catch (error) {
      console.error(`Create operation failed for ${mapping.endpoint}:`, error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  }

  /**
   * Execute update operation
   */
  async executeUpdateOperation(mapping, updateData, authToken) {
    try {
      let url = `http://localhost:3001${mapping.endpoint}`;
      
      // Replace :id with actual ID (convert item code to UUID if needed)
      if (url.includes(':id')) {
        let actualId = updateData.targetId;
        
        // If targeting items and ID looks like item code, convert to UUID
        if (url.includes('/api/items') && !actualId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          actualId = await this._resolveItemCodeToUUID(actualId, authToken);
          if (!actualId) {
            return {
              success: false,
              error: `Item with code "${updateData.targetId}" not found`
            };
          }
        }
        
        // If targeting inventory items and ID looks like item code, convert to UUID
        if (url.includes('/api/inventory-items') && !actualId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          actualId = await this._resolveInventoryItemCodeToUUID(actualId, authToken);
          if (!actualId) {
            return {
              success: false,
              error: `Inventory item with code "${updateData.targetId}" not found`
            };
          }
        }
        
        url = url.replace(':id', actualId);
      }
      
      // Handle module-specific endpoints
      if (url.includes(':module')) {
        // Determine module from the changes or context
        const module = this._determineModuleFromChanges(updateData);
        url = url.replace(':module', module);
      }

      const method = mapping.method.toLowerCase();
      let response;

      if (method === 'put' || method === 'patch') {
        response = await axios[method](url, updateData.changes, {
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          }
        });
      } else if (method === 'post') {
        // For approval/rejection endpoints
        response = await axios.post(url, updateData.changes, {
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          }
        });
      }

      return {
        success: true,
        data: response.data.data || response.data,
        message: response.data.message || 'Record updated successfully'
      };
    } catch (error) {
      console.error(`Update operation failed:`, error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  }

  /**
   * Resolve item code to UUID by fetching from API
   */
  async _resolveItemCodeToUUID(itemCode, authToken) {
    try {
      const response = await axios.get(`http://localhost:3001/api/items`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      const items = response.data.data || [];
      const item = items.find(item => item.item_code === itemCode);
      return item ? item.id : null;
    } catch (error) {
      console.error('Error resolving item code to UUID:', error.message);
      return null;
    }
  }

  /**
   * Resolve inventory item code to UUID by fetching from API
   */
  async _resolveInventoryItemCodeToUUID(itemCode, authToken) {
    try {
      const response = await axios.get(`http://localhost:3001/api/inventory-items`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      const inventoryItems = response.data.data || [];
      const inventoryItem = inventoryItems.find(item => item.item_code === itemCode);
      return inventoryItem ? inventoryItem.id : null;
    } catch (error) {
      console.error('Error resolving inventory item code to UUID:', error.message);
      return null;
    }
  }

  /**
   * Determine module from update context
   */
  _determineModuleFromChanges(updateData) {
    const targetId = updateData.targetId?.toLowerCase() || '';
    
    if (targetId.includes('po-') || targetId.includes('purchase')) return 'purchase-orders';
    if (targetId.includes('so-') || targetId.includes('sales')) return 'sales-orders';
    if (targetId.includes('cust-') || targetId.includes('customer')) return 'customers';
    if (targetId.includes('sup-') || targetId.includes('supplier')) return 'suppliers';
    if (targetId.includes('inv-') || targetId.includes('item')) return 'items';
    
    // Default fallback
    return 'items';
  }

  /**
   * Extract ID from user message for specific record requests
   */
  _extractIdFromMessage(message, endpoint) {
    // If endpoint doesn't have :id parameter, return as-is
    if (!endpoint.includes(':id')) {
      return endpoint;
    }

    // Look for common ID patterns
    const idPatterns = [
      /\b([A-Z]{2,4}-\d{5,8})\b/g,  // NV-00000016, INV-00000016, PO-12345, etc.
      /\b(id[:\s]+)([a-f0-9\-]{8,36})\b/gi,  // "id: uuid" or "id 123"
      /\b([a-f0-9\-]{8,36})\b/g,  // UUID patterns
      /\b(\d{1,10})\b/g,  // Simple numeric IDs
    ];

    for (const pattern of idPatterns) {
      const matches = message.match(pattern);
      if (matches && matches.length > 0) {
        // Use the first match as the ID
        const extractedId = matches[0].replace(/^(id[:\s]+)/i, '');
        console.log(`🔍 Extracted ID "${extractedId}" from message: "${message}"`);
        
        // For item codes like INV-00000016, NV-00000016, we need to get the full details 
        // but since the actual endpoint needs UUID, we'll use filtered list for now
        if (extractedId.match(/^[A-Z]{2,4}-\d{5,8}$/)) {
          // If it's an item/inventory code, convert to filtered list endpoint to get full details
          if (endpoint.includes('/inventory-items/:id')) {
            console.log(`🔄 Converting item code lookup to filtered list for code: ${extractedId}`);
            return endpoint.replace('/:id', `?search=${extractedId}`);
          }
          if (endpoint.includes('/items/:id')) {
            console.log(`🔄 Converting item code lookup to filtered list for code: ${extractedId}`);
            return endpoint.replace('/:id', `?search=${extractedId}`);
          }
        }
        
        return endpoint.replace(':id', extractedId);
      }
    }

    // If no ID found, return the original endpoint (will likely fail)
    console.log(`⚠️ No ID found in message for endpoint ${endpoint}`);
    return endpoint;
  }

  /**
   * Execute database query via API endpoint with proper authentication
   */
  async executeApiCall(endpoint, method = 'GET', data = null, authToken = null, originalMessage = null) {
    try {
      const baseUrl = 'http://localhost:3001';
      
      // Extract ID from message if endpoint has :id parameter
      let finalEndpoint = originalMessage ? this._extractIdFromMessage(originalMessage, endpoint) : endpoint;
      
      // Handle comprehensive entity code resolution for detailed endpoints
      finalEndpoint = await this._handleEntityCodeResolution(finalEndpoint, originalMessage, authToken, baseUrl);
      if (typeof finalEndpoint === 'object') {
        // Error case - return the error object
        return finalEndpoint;
      }
      
      // Perform the final API call
      return await this._performApiCall(`${baseUrl}${finalEndpoint}`, method, authToken, data);
    } catch (error) {
      console.error(`API call failed for ${endpoint}:`, error.message);
      return {
        success: false,
        error: error.message,
        endpoint: endpoint,
        method: method
      };
    }
  }

  /**
   * Handle comprehensive entity code resolution for all ERP entities
   */
  async _handleEntityCodeResolution(finalEndpoint, originalMessage, authToken, baseUrl) {
    // Define entity code patterns for different types
    const entityPatterns = {
      // Standard item codes: INV-00000016, NV-00000016, etc.
      itemCodes: /([A-Z]{2,4}-\d{5,8})/,
      // Purchase orders: PO-123456, etc.
      purchaseOrders: /(PO-\d{5,8})/,
      // Sales orders: SO-123456, etc.
      salesOrders: /(SO-\d{5,8})/,
      // Customer codes: CUST-123456, etc.
      customers: /(CUST-\d{5,8})/,
      // Supplier codes: SUP-123456, etc.
      suppliers: /(SUP-\d{5,8})/,
      // Contract codes: CON-123456, etc.
      contracts: /(CON-\d{5,8})/,
      // Journal entry codes: JE-123456, etc.
      journalEntries: /(JE-\d{5,8})/,
      // Account codes: 1000, 2000, etc.
      accountCodes: /(\d{4,6})/
    };

    // Check if endpoint contains entity codes or if we need to extract from message
    const entityCodeInEndpoint = this._extractEntityCodeFromEndpoint(finalEndpoint);
    let entityCode = null;
    let entityType = null;

    if (entityCodeInEndpoint) {
      entityCode = entityCodeInEndpoint.code;
      entityType = entityCodeInEndpoint.type;
      console.log(`🔍 Detected ${entityType} code in endpoint: ${entityCode}`);
    } else if (originalMessage) {
      const extracted = this._extractEntityCodeFromMessage(originalMessage, entityPatterns);
      if (extracted) {
        entityCode = extracted.code;
        entityType = extracted.type;
        console.log(`🔍 Extracted ${entityType} code from message: ${entityCode}`);
      }
    }

    // If we found an entity code, perform two-step lookup
    if (entityCode && entityType) {
      return await this._performTwoStepLookup(finalEndpoint, entityCode, entityType, authToken, baseUrl);
    }

    return finalEndpoint;
  }

  /**
   * Extract entity code from endpoint URL
   */
  _extractEntityCodeFromEndpoint(endpoint) {
    // Check for various entity code patterns in the endpoint
    const patterns = [
      { pattern: /\/inventory-items\/([A-Z]{2,4}-\d{5,8})$/, type: 'inventory-item' },
      { pattern: /\/items\/([A-Z]{2,4}-\d{5,8})$/, type: 'item' },
      { pattern: /\/purchase-orders\/(PO-\d{5,8})$/, type: 'purchase-order' },
      { pattern: /\/sales-orders\/(SO-\d{5,8})$/, type: 'sales-order' },
      { pattern: /\/customers\/(CUST-\d{5,8})$/, type: 'customer' },
      { pattern: /\/suppliers\/(SUP-\d{5,8})$/, type: 'supplier' },
      { pattern: /\/contracts\/(CON-\d{5,8})$/, type: 'contract' },
      { pattern: /\/journal-entries\/(JE-\d{5,8})$/, type: 'journal-entry' },
      { pattern: /\/chart-of-accounts\/(\d{4,6})$/, type: 'account' }
    ];

    for (const { pattern, type } of patterns) {
      const match = endpoint.match(pattern);
      if (match) {
        return { code: match[1], type };
      }
    }
    return null;
  }

  /**
   * Extract entity code from message text
   */
  _extractEntityCodeFromMessage(message, patterns) {
    for (const [type, pattern] of Object.entries(patterns)) {
      const match = message.match(pattern);
      if (match) {
        return { code: match[1], type: type.replace(/s$/, '').replace(/([A-Z])/g, '-$1').toLowerCase().substring(1) };
      }
    }
    return null;
  }

  /**
   * Perform two-step lookup: code → UUID → detailed data
   */
  async _performTwoStepLookup(finalEndpoint, entityCode, entityType, authToken, baseUrl) {
    console.log(`🔍 Attempting two-step lookup for ${entityType}: ${entityCode}`);

    // Step 1: Get UUID from entity code using search
    const searchEndpoint = this._buildSearchEndpoint(finalEndpoint, entityType, entityCode);
    console.log(`🔑 Passing auth token to search call: ${authToken ? 'YES' : 'NO'}`);
    
    const searchResult = await this._performApiCall(`${baseUrl}${searchEndpoint}`, 'GET', authToken);

    if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
      const foundEntity = searchResult.data[0];
      const entityId = foundEntity.id;
      console.log(`✅ Found UUID ${entityId} for ${entityType} code ${entityCode}`);

      // Step 2: Build detailed endpoint with UUID
      return this._buildDetailEndpoint(finalEndpoint, entityType, entityId);
    } else {
      console.log(`❌ No ${entityType} found for code ${entityCode}`);
      return {
        success: false,
        error: `No ${entityType} found with code ${entityCode}`,
        endpoint: finalEndpoint,
        method: 'GET'
      };
    }
  }

  /**
   * Build search endpoint for entity type
   */
  _buildSearchEndpoint(finalEndpoint, entityType, entityCode) {
    const endpointMap = {
      'inventory-item': `/api/inventory-items?search=${entityCode}`,
      'item': `/api/items?search=${entityCode}`,
      'purchase-order': `/api/purchase-orders?search=${entityCode}`,
      'sales-order': `/api/sales-orders?search=${entityCode}`,
      'customer': `/api/customers?search=${entityCode}`,
      'supplier': `/api/suppliers?search=${entityCode}`,
      'contract': `/api/contracts?search=${entityCode}`,
      'journal-entry': `/api/journal-entries?search=${entityCode}`,
      'account': `/api/chart-of-accounts?search=${entityCode}`
    };

    return endpointMap[entityType] || finalEndpoint.replace(/\/[^\/]+$/, `?search=${entityCode}`);
  }

  /**
   * Build detailed endpoint with UUID
   */
  _buildDetailEndpoint(finalEndpoint, entityType, entityId) {
    const endpointMap = {
      'inventory-item': `/api/inventory-items/${entityId}`,
      'item': `/api/items/${entityId}`,
      'purchase-order': `/api/purchase-orders/${entityId}`,
      'sales-order': `/api/sales-orders/${entityId}`,
      'customer': `/api/customers/${entityId}`,
      'supplier': `/api/suppliers/${entityId}`,
      'contract': `/api/contracts/${entityId}`,
      'journal-entry': `/api/journal-entries/${entityId}`,
      'account': `/api/chart-of-accounts/${entityId}`
    };

    return endpointMap[entityType] || finalEndpoint.replace(/\/[^\/]+$/, `/${entityId}`);
  }

  /**
   * Internal method to perform the actual API call
   */
  async _performApiCall(url, method = 'GET', authToken = null, data = null) {
    try {
      // Use the actual user's auth token for proper user isolation
      const config = {
        method: method.toLowerCase(),
        url: url,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      // Add authentication if token is provided
      if (authToken) {
        config.headers['Authorization'] = `Bearer ${authToken}`;
        console.log('🔐 Using auth token for API call:', url);
      } else {
        console.log('⚠️ No auth token provided for API call:', url);
      }

      if (data && (method === 'POST' || method === 'PUT')) {
        config.data = data;
      }

      const response = await axios(config);
      return {
        success: true,
        data: response.data.data || response.data,
        endpoint: url,
        method: method
      };
    } catch (error) {
      console.error(`API call failed for ${url}:`, error.message);
      
      // For auth errors, provide detailed information
      if (error.response?.status === 401) {
        console.error(`🔐 Authentication failed for ${url}:`, error.response?.data?.error || error.message);
        return {
          success: false,
          error: `Authentication required for ${url}. Please ensure you're logged in.`,
          endpoint: url,
          method: method,
          statusCode: 401
        };
      }
      
      return {
        success: false,
        error: error.message,
        endpoint: url,
        method: method
      };
    }
  }

  /**
   * Format database results for natural language response
   */
  formatDatabaseResults(results, query) {
    if (!results.success) {
      return `I encountered an issue accessing that information: ${results.error}`;
    }

    const data = results.data;
    
    // Handle different response formats
    let items = [];
    if (Array.isArray(data)) {
      items = data;
    } else if (data.items && Array.isArray(data.items)) {
      items = data.items;
    } else if (data.data && Array.isArray(data.data)) {
      items = data.data;
    } else if (typeof data === 'object') {
      return this._formatSingleObject(data, query);
    }

    if (items.length === 0) {
      return "I couldn't find any records matching your request.";
    }

    // Check if this is analytics data
    if (results.endpoint && results.endpoint.includes('/ai-analytics/')) {
      return this._formatAnalyticsData(data, query);
    }

    // Format based on query type
    const queryLower = query.toLowerCase();
    
    if (queryLower.includes('purchase order')) {
      return this._formatPurchaseOrders(items);
    } else if (queryLower.includes('sales order')) {
      return this._formatSalesOrders(items);
    } else if (queryLower.includes('customer')) {
      return this._formatCustomers(items);
    } else if (queryLower.includes('supplier')) {
      return this._formatSuppliers(items);
    } else if (queryLower.includes('item')) {
      return this._formatItems(items);
    } else if (queryLower.includes('journal') || queryLower.includes('entries')) {
      return this._formatJournalEntries(items);
    } else if (queryLower.includes('chart') || queryLower.includes('account')) {
      return this._formatChartOfAccounts(items);
    } else {
      return this._formatGenericList(items);
    }
  }

  /**
   * Format analytics data from AI analytics endpoints
   */
  _formatAnalyticsData(data, query) {
    if (!data || !data.data) return "No analytics data available.";

    const analyticsData = data.data;
    const queryLower = query.toLowerCase();

    // Sales Analytics
    if (data.data.summary && data.data.summary.total_orders !== undefined) {
      let response = `**📊 SALES PERFORMANCE ANALYTICS**\n\n`;
      
      const summary = analyticsData.summary;
      response += `**Key Metrics:**\n`;
      response += `• Total Orders: ${summary.total_orders}\n`;
      response += `• Pipeline Value: $${summary.total_pipeline_value.toLocaleString()}\n`;
      response += `• Average Deal Size: $${summary.avg_deal_size.toLocaleString()}\n`;
      response += `• Active Customers: ${summary.unique_customers}\n`;
      response += `• Conversion Rate: ${summary.conversion_rate}%\n`;
      
      if (summary.growth_rate_30d !== null) {
        const growthIcon = summary.growth_rate_30d >= 0 ? '📈' : '📉';
        response += `• 30-Day Growth: ${growthIcon} ${summary.growth_rate_30d}%\n`;
      }

      if (analyticsData.status_breakdown) {
        response += `\n**Pipeline Status:**\n`;
        const status = analyticsData.status_breakdown;
        response += `• Draft: ${status.draft} | Pending: ${status.pending_approval} | Approved: ${status.approved}\n`;
        response += `• Confirmed: ${status.confirmed} | Delivered: ${status.delivered}\n`;
      }

      if (analyticsData.top_customers && analyticsData.top_customers.length > 0) {
        response += `\n**Top Customers:**\n`;
        analyticsData.top_customers.slice(0, 3).forEach((customer, index) => {
          response += `${index + 1}. ${customer.name} - $${customer.total_value.toLocaleString()} (${customer.order_count} orders)\n`;
        });
      }

      return response;
    }

    // Customer Analytics  
    if (data.data.summary && data.data.summary.total_customers !== undefined) {
      let response = `**👥 CUSTOMER PORTFOLIO ANALYTICS**\n\n`;
      
      const summary = analyticsData.summary;
      response += `**Portfolio Overview:**\n`;
      response += `• Total Customers: ${summary.total_customers}\n`;
      response += `• Credit Extended: $${summary.total_credit_extended.toLocaleString()}\n`;
      response += `• Avg Credit Limit: $${summary.avg_credit_limit.toLocaleString()}\n`;
      response += `• Outstanding Balance: $${summary.total_outstanding.toLocaleString()}\n`;
      response += `• New Customers (30d): ${summary.new_customers_30d}\n`;

      if (analyticsData.segmentation) {
        response += `\n**Customer Segmentation:**\n`;
        const seg = analyticsData.segmentation;
        response += `• Companies: ${seg.by_type.company} | Individuals: ${seg.by_type.individual}\n`;
        response += `• Active: ${seg.by_status.active} | Inactive: ${seg.by_status.inactive}\n`;
        response += `• Risk Levels - High: ${seg.by_risk.high} | Medium: ${seg.by_risk.medium} | Low: ${seg.by_risk.low}\n`;
      }

      if (analyticsData.top_customers && analyticsData.top_customers.length > 0) {
        response += `\n**High-Value Customers:**\n`;
        analyticsData.top_customers.slice(0, 3).forEach((customer, index) => {
          response += `${index + 1}. ${customer.name} - Lifetime Value: $${customer.lifetime_value.toLocaleString()}\n`;
          response += `   Credit: $${customer.credit_limit.toLocaleString()} | Orders: ${customer.order_count}\n`;
        });
      }

      return response;
    }

    // Procurement Analytics
    if (data.data.summary && data.data.summary.total_purchase_orders !== undefined) {
      let response = `**🛒 PROCUREMENT ANALYTICS**\n\n`;
      
      const summary = analyticsData.summary;
      response += `**Procurement Overview:**\n`;
      response += `• Total Purchase Orders: ${summary.total_purchase_orders}\n`;
      response += `• Total Spend: $${summary.total_spend.toLocaleString()}\n`;
      response += `• Average PO Value: $${summary.avg_po_value.toLocaleString()}\n`;
      response += `• Active Suppliers: ${summary.unique_suppliers}\n`;
      response += `• Recent Spend (30d): $${summary.last_30_days_spend.toLocaleString()}\n`;

      if (analyticsData.status_breakdown) {
        response += `\n**PO Status Distribution:**\n`;
        const status = analyticsData.status_breakdown;
        response += `• Draft: ${status.draft} | Pending: ${status.pending_approval} | Approved: ${status.approved}\n`;
        response += `• Sent to Supplier: ${status.sent_to_supplier} | Confirmed: ${status.confirmed}\n`;
      }

      if (analyticsData.top_suppliers && analyticsData.top_suppliers.length > 0) {
        response += `\n**Key Suppliers:**\n`;
        analyticsData.top_suppliers.slice(0, 3).forEach((supplier, index) => {
          response += `${index + 1}. ${supplier.name} - $${supplier.total_spend.toLocaleString()} (${supplier.po_count} POs)\n`;
        });
      }

      return response;
    }

    // Fallback for unknown analytics format
    return `**📈 BUSINESS ANALYTICS**\n\nAnalytics data available but format not recognized. Raw data contains: ${Object.keys(analyticsData).join(', ')}`;
  }

  /**
   * Format purchase orders with business insights
   */
  _formatPurchaseOrders(orders) {
    const count = orders.length;
    if (count === 0) return "No purchase orders found.";

    // Calculate business metrics
    const totalValue = orders.reduce((sum, order) => sum + parseFloat(order.total_amount || 0), 0);
    const statusCounts = orders.reduce((acc, order) => {
      acc[order.status] = (acc[order.status] || 0) + 1;
      return acc;
    }, {});
    const avgOrderValue = totalValue / count;

    let response = `**Purchase Orders Analysis (${count} orders)**\n\n`;
    response += `• Total Pipeline Value: $${totalValue.toLocaleString()}\n`;
    response += `• Average Order Value: $${avgOrderValue.toLocaleString()}\n`;
    response += `• Status Breakdown: ${Object.entries(statusCounts).map(([status, count]) => `${status} (${count})`).join(', ')}\n\n`;

    // Show top orders by value
    const topOrders = orders.sort((a, b) => parseFloat(b.total_amount || 0) - parseFloat(a.total_amount || 0)).slice(0, 5);
    response += `**Top Purchase Orders:**\n`;
    topOrders.forEach((order, index) => {
      response += `${index + 1}. ${order.po_number} - $${parseFloat(order.total_amount || 0).toLocaleString()} (${order.status})\n`;
      response += `   Supplier: ${order.supplier_name || 'N/A'}\n`;
    });

    return response;
  }

  /**
   * Format sales orders with business insights
   */
  _formatSalesOrders(orders) {
    const count = orders.length;
    if (count === 0) return "No sales orders found.";

    // Calculate business metrics
    const totalValue = orders.reduce((sum, order) => sum + parseFloat(order.total_amount || 0), 0);
    const statusCounts = orders.reduce((acc, order) => {
      acc[order.status] = (acc[order.status] || 0) + 1;
      return acc;
    }, {});
    const avgOrderValue = totalValue / count;
    const customerCounts = orders.reduce((acc, order) => {
      acc[order.customer_name || 'Unknown'] = (acc[order.customer_name || 'Unknown'] || 0) + 1;
      return acc;
    }, {});

    let response = `**Sales Performance Analysis (${count} orders)**\n\n`;
    response += `• Total Sales Pipeline: $${totalValue.toLocaleString()}\n`;
    response += `• Average Deal Size: $${avgOrderValue.toLocaleString()}\n`;
    response += `• Order Status: ${Object.entries(statusCounts).map(([status, count]) => `${status} (${count})`).join(', ')}\n`;
    response += `• Active Customers: ${Object.keys(customerCounts).length}\n\n`;

    // Show key deals
    const keyDeals = orders.sort((a, b) => parseFloat(b.total_amount || 0) - parseFloat(a.total_amount || 0)).slice(0, 3);
    response += `**Key Opportunities:**\n`;
    keyDeals.forEach((order, index) => {
      response += `${index + 1}. ${order.so_number} - ${order.customer_name}: $${parseFloat(order.total_amount || 0).toLocaleString()}\n`;
      response += `   Status: ${order.status} | Priority: ${order.priority || 'Normal'}\n`;
    });

    return response;
  }

  /**
   * Format customers with business insights
   */
  _formatCustomers(customers) {
    const count = customers.length;
    if (count === 0) return "No customers found.";

    // Calculate business metrics
    const totalCreditLimit = customers.reduce((sum, customer) => sum + parseFloat(customer.credit_limit || 0), 0);
    const typeCounts = customers.reduce((acc, customer) => {
      acc[customer.customer_type || 'Unknown'] = (acc[customer.customer_type || 'Unknown'] || 0) + 1;
      return acc;
    }, {});
    const statusCounts = customers.reduce((acc, customer) => {
      acc[customer.status || 'Unknown'] = (acc[customer.status || 'Unknown'] || 0) + 1;
      return acc;
    }, {});

    let response = `**Customer Portfolio Analysis (${count} customers)**\n\n`;
    response += `• Total Credit Extended: $${totalCreditLimit.toLocaleString()}\n`;
    response += `• Customer Types: ${Object.entries(typeCounts).map(([type, count]) => `${type} (${count})`).join(', ')}\n`;
    response += `• Status Distribution: ${Object.entries(statusCounts).map(([status, count]) => `${status} (${count})`).join(', ')}\n\n`;

    // Show top customers by credit limit
    const topCustomers = customers
      .filter(c => parseFloat(c.credit_limit || 0) > 0)
      .sort((a, b) => parseFloat(b.credit_limit || 0) - parseFloat(a.credit_limit || 0))
      .slice(0, 5);

    if (topCustomers.length > 0) {
      response += `**Top Customers by Credit Limit:**\n`;
      topCustomers.forEach((customer, index) => {
        response += `${index + 1}. ${customer.customer_name} - $${parseFloat(customer.credit_limit || 0).toLocaleString()}\n`;
        response += `   Type: ${customer.customer_type} | Location: ${customer.billing_city || 'N/A'}\n`;
      });
    }

    return response;
  }

  /**
   * Format suppliers
   */
  _formatSuppliers(suppliers) {
    const count = suppliers.length;
    let response = `Found ${count} supplier${count !== 1 ? 's' : ''}:\n\n`;
    
    suppliers.slice(0, 10).forEach((supplier, index) => {
      response += `${index + 1}. **${supplier.legal_name || supplier.name}**\n`;
      response += `   - Email: ${supplier.email || 'N/A'}\n`;
      response += `   - Status: ${supplier.certification_status || supplier.status || 'N/A'}\n`;
      response += `   - Country: ${supplier.address_country || 'N/A'}\n`;
      response += '\n';
    });

    if (count > 10) {
      response += `... and ${count - 10} more suppliers.`;
    }

    return response;
  }

  /**
   * Format items
   */
  _formatItems(items) {
    const count = items.length;
    let response = `Found ${count} item${count !== 1 ? 's' : ''}:\n\n`;
    
    items.slice(0, 10).forEach((item, index) => {
      response += `${index + 1}. **${item.name || item.item_name}**\n`;
      response += `   - Code: ${item.item_code || item.code || 'N/A'}\n`;
      response += `   - Category: ${item.category || 'N/A'}\n`;
      response += `   - Status: ${item.status || 'N/A'}\n`;
      response += '\n';
    });

    if (count > 10) {
      response += `... and ${count - 10} more items.`;
    }

    return response;
  }

  /**
   * Format journal entries
   */
  _formatJournalEntries(items) {
    console.log('🎯 Using _formatJournalEntries formatter with', items.length, 'items');
    const count = items.length;
    let response = `**📊 JOURNAL ENTRIES** (${count} entries found)\n\n`;
    
    items.slice(0, 10).forEach((entry, index) => {
      response += `**Entry ${index + 1}**\n`;
      response += `• **Journal Number:** ${entry.journal_number}\n`;
      response += `• **Date:** ${new Date(entry.entry_date).toLocaleDateString()}\n`;
      response += `• **Description:** ${entry.description}\n`;
      response += `• **Reference:** ${entry.reference || 'N/A'}\n`;
      response += `• **Debit:** $${parseFloat(entry.total_debit).toLocaleString()}\n`;
      response += `• **Credit:** $${parseFloat(entry.total_credit).toLocaleString()}\n`;
      response += `• **Status:** ${entry.status}\n`;
      response += `• **Created By:** ${entry.created_by_name || 'System'}\n`;
      if (entry.source_type) {
        response += `• **Source:** ${entry.source_type}\n`;
      }
      response += `• **Balance Check:** ${parseFloat(entry.total_debit) === parseFloat(entry.total_credit) ? '✅ Balanced' : '❌ Unbalanced'}\n\n`;
    });
    
    if (count > 10) {
      response += `*Showing first 10 of ${count} entries. Use specific filters to see more.*\n`;
    }
    
    return response;
  }

  /**
   * Format chart of accounts
   */
  _formatChartOfAccounts(items) {
    console.log('🎯 Using _formatChartOfAccounts formatter with', items.length, 'items');
    const count = items.length;
    let response = `**📊 CHART OF ACCOUNTS** (${count} accounts found)\n\n`;
    
    // Group accounts by type for better organization
    const accountsByType = {};
    items.forEach(account => {
      if (!accountsByType[account.account_type]) {
        accountsByType[account.account_type] = [];
      }
      accountsByType[account.account_type].push(account);
    });
    
    Object.keys(accountsByType).forEach(accountType => {
      response += `**${accountType.toUpperCase()} ACCOUNTS**\n`;
      
      accountsByType[accountType].slice(0, 15).forEach(account => {
        const balance = parseFloat(account.current_balance);
        const balanceDisplay = balance !== 0 ? ` (Balance: $${balance.toLocaleString()})` : '';
        const activeStatus = account.is_active ? '🟢' : '🔴';
        const headerIndicator = account.is_header ? '📁' : '📄';
        
        response += `${activeStatus} ${headerIndicator} **${account.account_code}** - ${account.account_name}${balanceDisplay}\n`;
        if (account.account_subtype && account.account_subtype !== account.account_type) {
          response += `   └ *${account.account_subtype}*\n`;
        }
      });
      response += `\n`;
    });
    
    // Summary statistics
    const totalBalance = items.reduce((sum, account) => sum + parseFloat(account.current_balance || 0), 0);
    const activeAccounts = items.filter(account => account.is_active).length;
    const headerAccounts = items.filter(account => account.is_header).length;
    
    response += `**SUMMARY**\n`;
    response += `• Total Accounts: ${count}\n`;
    response += `• Active Accounts: ${activeAccounts}\n`;
    response += `• Header Accounts: ${headerAccounts}\n`;
    response += `• Total Balance: $${totalBalance.toLocaleString()}\n`;
    
    return response;
  }

  /**
   * Format generic list
   */
  _formatGenericList(items) {
    const count = items.length;
    return `Found ${count} record${count !== 1 ? 's' : ''} matching your request.`;
  }

  /**
   * Format single object
   */
  _formatSingleObject(data, query) {
    if (data.error) {
      return `I encountered an issue: ${data.error}`;
    }

    return `Here's the information I found: ${JSON.stringify(data, null, 2)}`;
  }

  /**
   * Load API endpoints mapping
   */
  _loadApiEndpoints() {
    return {
      'purchase_orders': '/api/purchase-orders',
      'sales_orders': '/api/sales-orders',
      'items': '/api/items',
      'inventory_items': '/api/inventory-items',
      'customers': '/api/customers',
      'suppliers': '/api/suppliers',
      'contracts': '/api/contracts',
      'quotations': '/api/sales-quotations',
      'journal_entries': '/api/journal-entries',
      'balance_sheet': '/api/finance/balance-sheet',
      'income_statement': '/api/finance/income-statement'
    };
  }
}

module.exports = IntelligentChatRouter;