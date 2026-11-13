const express = require('express');
const router = express.Router();
// Require authentication for every route in this file. Not currently mounted in
// server.js, but gated here so it is safe the moment it is wired up (audit B15).
const { auth } = require('../middleware/auth');
router.use(auth);
const aiModuleService = require('../services/aiModuleService');
const { pool } = require('../config/database');

// 🎯 SALES MODULE AI ENDPOINTS

// Sales Opportunity Analysis
router.post('/sales/analyze-opportunity/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const [customerData, orderHistory, marketData] = await Promise.all([
      pool.query(`
        SELECT c.*, 
          COUNT(so.id) as total_orders,
          SUM(so.total_amount) as total_spent,
          AVG(so.total_amount) as avg_order_value,
          MAX(so.order_date) as last_order_date,
          EXTRACT(EPOCH FROM (CURRENT_DATE - MAX(so.order_date))) / (24*60*60) as days_since_last_order
        FROM customers c
        LEFT JOIN sales_orders so ON c.id = so.customer_id AND so.status = 'COMPLETED'
        WHERE c.id = $1
        GROUP BY c.id
      `, [customerId]),
      
      pool.query(`
        SELECT so.*, soi.item_name, soi.quantity, soi.unit_price
        FROM sales_orders so
        LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
        WHERE so.customer_id = $1 AND so.status = 'COMPLETED'
        ORDER BY so.order_date DESC
        LIMIT 10
      `, [customerId]),
      
      pool.query(`
        SELECT 
          AVG(total_amount) as market_avg_order,
          COUNT(DISTINCT customer_id) as total_customers,
          SUM(total_amount) as total_market_value
        FROM sales_orders 
        WHERE status = 'COMPLETED' AND order_date >= CURRENT_DATE - INTERVAL '90 days'
      `)
    ]);
    
    const analysis = await aiModuleService.analyzeSalesOpportunity(
      customerData.rows[0],
      orderHistory.rows,
      marketData.rows[0]
    );
    
    res.json({
      success: true,
      customerId,
      salesOpportunity: analysis,
      customerProfile: customerData.rows[0],
      recentOrders: orderHistory.rows
    });
  } catch (error) {
    console.error('Sales opportunity analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Quote Intelligence for RFQs
router.post('/sales/quote-intelligence/:rfqId', async (req, res) => {
  try {
    const { rfqId } = req.params;
    
    const [rfqData, competitorData] = await Promise.all([
      pool.query(`
        SELECT sr.*, c.customer_name, c.customer_type,
          sri.item_name, sri.quantity, sri.specifications
        FROM sales_rfqs sr
        LEFT JOIN customers c ON sr.customer_id = c.id
        LEFT JOIN sales_rfq_items sri ON sr.id = sri.sales_rfq_id
        WHERE sr.id = $1
      `, [rfqId]),
      
      pool.query(`
        SELECT 
          AVG(soi.unit_price) as avg_market_price,
          MIN(soi.unit_price) as min_price,
          MAX(soi.unit_price) as max_price,
          COUNT(*) as market_transactions
        FROM sales_order_items soi
        JOIN sales_orders so ON soi.sales_order_id = so.id
        WHERE soi.item_name ILIKE $1 AND so.status = 'COMPLETED'
      `, [`%${rfqData.rows[0]?.item_name || 'electronics'}%`])
    ]);
    
    const intelligence = await aiModuleService.generateQuoteIntelligence(
      rfqData.rows[0],
      competitorData.rows[0]
    );
    
    res.json({
      success: true,
      rfqId,
      quoteIntelligence: intelligence,
      rfqDetails: rfqData.rows,
      marketBenchmark: competitorData.rows[0]
    });
  } catch (error) {
    console.error('Quote intelligence error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🛒 PROCUREMENT MODULE AI ENDPOINTS

// Purchase Decision Optimization
router.post('/procurement/optimize-purchase/:prId', async (req, res) => {
  try {
    const { prId } = req.params;
    
    const [prData, supplierOptions, budgetData] = await Promise.all([
      pool.query(`
        SELECT pr.*, pri.item_name, pri.quantity, pri.estimated_cost
        FROM purchase_requisitions pr
        LEFT JOIN purchase_requisition_items pri ON pr.id = pri.purchase_requisition_id
        WHERE pr.id = $1
      `, [prId]),
      
      pool.query(`
        SELECT s.*, 
          COUNT(po.id) as order_history,
          AVG(po.total_amount) as avg_order_value,
          AVG(EXTRACT(EPOCH FROM (po.delivered_date - po.order_date)) / (24*60*60)) as avg_delivery_days
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.id = po.supplier_id AND po.status = 'COMPLETED'
        WHERE s.status = 'APPROVED'
        GROUP BY s.id
        HAVING COUNT(po.id) > 0
        ORDER BY avg_delivery_days ASC, avg_order_value DESC
      `),
      
      pool.query(`
        SELECT 
          SUM(total_amount) as total_budget_used,
          COUNT(*) as total_orders,
          AVG(total_amount) as avg_spend
        FROM purchase_orders 
        WHERE EXTRACT(MONTH FROM order_date) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND EXTRACT(YEAR FROM order_date) = EXTRACT(YEAR FROM CURRENT_DATE)
      `)
    ]);
    
    const optimization = await aiModuleService.optimizePurchaseDecision(
      prData.rows[0],
      supplierOptions.rows,
      budgetData.rows[0]
    );
    
    res.json({
      success: true,
      prId,
      purchaseOptimization: optimization,
      prDetails: prData.rows,
      availableSuppliers: supplierOptions.rows,
      budgetContext: budgetData.rows[0]
    });
  } catch (error) {
    console.error('Purchase optimization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Spend Pattern Analysis
router.get('/procurement/spend-analysis', async (req, res) => {
  try {
    const { timeframe = '90days' } = req.query;
    
    const [spendData, categoryData] = await Promise.all([
      pool.query(`
        SELECT 
          s.legal_name,
          SUM(po.total_amount) as total_spend,
          COUNT(po.id) as order_count,
          AVG(po.total_amount) as avg_order_value,
          po.category
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.status = 'COMPLETED' 
          AND po.order_date >= CURRENT_DATE - INTERVAL '${timeframe}'
        GROUP BY s.id, s.legal_name, po.category
        ORDER BY total_spend DESC
      `),
      
      pool.query(`
        SELECT 
          category,
          SUM(total_amount) as category_spend,
          COUNT(*) as category_orders,
          COUNT(DISTINCT supplier_id) as unique_suppliers
        FROM purchase_orders
        WHERE status = 'COMPLETED' 
          AND order_date >= CURRENT_DATE - INTERVAL '${timeframe}'
        GROUP BY category
        ORDER BY category_spend DESC
      `)
    ]);
    
    const analysis = await aiModuleService.analyzeSpendPattern(
      spendData.rows,
      categoryData.rows
    );
    
    res.json({
      success: true,
      timeframe,
      spendAnalysis: analysis,
      spendBySupplier: spendData.rows,
      spendByCategory: categoryData.rows
    });
  } catch (error) {
    console.error('Spend analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 📦 INVENTORY MODULE AI ENDPOINTS

// Inventory Strategy Optimization
router.post('/inventory/optimize-strategy/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    
    const [inventoryData, usageHistory, seasonalData] = await Promise.all([
      pool.query(`
        SELECT ii.*, i.name, i.specifications,
          wt.avg_monthly_usage,
          wt.last_movement_date,
          ii.minimum_stock_level,
          ii.maximum_stock_level
        FROM inventory_items ii
        LEFT JOIN items i ON ii.item_master_id = i.id
        LEFT JOIN (
          SELECT 
            inventory_item_id,
            AVG(quantity) as avg_monthly_usage,
            MAX(transaction_date) as last_movement_date
          FROM warehouse_transactions
          WHERE transaction_type = 'ISSUE'
          GROUP BY inventory_item_id
        ) wt ON ii.id = wt.inventory_item_id
        WHERE ii.id = $1
      `, [itemId]),
      
      pool.query(`
        SELECT 
          DATE_TRUNC('month', transaction_date) as month,
          SUM(quantity) as monthly_usage,
          COUNT(*) as transaction_count
        FROM warehouse_transactions
        WHERE inventory_item_id = $1 
          AND transaction_type = 'ISSUE'
          AND transaction_date >= CURRENT_DATE - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', transaction_date)
        ORDER BY month
      `, [itemId]),
      
      pool.query(`
        SELECT 
          EXTRACT(QUARTER FROM transaction_date) as quarter,
          AVG(quantity) as avg_quarterly_usage,
          MAX(quantity) as peak_usage,
          MIN(quantity) as min_usage
        FROM warehouse_transactions
        WHERE inventory_item_id = $1
          AND transaction_type = 'ISSUE'
          AND transaction_date >= CURRENT_DATE - INTERVAL '24 months'
        GROUP BY EXTRACT(QUARTER FROM transaction_date)
        ORDER BY quarter
      `, [itemId])
    ]);
    
    const optimization = await aiModuleService.optimizeInventoryStrategy(
      inventoryData.rows[0],
      usageHistory.rows,
      seasonalData.rows
    );
    
    res.json({
      success: true,
      itemId,
      inventoryOptimization: optimization,
      currentData: inventoryData.rows[0],
      usagePatterns: usageHistory.rows,
      seasonalTrends: seasonalData.rows
    });
  } catch (error) {
    console.error('Inventory optimization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stock Movement Prediction
router.post('/inventory/predict-movement/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    
    const [itemData, marketTrends, businessCycle] = await Promise.all([
      pool.query(`
        SELECT ii.*, i.name,
          COUNT(soi.id) as sales_frequency,
          AVG(soi.quantity) as avg_sales_quantity
        FROM inventory_items ii
        LEFT JOIN items i ON ii.item_master_id = i.id
        LEFT JOIN sales_order_items soi ON ii.id = soi.inventory_item_id
        LEFT JOIN sales_orders so ON soi.sales_order_id = so.id AND so.status = 'COMPLETED'
        WHERE ii.id = $1
        GROUP BY ii.id, i.name
      `, [itemId]),
      
      pool.query(`
        SELECT 
          DATE_TRUNC('week', order_date) as week,
          COUNT(*) as orders_per_week,
          SUM(total_amount) as revenue_per_week
        FROM sales_orders
        WHERE status = 'COMPLETED' 
          AND order_date >= CURRENT_DATE - INTERVAL '12 weeks'
        GROUP BY DATE_TRUNC('week', order_date)
        ORDER BY week
      `),
      
      pool.query(`
        SELECT 
          EXTRACT(MONTH FROM created_at) as month,
          COUNT(*) as business_volume,
          'normal' as cycle_phase
        FROM sales_orders
        WHERE created_at >= CURRENT_DATE - INTERVAL '12 months'
        GROUP BY EXTRACT(MONTH FROM created_at)
        ORDER BY month
      `)
    ]);
    
    const prediction = await aiModuleService.predictStockMovement(
      itemData.rows[0],
      marketTrends.rows,
      businessCycle.rows
    );
    
    res.json({
      success: true,
      itemId,
      stockMovementPrediction: prediction,
      itemData: itemData.rows[0],
      marketContext: marketTrends.rows
    });
  } catch (error) {
    console.error('Stock movement prediction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🏭 WAREHOUSE MODULE AI ENDPOINTS

// Warehouse Operations Optimization
router.get('/warehouse/optimize-operations', async (req, res) => {
  try {
    const [warehouseData, pickingPatterns, layoutData] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) as total_transactions,
          AVG(quantity) as avg_transaction_size,
          COUNT(DISTINCT inventory_item_id) as unique_items,
          COUNT(DISTINCT user_id) as active_users
        FROM warehouse_transactions
        WHERE transaction_date >= CURRENT_DATE - INTERVAL '30 days'
      `),
      
      pool.query(`
        SELECT 
          transaction_type,
          COUNT(*) as frequency,
          AVG(quantity) as avg_quantity,
          EXTRACT(HOUR FROM created_at) as peak_hour
        FROM warehouse_transactions
        WHERE transaction_date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY transaction_type, EXTRACT(HOUR FROM created_at)
        ORDER BY frequency DESC
      `),
      
      pool.query(`
        SELECT 
          sl.name as location_name,
          COUNT(ism.id) as items_stored,
          AVG(ism.quantity_in_location) as avg_quantity,
          sl.capacity,
          COUNT(b.id) as total_bins
        FROM storage_locations sl
        LEFT JOIN inventory_storage_mappings ism ON sl.id = ism.storage_location_id
        LEFT JOIN bins b ON sl.id = b.storage_location_id
        GROUP BY sl.id, sl.name, sl.capacity
      `)
    ]);
    
    const optimization = await aiModuleService.optimizeWarehouseOperations(
      warehouseData.rows[0],
      pickingPatterns.rows,
      layoutData.rows
    );
    
    res.json({
      success: true,
      warehouseOptimization: optimization,
      currentMetrics: warehouseData.rows[0],
      operationalPatterns: pickingPatterns.rows,
      layoutAnalysis: layoutData.rows
    });
  } catch (error) {
    console.error('Warehouse optimization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Picking Time Prediction
router.post('/warehouse/predict-picking', async (req, res) => {
  try {
    const { orderItems } = req.body;
    
    const [warehouseLayout, staffingData] = await Promise.all([
      pool.query(`
        SELECT 
          sl.name,
          sl.location_code,
          COUNT(b.id) as bin_count,
          AVG(b.capacity) as avg_bin_capacity
        FROM storage_locations sl
        LEFT JOIN bins b ON sl.id = b.storage_location_id
        GROUP BY sl.id, sl.name, sl.location_code
      `),
      
      pool.query(`
        SELECT 
          COUNT(DISTINCT user_id) as available_staff,
          AVG(COUNT(*)) OVER() as avg_productivity
        FROM warehouse_transactions
        WHERE transaction_date >= CURRENT_DATE - INTERVAL '7 days'
          AND transaction_type = 'ISSUE'
        GROUP BY user_id
      `)
    ]);
    
    const prediction = await aiModuleService.predictPickingTime(
      orderItems,
      warehouseLayout.rows,
      staffingData.rows[0]
    );
    
    res.json({
      success: true,
      pickingPrediction: prediction,
      orderItems,
      warehouseContext: {
        layout: warehouseLayout.rows,
        staffing: staffingData.rows[0]
      }
    });
  } catch (error) {
    console.error('Picking prediction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 👥 SUPPLIER MODULE AI ENDPOINTS

// Supplier Risk Assessment
router.post('/suppliers/assess-risk/:supplierId', async (req, res) => {
  try {
    const { supplierId } = req.params;
    
    const [supplierData, performanceHistory, marketData] = await Promise.all([
      pool.query(`
        SELECT s.*, 
          COUNT(po.id) as total_orders,
          SUM(po.total_amount) as total_business,
          AVG(po.total_amount) as avg_order_value
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.id = po.supplier_id
        WHERE s.id = $1
        GROUP BY s.id
      `, [supplierId]),
      
      pool.query(`
        SELECT 
          po.order_date,
          po.delivered_date,
          po.expected_delivery_date,
          po.total_amount,
          po.status,
          CASE 
            WHEN po.delivered_date > po.expected_delivery_date THEN 'LATE'
            WHEN po.delivered_date <= po.expected_delivery_date THEN 'ON_TIME'
            ELSE 'PENDING'
          END as delivery_performance
        FROM purchase_orders po
        WHERE po.supplier_id = $1
          AND po.order_date >= CURRENT_DATE - INTERVAL '12 months'
        ORDER BY po.order_date DESC
      `, [supplierId]),
      
      pool.query(`
        SELECT 
          COUNT(DISTINCT supplier_id) as total_suppliers,
          AVG(total_amount) as market_avg_order,
          COUNT(*) as market_activity
        FROM purchase_orders
        WHERE status = 'COMPLETED'
          AND order_date >= CURRENT_DATE - INTERVAL '90 days'
      `)
    ]);
    
    const riskAssessment = await aiModuleService.assessSupplierRisk(
      supplierData.rows[0],
      performanceHistory.rows,
      marketData.rows[0]
    );
    
    res.json({
      success: true,
      supplierId,
      riskAssessment,
      supplierProfile: supplierData.rows[0],
      performanceData: performanceHistory.rows
    });
  } catch (error) {
    console.error('Supplier risk assessment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Supplier Portfolio Optimization
router.get('/suppliers/optimize-portfolio', async (req, res) => {
  try {
    const [currentSuppliers, categoryRequirements, performanceData] = await Promise.all([
      pool.query(`
        SELECT 
          s.id,
          s.legal_name,
          s.supplier_category,
          COUNT(po.id) as order_frequency,
          SUM(po.total_amount) as total_spend,
          AVG(CASE 
            WHEN po.delivered_date <= po.expected_delivery_date THEN 1 
            ELSE 0 
          END) as on_time_rate
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.id = po.supplier_id AND po.status = 'COMPLETED'
        WHERE s.status = 'APPROVED'
        GROUP BY s.id, s.legal_name, s.supplier_category
        HAVING COUNT(po.id) > 0
      `),
      
      pool.query(`
        SELECT 
          category,
          COUNT(DISTINCT supplier_id) as supplier_count,
          SUM(total_amount) as category_spend,
          AVG(total_amount) as avg_order_value
        FROM purchase_orders
        WHERE status = 'COMPLETED'
          AND order_date >= CURRENT_DATE - INTERVAL '90 days'
        GROUP BY category
      `),
      
      pool.query(`
        SELECT 
          s.legal_name,
          AVG(po.quality_rating) as avg_quality,
          COUNT(CASE WHEN po.status = 'REJECTED' THEN 1 END) as rejection_count,
          COUNT(po.id) as total_orders
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.id = po.supplier_id
        GROUP BY s.id, s.legal_name
        HAVING COUNT(po.id) > 0
      `)
    ]);
    
    const optimization = await aiModuleService.optimizeSupplierMix(
      currentSuppliers.rows,
      categoryRequirements.rows,
      performanceData.rows
    );
    
    res.json({
      success: true,
      supplierOptimization: optimization,
      currentPortfolio: currentSuppliers.rows,
      categoryAnalysis: categoryRequirements.rows,
      performanceMetrics: performanceData.rows
    });
  } catch (error) {
    console.error('Supplier optimization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 👨‍💼 CUSTOMER MODULE AI ENDPOINTS

// Customer Value Analysis
router.post('/customers/analyze-value/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const [customerProfile, transactionHistory, marketSegment] = await Promise.all([
      pool.query(`
        SELECT c.*,
          COUNT(so.id) as total_orders,
          SUM(so.total_amount) as lifetime_value,
          AVG(so.total_amount) as avg_order_value,
          MAX(so.order_date) as last_order_date,
          MIN(so.order_date) as first_order_date
        FROM customers c
        LEFT JOIN sales_orders so ON c.id = so.customer_id AND so.status = 'COMPLETED'
        WHERE c.id = $1
        GROUP BY c.id
      `, [customerId]),
      
      pool.query(`
        SELECT 
          so.order_date,
          so.total_amount,
          so.payment_terms,
          so.delivery_date,
          COUNT(soi.id) as items_count,
          STRING_AGG(DISTINCT soi.item_name, ', ') as purchased_items
        FROM sales_orders so
        LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
        WHERE so.customer_id = $1 AND so.status = 'COMPLETED'
        GROUP BY so.id, so.order_date, so.total_amount, so.payment_terms, so.delivery_date
        ORDER BY so.order_date DESC
        LIMIT 20
      `, [customerId]),
      
      pool.query(`
        SELECT 
          billing_country,
          customer_type,
          COUNT(*) as segment_size,
          AVG(
            (SELECT SUM(total_amount) FROM sales_orders so2 WHERE so2.customer_id = c2.id AND so2.status = 'COMPLETED')
          ) as segment_avg_ltv
        FROM customers c2
        WHERE billing_country = (SELECT billing_country FROM customers WHERE id = $1)
          AND customer_type = (SELECT customer_type FROM customers WHERE id = $1)
        GROUP BY billing_country, customer_type
      `, [customerId])
    ]);
    
    const analysis = await aiModuleService.analyzeCustomerValue(
      customerProfile.rows[0],
      transactionHistory.rows,
      marketSegment.rows[0]
    );
    
    res.json({
      success: true,
      customerId,
      customerValue: analysis,
      customerProfile: customerProfile.rows[0],
      orderHistory: transactionHistory.rows,
      marketContext: marketSegment.rows[0]
    });
  } catch (error) {
    console.error('Customer value analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Customer Experience Personalization
router.post('/customers/personalize-experience/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const [customerData, interactionHistory, preferences] = await Promise.all([
      pool.query(`
        SELECT c.*, 
          COUNT(so.id) as order_frequency,
          STRING_AGG(DISTINCT soi.item_name, ', ') as favorite_products
        FROM customers c
        LEFT JOIN sales_orders so ON c.id = so.customer_id
        LEFT JOIN sales_order_items soi ON so.id = soi.sales_order_id
        WHERE c.id = $1
        GROUP BY c.id
      `, [customerId]),
      
      pool.query(`
        SELECT 
          n.type,
          n.created_at,
          n.message,
          n.status
        FROM notifications n
        WHERE n.recipient_id = $1
        ORDER BY n.created_at DESC
        LIMIT 50
      `, [customerId]),
      
      pool.query(`
        SELECT 
          preferred_delivery_method,
          preferred_payment_terms,
          communication_preferences
        FROM customer_preferences
        WHERE customer_id = $1
      `, [customerId])
    ]);
    
    const personalization = await aiModuleService.personalizeCustomerExperience(
      customerData.rows[0],
      interactionHistory.rows,
      preferences.rows[0] || {}
    );
    
    res.json({
      success: true,
      customerId,
      personalization,
      customerData: customerData.rows[0],
      interactionHistory: interactionHistory.rows
    });
  } catch (error) {
    console.error('Customer personalization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 📊 OPERATIONS MODULE AI ENDPOINTS

// Business Process Optimization
router.post('/operations/optimize-process', async (req, res) => {
  try {
    const { processName, timeframe = '30days' } = req.body;
    
    const [processData, performanceMetrics, userFeedback] = await Promise.all([
      pool.query(`
        SELECT 
          '${processName}' as process_name,
          COUNT(*) as total_instances,
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600) as avg_processing_hours,
          COUNT(CASE WHEN status LIKE '%PENDING%' THEN 1 END) as pending_items,
          COUNT(CASE WHEN status LIKE '%APPROVED%' THEN 1 END) as approved_items,
          COUNT(CASE WHEN status LIKE '%REJECTED%' THEN 1 END) as rejected_items
        FROM ${processName}
        WHERE created_at >= CURRENT_DATE - INTERVAL '${timeframe}'
      `),
      
      pool.query(`
        SELECT 
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) as avg_processing_minutes,
          MIN(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) as fastest_processing,
          MAX(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) as slowest_processing,
          STDDEV(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) as processing_variance
        FROM ${processName}
        WHERE status NOT LIKE '%PENDING%' 
          AND created_at >= CURRENT_DATE - INTERVAL '${timeframe}'
      `),
      
      pool.query(`
        SELECT 
          'user_feedback' as source,
          COUNT(*) as feedback_items,
          'Generally positive' as sentiment
      `)
    ]);
    
    const optimization = await aiModuleService.optimizeBusinessProcess(
      processData.rows[0],
      performanceMetrics.rows[0],
      userFeedback.rows
    );
    
    res.json({
      success: true,
      processName,
      processOptimization: optimization,
      currentMetrics: {
        process: processData.rows[0],
        performance: performanceMetrics.rows[0]
      }
    });
  } catch (error) {
    console.error('Process optimization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🤖 CROSS-MODULE AI ENDPOINTS

// Natural Language Command Processing
router.post('/nlp/process-command', async (req, res) => {
  try {
    const { command, userContext } = req.body;
    
    // Get current system state
    const systemState = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM sales_orders WHERE status = 'PENDING_APPROVAL') as pending_sales,
        (SELECT COUNT(*) FROM purchase_orders WHERE status = 'PENDING_APPROVAL') as pending_purchases,
        (SELECT COUNT(*) FROM inventory_items WHERE current_stock_quantity < minimum_stock_level) as low_stock_items,
        (SELECT COUNT(*) FROM notifications WHERE status = 'UNREAD' AND recipient_id = $1) as unread_notifications
    `, [userContext.userId]);
    
    const processing = await aiModuleService.processNaturalLanguageCommand(
      command,
      userContext,
      systemState.rows[0]
    );
    
    res.json({
      success: true,
      command,
      processing,
      systemContext: systemState.rows[0]
    });
  } catch (error) {
    console.error('NLP processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate Actionable Insights
router.post('/insights/generate', async (req, res) => {
  try {
    const { moduleData, userRole, businessGoals } = req.body;
    
    const insights = await aiModuleService.generateActionableInsights(
      moduleData,
      userRole,
      businessGoals
    );
    
    res.json({
      success: true,
      actionableInsights: insights,
      generatedFor: userRole,
      focusAreas: businessGoals
    });
  } catch (error) {
    console.error('Insights generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Smart Notifications
router.post('/notifications/smart-generate', async (req, res) => {
  try {
    const { userData, systemEvents, businessContext } = req.body;
    
    const notifications = await aiModuleService.generateSmartNotifications(
      userData,
      systemEvents,
      businessContext
    );
    
    res.json({
      success: true,
      smartNotifications: notifications,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Smart notifications error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Executive Summary Generation
router.get('/reports/executive-summary', async (req, res) => {
  try {
    const { timeframe = 'month', focusAreas } = req.query;
    
    // Get comprehensive module data
    const [salesData, procurementData, inventoryData, financeData, operationsData] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) as total_orders,
          SUM(total_amount) as revenue,
          COUNT(DISTINCT customer_id) as unique_customers,
          AVG(total_amount) as avg_order_value
        FROM sales_orders 
        WHERE status = 'COMPLETED' AND order_date >= CURRENT_DATE - INTERVAL '1 ${timeframe}'
      `),
      
      pool.query(`
        SELECT 
          COUNT(*) as total_pos,
          SUM(total_amount) as total_spend,
          COUNT(DISTINCT supplier_id) as unique_suppliers,
          AVG(total_amount) as avg_po_value
        FROM purchase_orders 
        WHERE status = 'COMPLETED' AND order_date >= CURRENT_DATE - INTERVAL '1 ${timeframe}'
      `),
      
      pool.query(`
        SELECT 
          COUNT(*) as total_items,
          SUM(current_stock_quantity) as total_stock,
          COUNT(CASE WHEN current_stock_quantity < minimum_stock_level THEN 1 END) as low_stock_alerts
        FROM inventory_items 
        WHERE status = 'APPROVED'
      `),
      
      pool.query(`
        SELECT 
          SUM(CASE WHEN account_type = 'ASSET' THEN current_balance ELSE 0 END) as assets,
          SUM(CASE WHEN account_type = 'LIABILITY' THEN current_balance ELSE 0 END) as liabilities,
          SUM(CASE WHEN account_type = 'REVENUE' THEN current_balance ELSE 0 END) as revenue,
          SUM(CASE WHEN account_type = 'EXPENSE' THEN ABS(current_balance) ELSE 0 END) as expenses
        FROM chart_of_accounts 
        WHERE status = 'ACTIVE'
      `),
      
      pool.query(`
        SELECT 
          COUNT(*) as total_transactions,
          COUNT(DISTINCT user_id) as active_users,
          COUNT(CASE WHEN transaction_type = 'ISSUE' THEN 1 END) as issues,
          COUNT(CASE WHEN transaction_type = 'RECEIPT' THEN 1 END) as receipts
        FROM warehouse_transactions 
        WHERE transaction_date >= CURRENT_DATE - INTERVAL '1 ${timeframe}'
      `)
    ]);
    
    const allModuleData = {
      sales: salesData.rows[0],
      procurement: procurementData.rows[0],
      inventory: inventoryData.rows[0],
      finance: financeData.rows[0],
      operations: operationsData.rows[0]
    };
    
    const executiveSummary = await aiModuleService.generateExecutiveSummary(
      allModuleData,
      timeframe,
      focusAreas ? focusAreas.split(',') : ['growth', 'efficiency', 'risk']
    );
    
    res.json({
      success: true,
      executiveSummary,
      moduleMetrics: allModuleData,
      reportPeriod: timeframe
    });
  } catch (error) {
    console.error('Executive summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;