/**
 * Intelligent Schema Analyzer for Simeli AI System
 * Maps database tables to business concepts and selects only relevant tables for queries
 */
class IntelligentSchemaAnalyzer {
  constructor() {
    this.tableMapping = {
      // Core Master Data
      items: {
        description: "Item Master - Products, materials, and inventory items",
        keywords: ["item", "product", "material", "inventory", "stock", "master"],
        priority: "high",
        relationships: ["inventory_items", "purchase_order_line_items", "sales_order_items"]
      },
      customers: {
        description: "Customer Master - Client and customer information",
        keywords: ["customer", "client", "buyer", "account"],
        priority: "high", 
        relationships: ["sales_orders", "customer_invoices", "sales_contracts"]
      },
      suppliers: {
        description: "Supplier Master - Vendor and supplier information", 
        keywords: ["supplier", "vendor", "provider"],
        priority: "high",
        relationships: ["purchase_orders", "contracts", "supplier_items"]
      },
      users: {
        description: "System Users - Employee and user accounts",
        keywords: ["user", "employee", "staff", "person"],
        priority: "medium",
        relationships: []
      },

      // Sales Module
      sales_orders: {
        description: "Sales Orders - Customer orders and sales transactions",
        keywords: ["sales", "order", "so", "customer order"],
        priority: "high",
        relationships: ["sales_order_items", "customers", "delivery_schedules"]
      },
      sales_order_items: {
        description: "Sales Order Line Items - Individual items in sales orders",
        keywords: ["sales order item", "line item", "order detail"],
        priority: "medium",
        relationships: ["sales_orders", "items"]
      },
      sales_quotations: {
        description: "Sales Quotations - Price quotes for customers",
        keywords: ["quotation", "quote", "proposal", "estimate"],
        priority: "medium",
        relationships: ["sales_quotation_items", "customers"]
      },
      sales_contracts: {
        description: "Sales Contracts - Customer agreements and contracts",
        keywords: ["sales contract", "agreement", "deal"],
        priority: "medium",
        relationships: ["customers", "sales_contract_items"]
      },

      // Procurement Module  
      purchase_orders: {
        description: "Purchase Orders - Supplier orders and procurement",
        keywords: ["purchase", "po", "procurement", "supplier order"],
        priority: "high",
        relationships: ["purchase_order_line_items", "suppliers"]
      },
      purchase_order_line_items: {
        description: "Purchase Order Line Items - Items in purchase orders",
        keywords: ["purchase order item", "po item", "procurement item"],
        priority: "medium", 
        relationships: ["purchase_orders", "items"]
      },
      purchase_requisitions: {
        description: "Purchase Requisitions - Internal purchase requests",
        keywords: ["requisition", "pr", "purchase request"],
        priority: "medium",
        relationships: ["items"]
      },
      rfqs: {
        description: "Request for Quotations - Supplier quote requests", 
        keywords: ["rfq", "request for quote", "tender"],
        priority: "medium",
        relationships: ["suppliers", "rfq_line_items"]
      },

      // Inventory Module
      inventory_items: {
        description: "Inventory Items - Stock levels and inventory tracking",
        keywords: ["inventory", "stock", "warehouse", "available"],
        priority: "high",
        relationships: ["items", "inventory_storage_mappings"]
      },
      warehouse_transactions: {
        description: "Warehouse Transactions - Inventory movements",
        keywords: ["warehouse", "movement", "transaction", "receipt", "issue"],
        priority: "medium",
        relationships: ["inventory_items", "warehouse_transaction_items"]
      },
      storage_locations: {
        description: "Storage Locations - Warehouse locations and zones",
        keywords: ["storage", "location", "warehouse", "zone"],
        priority: "low",
        relationships: ["bins", "inventory_storage_mappings"]
      },
      bins: {
        description: "Storage Bins - Specific storage positions",
        keywords: ["bin", "position", "slot", "location"],
        priority: "low",
        relationships: ["storage_locations", "inventory_storage_mappings"]
      },

      // Finance Module
      customer_invoices: {
        description: "Customer Invoices - Bills sent to customers",
        keywords: ["invoice", "bill", "receivable"],
        priority: "medium",
        relationships: ["customers", "sales_orders", "customer_invoice_items"]
      },
      customer_payments: {
        description: "Customer Payments - Payments received from customers",
        keywords: ["payment", "receipt", "cash", "collection"],
        priority: "medium",
        relationships: ["customers", "customer_invoices"]
      },
      chart_of_accounts: {
        description: "Chart of Accounts - Financial account structure",
        keywords: ["account", "gl", "financial", "ledger"],
        priority: "low",
        relationships: ["journal_entries", "journal_entry_items"]
      },
      journal_entries: {
        description: "Journal Entries - Financial transactions",
        keywords: ["journal", "accounting", "finance", "transaction"],
        priority: "low",
        relationships: ["journal_entry_items", "chart_of_accounts"]
      },

      // Delivery Module
      delivery_schedules: {
        description: "Delivery Schedules - Shipment and delivery planning",
        keywords: ["delivery", "shipment", "dispatch", "shipping"],
        priority: "medium",
        relationships: ["sales_orders", "delivery_items"]
      },

      // System Tables (usually not needed for business queries)
      notifications: {
        description: "System Notifications - Internal system messages",
        keywords: ["notification", "alert", "message"],
        priority: "very_low",
        relationships: []
      },
      delegation_of_authority: {
        description: "Authorization Rules - User permission levels",
        keywords: ["authority", "permission", "authorization"],
        priority: "very_low", 
        relationships: ["users"]
      }
    };
  }

  /**
   * Analyze query intent and select relevant tables
   */
  analyzeQueryIntent(naturalLanguageQuery, intentType = 'database_query') {
    const query = naturalLanguageQuery.toLowerCase();
    const relevantTables = [];
    const scores = {};

    // Score each table based on keyword matches
    for (const [tableName, tableInfo] of Object.entries(this.tableMapping)) {
      let score = 0;
      
      // Direct keyword matching
      for (const keyword of tableInfo.keywords) {
        if (query.includes(keyword)) {
          score += 10;
        }
      }

      // Priority bonus
      if (tableInfo.priority === 'high') score += 5;
      else if (tableInfo.priority === 'medium') score += 2;
      else if (tableInfo.priority === 'very_low') score -= 5;

      // Intent-specific bonuses
      if (intentType === 'database_operation') {
        // For CREATE/INSERT operations, prioritize master tables
        if (['items', 'customers', 'suppliers'].includes(tableName)) {
          score += 15;
        }
      }

      if (score > 0) {
        scores[tableName] = score;
      }
    }

    // Sort by score and take top relevant tables
    const sortedTables = Object.entries(scores)
      .sort(([,a], [,b]) => b - a)
      .slice(0, intentType === 'database_operation' ? 3 : 8); // Fewer tables for operations

    // Add relationship tables for context
    const finalTables = new Set();
    sortedTables.forEach(([tableName, score]) => {
      finalTables.add(tableName);
      
      // Add key relationship tables for context (max 2 per table)
      const relationships = this.tableMapping[tableName].relationships.slice(0, 2);
      relationships.forEach(relTable => {
        if (this.tableMapping[relTable] && this.tableMapping[relTable].priority !== 'very_low') {
          finalTables.add(relTable);
        }
      });
    });

    console.log(`🎯 Query analysis for: "${naturalLanguageQuery}"`);
    console.log(`📊 Selected ${finalTables.size} relevant tables:`, Array.from(finalTables));
    console.log(`⚡ Performance gain: ${Math.round((1 - finalTables.size/62) * 100)}% fewer tables`);

    return {
      relevantTables: Array.from(finalTables),
      scores: scores,
      totalTablesReduced: 62 - finalTables.size,
      performanceGain: Math.round((1 - finalTables.size/62) * 100)
    };
  }

  /**
   * Get table descriptions for AI context
   */
  getTableDescriptions(tableNames) {
    const descriptions = {};
    tableNames.forEach(tableName => {
      if (this.tableMapping[tableName]) {
        descriptions[tableName] = this.tableMapping[tableName].description;
      }
    });
    return descriptions;
  }

  /**
   * Get user-filtered table names (tables that should have user filtering)
   */
  getUserFilteredTables() {
    return [
      'items',           // user_id column
      'customers',       // created_by column  
      'suppliers',       // created_by column
      'sales_orders',    // created_by column
      'purchase_orders', // created_by column
      'inventory_items', // user_id column
      'sales_quotations',// created_by column
      'purchase_requisitions' // created_by column
    ];
  }

  /**
   * Check if table requires user context filtering
   */
  requiresUserFiltering(tableName) {
    return this.getUserFilteredTables().includes(tableName);
  }

  /**
   * Get the user filter column for a table
   */
  getUserFilterColumn(tableName) {
    const userIdTables = ['items', 'inventory_items'];
    const createdByTables = ['customers', 'suppliers', 'sales_orders', 'purchase_orders', 'sales_quotations', 'purchase_requisitions'];
    
    if (userIdTables.includes(tableName)) {
      return 'user_id';
    } else if (createdByTables.includes(tableName)) {
      return 'created_by';
    }
    
    return null;
  }
}

module.exports = new IntelligentSchemaAnalyzer();