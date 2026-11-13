const express = require('express');
const router = express.Router();
// Require authentication for every route in this file (audit B15).
const { auth } = require('../middleware/auth');
router.use(auth);
const aiEnhancementService = require('../services/aiEnhancementService');
const { pool } = require('../config/database');
const { isAIEnabled } = require('../config/aiConfig');

// 🔮 Demand Forecasting Endpoint
router.post('/demand-forecast/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    
    // Get historical data for the item
    const historicalData = await pool.query(`
      SELECT 
        ii.item_name,
        COUNT(soi.id) as total_orders,
        SUM(soi.quantity) as total_quantity,
        AVG(soi.quantity) as avg_order_quantity,
        MIN(so.order_date) as first_order,
        MAX(so.order_date) as last_order,
        EXTRACT(EPOCH FROM (MAX(so.order_date) - MIN(so.order_date))) / (24*60*60*30) as months_active
      FROM inventory_items ii
      LEFT JOIN sales_order_items soi ON ii.id = soi.inventory_item_id  
      LEFT JOIN sales_orders so ON soi.sales_order_id = so.id
      WHERE ii.id = $1 AND so.status = 'COMPLETED'
      GROUP BY ii.id, ii.item_name
    `, [itemId]);
    
    const prediction = await aiEnhancementService.predictDemand(itemId, historicalData.rows[0]);
    
    res.json({
      success: true,
      itemId,
      prediction,
      historicalData: historicalData.rows[0]
    });
  } catch (error) {
    console.error('Demand forecast error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🎯 Supplier Performance Analysis
router.post('/supplier-analysis/:supplierId', async (req, res) => {
  try {
    const { supplierId } = req.params;
    
    // Get comprehensive supplier data
    const supplierData = await pool.query(`
      SELECT 
        s.legal_name,
        COUNT(po.id) as total_pos,
        AVG(EXTRACT(EPOCH FROM (po.delivered_date - po.order_date)) / (24*60*60)) as avg_delivery_days,
        COUNT(CASE WHEN po.status = 'COMPLETED' THEN 1 END)::float / COUNT(po.id) as completion_rate,
        AVG(po.total_amount) as avg_order_value,
        SUM(po.total_amount) as total_spent,
        COUNT(CASE WHEN po.delivered_date > po.expected_delivery_date THEN 1 END) as late_deliveries,
        s.created_at as partnership_start
      FROM suppliers s
      LEFT JOIN purchase_orders po ON s.id = po.supplier_id
      WHERE s.id = $1
      GROUP BY s.id, s.legal_name, s.created_at
    `, [supplierId]);
    
    const analysis = await aiEnhancementService.analyzeSupplierPerformance(supplierData.rows[0]);
    
    res.json({
      success: true,
      supplierId,
      analysis,
      rawData: supplierData.rows[0]
    });
  } catch (error) {
    console.error('Supplier analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 📊 Financial Health Analysis
router.get('/financial-health', async (req, res) => {
  try {
    // Get comprehensive financial data
    const [balanceSheet, incomeStatement, cashFlow, trends] = await Promise.all([
      pool.query(`
        SELECT account_type, SUM(current_balance) as total
        FROM chart_of_accounts 
        WHERE status = 'ACTIVE' AND is_header = false
        GROUP BY account_type
      `),
      pool.query(`
        SELECT 
          SUM(CASE WHEN account_type = 'REVENUE' THEN current_balance ELSE 0 END) as revenue,
          SUM(CASE WHEN account_type = 'EXPENSE' THEN ABS(current_balance) ELSE 0 END) as expenses
        FROM chart_of_accounts 
        WHERE account_type IN ('REVENUE', 'EXPENSE') AND status = 'ACTIVE'
      `),
      pool.query(`
        SELECT 
          COUNT(*) as total_transactions,
          SUM(total_amount) as transaction_volume
        FROM (
          SELECT total_amount FROM sales_orders WHERE status = 'COMPLETED'
          UNION ALL
          SELECT total_amount FROM purchase_orders WHERE status = 'COMPLETED'
        ) t
      `),
      pool.query(`
        SELECT 
          DATE_TRUNC('month', created_at) as month,
          COUNT(*) as transactions,
          AVG(total_amount) as avg_amount
        FROM sales_orders 
        WHERE status = 'COMPLETED' AND created_at >= CURRENT_DATE - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month
      `)
    ]);
    
    const financialData = {
      balanceSheet: balanceSheet.rows,
      performance: incomeStatement.rows[0],
      cashFlow: cashFlow.rows[0],
      trends: trends.rows
    };
    
    const analysis = await aiEnhancementService.analyzeFinancialHealth(financialData);
    
    res.json({
      success: true,
      analysis,
      rawData: financialData
    });
  } catch (error) {
    console.error('Financial health error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🚨 Anomaly Detection
router.post('/detect-anomalies', async (req, res) => {
  try {
    const { entityType, timeframe = '30days' } = req.body;
    
    let transactionData = [];
    
    switch (entityType) {
      case 'purchase_orders':
        transactionData = await pool.query(`
          SELECT id, po_number, total_amount, order_date, supplier_id, status
          FROM purchase_orders 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${timeframe}'
          ORDER BY created_at DESC
        `);
        break;
        
      case 'sales_orders':
        transactionData = await pool.query(`
          SELECT id, so_number, total_amount, order_date, customer_id, status
          FROM sales_orders 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${timeframe}'
          ORDER BY created_at DESC
        `);
        break;
        
      case 'journal_entries':
        transactionData = await pool.query(`
          SELECT id, journal_number, total_debit, entry_date, source_type, status
          FROM journal_entries 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${timeframe}'
          ORDER BY created_at DESC
        `);
        break;
    }
    
    const anomalies = await aiEnhancementService.detectAnomalies(transactionData.rows, entityType);
    
    res.json({
      success: true,
      entityType,
      timeframe,
      anomalies,
      totalRecords: transactionData.rows.length
    });
  } catch (error) {
    console.error('Anomaly detection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 📝 Contract Risk Analysis
router.post('/analyze-contract/:contractId', async (req, res) => {
  try {
    const { contractId } = req.params;
    
    // Get contract data
    const contractData = await pool.query(`
      SELECT 
        sc.contract_number,
        sc.contract_type,
        sc.total_amount,
        sc.terms_and_conditions,
        sc.status,
        c.customer_name,
        sc.start_date,
        sc.end_date
      FROM sales_contracts sc
      LEFT JOIN customers c ON sc.customer_id = c.id
      WHERE sc.id = $1
    `, [contractId]);
    
    if (contractData.rows.length === 0) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    
    const contract = contractData.rows[0];
    const analysis = await aiEnhancementService.analyzeContractRisks(
      contract.terms_and_conditions || 'Standard terms apply',
      contract.contract_type
    );
    
    res.json({
      success: true,
      contractId,
      contractInfo: contract,
      riskAnalysis: analysis
    });
  } catch (error) {
    console.error('Contract analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 💰 Pricing Optimization
router.post('/optimize-pricing/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    
    // Get product and market data
    const [productData, marketData] = await Promise.all([
      pool.query(`
        SELECT 
          ii.item_name,
          ii.current_stock_quantity,
          AVG(soi.unit_price) as current_avg_price,
          COUNT(soi.id) as sales_frequency,
          SUM(soi.quantity) as total_sold
        FROM inventory_items ii
        LEFT JOIN sales_order_items soi ON ii.id = soi.inventory_item_id
        LEFT JOIN sales_orders so ON soi.sales_order_id = so.id
        WHERE ii.id = $1 AND so.status = 'COMPLETED'
        GROUP BY ii.id, ii.item_name, ii.current_stock_quantity
      `, [itemId]),
      
      pool.query(`
        SELECT 
          AVG(soi.unit_price) as market_avg_price,
          MIN(soi.unit_price) as market_min_price,
          MAX(soi.unit_price) as market_max_price,
          COUNT(DISTINCT so.customer_id) as customer_diversity
        FROM sales_order_items soi
        JOIN sales_orders so ON soi.sales_order_id = so.id
        WHERE soi.inventory_item_id = $1 AND so.status = 'COMPLETED'
      `, [itemId])
    ]);
    
    const optimization = await aiEnhancementService.optimizePricing(
      productData.rows[0],
      marketData.rows[0]
    );
    
    res.json({
      success: true,
      itemId,
      pricingOptimization: optimization,
      currentData: {
        product: productData.rows[0],
        market: marketData.rows[0]
      }
    });
  } catch (error) {
    console.error('Pricing optimization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🎭 Customer Intelligence
router.post('/customer-insights/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Get customer and order history
    const [customerData, orderHistory] = await Promise.all([
      pool.query(`
        SELECT 
          customer_name,
          email,
          created_at,
          billing_city,
          billing_country,
          customer_type
        FROM customers 
        WHERE id = $1
      `, [customerId]),
      
      pool.query(`
        SELECT 
          so_number,
          total_amount,
          order_date,
          status,
          payment_terms,
          delivery_date
        FROM sales_orders 
        WHERE customer_id = $1 
        ORDER BY order_date DESC
        LIMIT 20
      `, [customerId])
    ]);
    
    const insights = await aiEnhancementService.analyzeCustomerBehavior(
      customerData.rows[0],
      orderHistory.rows
    );
    
    res.json({
      success: true,
      customerId,
      customerInsights: insights,
      customerProfile: customerData.rows[0],
      recentOrders: orderHistory.rows
    });
  } catch (error) {
    console.error('Customer insights error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔄 Process Automation Suggestions
router.get('/automation-suggestions', async (req, res) => {
  try {
    // Analyze current processes and workflows
    const processData = await pool.query(`
      SELECT 
        'purchase_orders' as process_name,
        COUNT(*) as volume,
        AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600) as avg_processing_hours,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approvals
      FROM purchase_orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      
      UNION ALL
      
      SELECT 
        'sales_orders' as process_name,
        COUNT(*) as volume,
        AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600) as avg_processing_hours,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_approvals
      FROM sales_orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    `);
    
    const userWorkflows = await pool.query(`
      SELECT 
        action_type,
        COUNT(*) as frequency,
        AVG(EXTRACT(EPOCH FROM (created_at - created_at)) / 60) as avg_time_minutes
      FROM notifications
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY action_type
      ORDER BY frequency DESC
    `);
    
    const suggestions = await aiEnhancementService.suggestAutomations(
      processData.rows,
      userWorkflows.rows
    );
    
    res.json({
      success: true,
      automationSuggestions: suggestions,
      currentProcesses: processData.rows,
      userActivity: userWorkflows.rows
    });
  } catch (error) {
    console.error('Automation suggestions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🌍 Sustainability Analysis
router.get('/sustainability-report', async (req, res) => {
  try {
    // Get purchase and supplier sustainability data
    const [purchaseData, supplierData] = await Promise.all([
      pool.query(`
        SELECT 
          po.total_amount,
          po.order_date,
          s.legal_name,
          s.address_country,
          s.address_city,
          po.delivery_method,
          SUM(po.total_amount) OVER() as total_spend
        FROM purchase_orders po
        JOIN suppliers s ON po.supplier_id = s.id
        WHERE po.status = 'COMPLETED' 
          AND po.order_date >= CURRENT_DATE - INTERVAL '90 days'
      `),
      
      pool.query(`
        SELECT 
          legal_name,
          address_country,
          address_city,
          COUNT(po.id) as order_frequency,
          AVG(po.total_amount) as avg_order_value
        FROM suppliers s
        LEFT JOIN purchase_orders po ON s.id = po.supplier_id
        WHERE po.status = 'COMPLETED'
        GROUP BY s.id, s.legal_name, s.address_country, s.address_city
        ORDER BY order_frequency DESC
      `)
    ]);
    
    const analysis = await aiEnhancementService.analyzeSustainability(
      purchaseData.rows,
      supplierData.rows
    );
    
    res.json({
      success: true,
      sustainabilityAnalysis: analysis,
      purchasePattern: purchaseData.rows,
      supplierProfile: supplierData.rows
    });
  } catch (error) {
    console.error('Sustainability analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 💡 Business Intelligence Dashboard
router.get('/business-insights', async (req, res) => {
  try {
    // Collect comprehensive ERP data
    const [
      salesMetrics,
      procurementMetrics, 
      inventoryMetrics,
      financialMetrics,
      supplierMetrics
    ] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) as total_orders,
          SUM(total_amount) as revenue,
          AVG(total_amount) as avg_order_value,
          COUNT(DISTINCT customer_id) as unique_customers
        FROM sales_orders 
        WHERE status = 'COMPLETED' AND order_date >= CURRENT_DATE - INTERVAL '90 days'
      `),
      
      pool.query(`
        SELECT 
          COUNT(*) as total_pos,
          SUM(total_amount) as total_spend,
          AVG(total_amount) as avg_po_value,
          COUNT(DISTINCT supplier_id) as unique_suppliers
        FROM purchase_orders
        WHERE status = 'COMPLETED' AND po_date >= CURRENT_DATE - INTERVAL '90 days'
      `),
      
      pool.query(`
        SELECT 
          COUNT(*) as total_items,
          SUM(current_stock_quantity) as total_stock_units,
          COUNT(CASE WHEN current_stock_quantity < minimum_stock_level THEN 1 END) as low_stock_items,
          AVG(current_stock_quantity) as avg_stock_level
        FROM inventory_items 
        WHERE status = 'APPROVED'
      `),
      
      pool.query(`
        SELECT 
          SUM(CASE WHEN account_type = 'ASSET' THEN current_balance ELSE 0 END) as total_assets,
          SUM(CASE WHEN account_type = 'LIABILITY' THEN current_balance ELSE 0 END) as total_liabilities,
          SUM(CASE WHEN account_type = 'REVENUE' THEN current_balance ELSE 0 END) as total_revenue,
          SUM(CASE WHEN account_type = 'EXPENSE' THEN ABS(current_balance) ELSE 0 END) as total_expenses
        FROM chart_of_accounts 
        WHERE status = 'ACTIVE' AND is_header = false
      `),
      
      // No supplier rating is captured anywhere in the schema, so there is no
      // average to report. It was selected here as AVG(rating) against a column
      // that has never existed, which failed the whole Promise.all and left the
      // page showing only the Postgres error.
      //
      // suppliers.status only allows DRAFT/PENDING_APPROVAL/ACTIVE/SUSPENDED/
      // INACTIVE (migration 018) — the old 'APPROVED' filter matched zero rows,
      // so the dashboard always showed "0 Active Suppliers". 'ACTIVE' is the
      // live, populated state.
      pool.query(`
        SELECT
          COUNT(*) as total_suppliers,
          COUNT(CASE WHEN certification_status = 'CERTIFIED' THEN 1 END) as certified_suppliers
        FROM suppliers
        WHERE status = 'ACTIVE'
      `)
    ]);
    
    const comprehensiveData = {
      sales: salesMetrics.rows[0],
      procurement: procurementMetrics.rows[0],
      inventory: inventoryMetrics.rows[0],
      finance: financialMetrics.rows[0],
      suppliers: supplierMetrics.rows[0]
    };

    // AI insights depend on an external provider (config/aiConfig). When no key
    // is configured, don't fabricate insights — say so explicitly and return the
    // metrics, mirroring the graceful "not configured" convention used by
    // ai-chat.js and ai-agent.js. Without this guard the OpenAI client would
    // throw on a missing key and every dashboard load would fail entirely.
    if (!isAIEnabled()) {
      return res.json({
        success: true,
        businessInsights: null,
        enterpriseMetrics: comprehensiveData,
        generatedAt: new Date().toISOString(),
        note: 'AI insights are not configured on this server (no API key set). Business metrics are shown without AI-generated insights.'
      });
    }

    // Bound the AI call. A slow upstream used to pin the request for the full
    // provider timeout (60s default, AI_TIMEOUT_MS) times SDK retries — up to
    // ~3 minutes — while the frontend aborts at its 30s axios timeout, retries,
    // and eventually the request queue fills and answers 503 "Server busy".
    // Fail fast with a graceful degraded response instead: the metrics still
    // render, the note tells the user the AI part was skipped, and the request
    // always completes well inside the frontend's timeout.
    const AI_INSIGHTS_TIMEOUT_MS = 25000;
    let insights = null;
    let aiNote = null;
    try {
      insights = await Promise.race([
        aiEnhancementService.generateBusinessInsights(comprehensiveData),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('AI insights generation timed out after ' + (AI_INSIGHTS_TIMEOUT_MS / 1000) + 's')),
          AI_INSIGHTS_TIMEOUT_MS
        ))
      ]);
      // The service falls back to plausible-looking static values tagged
      // ai_unavailable on any provider error; never present those as real AI.
      if (insights && insights.ai_unavailable) {
        aiNote = 'AI insights are currently unavailable (provider error). Business metrics are shown without AI-generated insights.';
        insights = null;
      }
    } catch (aiError) {
      console.error('Business insights AI error:', aiError.message);
      aiNote = 'AI insights are currently unavailable (' + aiError.message + '). Business metrics are shown without AI-generated insights.';
    }

    res.json({
      success: true,
      businessInsights: insights,
      enterpriseMetrics: comprehensiveData,
      generatedAt: new Date().toISOString(),
      ...(aiNote ? { note: aiNote } : {})
    });
  } catch (error) {
    console.error('Business insights error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🎯 Lead Scoring (for potential customers)
router.post('/score-lead', async (req, res) => {
  try {
    const { leadData } = req.body;
    
    // Get conversion history for similar leads
    const conversionHistory = await pool.query(`
      SELECT 
        customer_type,
        billing_country,
        COUNT(*) as total_customers,
        AVG(
          (SELECT SUM(total_amount) 
           FROM sales_orders so 
           WHERE so.customer_id = c.id AND so.status = 'COMPLETED')
        ) as avg_lifetime_value
      FROM customers c
      GROUP BY customer_type, billing_country
      ORDER BY avg_lifetime_value DESC
    `);
    
    const leadScore = await aiEnhancementService.scoreLeads(leadData, conversionHistory.rows);
    
    res.json({
      success: true,
      leadScore,
      benchmarkData: conversionHistory.rows
    });
  } catch (error) {
    console.error('Lead scoring error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔍 Quality Prediction
router.post('/predict-quality/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    
    // Get item and supplier quality data
    const [itemData, supplierHistory, productionData] = await Promise.all([
      pool.query(`
        SELECT ii.*, i.name, i.specifications
        FROM inventory_items ii
        LEFT JOIN items i ON ii.item_master_id = i.id
        WHERE ii.id = $1
      `, [itemId]),
      
      pool.query(`
        SELECT 
          s.legal_name,
          AVG(po.quality_rating) as avg_quality,
          COUNT(po.id) as total_orders,
          COUNT(CASE WHEN po.quality_rating < 3 THEN 1 END) as poor_quality_orders
        FROM inventory_items ii
        JOIN purchase_orders po ON ii.id = ANY(string_to_array(po.item_ids, ',')::uuid[])
        JOIN suppliers s ON po.supplier_id = s.id
        WHERE ii.id = $1
        GROUP BY s.id, s.legal_name
      `, [itemId]),
      
      pool.query(`
        SELECT 
          COUNT(*) as total_receipts,
          AVG(quantity_received) as avg_quantity,
          COUNT(CASE WHEN status = 'QUALITY_ISSUE' THEN 1 END) as quality_issues
        FROM warehouse_transactions
        WHERE inventory_item_id = $1 AND transaction_type = 'RECEIPT'
      `, [itemId])
    ]);
    
    const qualityPrediction = await aiEnhancementService.predictQualityIssues(
      itemData.rows[0],
      supplierHistory.rows,
      productionData.rows[0]
    );
    
    res.json({
      success: true,
      itemId,
      qualityPrediction,
      historicalData: {
        item: itemData.rows[0],
        suppliers: supplierHistory.rows,
        production: productionData.rows[0]
      }
    });
  } catch (error) {
    console.error('Quality prediction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🚚 Logistics Optimization
router.post('/optimize-logistics', async (req, res) => {
  try {
    const { deliveryIds } = req.body;
    
    // Get delivery data
    const deliveryData = await pool.query(`
      SELECT 
        ds.id,
        ds.delivery_date,
        ds.delivery_address,
        ds.estimated_delivery_cost,
        so.customer_id,
        c.shipping_city,
        c.shipping_country
      FROM delivery_schedules ds
      JOIN sales_orders so ON ds.sales_order_id = so.id
      JOIN customers c ON so.customer_id = c.id
      WHERE ds.id = ANY($1::uuid[])
        AND ds.status IN ('PENDING', 'SCHEDULED')
    `, [deliveryIds]);
    
    const constraints = {
      max_delivery_time: 48,
      max_daily_capacity: 10,
      available_vehicles: 3
    };
    
    const optimization = await aiEnhancementService.optimizeDelivery(
      deliveryData.rows,
      constraints
    );
    
    res.json({
      success: true,
      logisticsOptimization: optimization,
      deliverySchedules: deliveryData.rows
    });
  } catch (error) {
    console.error('Logistics optimization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 📈 Business Intelligence charts — pre-computed series for the BI dashboard
router.get('/charts', async (req, res) => {
  try {
    const [revenueTrend, topCategories, arAging] = await Promise.all([
      pool.query(`
        SELECT
          TO_CHAR(date_trunc('month', je.entry_date), 'Mon YYYY') AS month,
          date_trunc('month', je.entry_date) AS month_start,
          COALESCE(SUM(CASE WHEN coa.account_type = 'REVENUE' THEN jel.credit_amount - jel.debit_amount ELSE 0 END), 0)::numeric AS revenue,
          COALESCE(SUM(CASE WHEN coa.account_type = 'EXPENSE' THEN jel.debit_amount - jel.credit_amount ELSE 0 END), 0)::numeric AS expenses
        FROM journal_entries je
        JOIN journal_entry_items jel ON jel.journal_entry_id = je.id
        JOIN chart_of_accounts coa ON jel.account_id = coa.id
        WHERE je.status = 'POSTED' AND je.deleted_at IS NULL
          AND je.entry_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
        GROUP BY month_start, month
        ORDER BY month_start
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT coa.account_name AS category, COALESCE(SUM(jel.credit_amount - jel.debit_amount), 0)::numeric AS value
        FROM journal_entry_items jel
        JOIN journal_entries je ON jel.journal_entry_id = je.id
        JOIN chart_of_accounts coa ON jel.account_id = coa.id
        WHERE coa.account_type = 'REVENUE' AND je.status = 'POSTED' AND je.deleted_at IS NULL
        GROUP BY coa.account_name
        HAVING COALESCE(SUM(jel.credit_amount - jel.debit_amount), 0) > 0
        ORDER BY value DESC
        LIMIT 5
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT
          CASE
            WHEN days_overdue <= 0 THEN 'Current'
            WHEN days_overdue BETWEEN 1 AND 30 THEN '1-30'
            WHEN days_overdue BETWEEN 31 AND 60 THEN '31-60'
            WHEN days_overdue BETWEEN 61 AND 90 THEN '61-90'
            ELSE '90+'
          END AS bucket,
          COALESCE(SUM(outstanding_amount), 0)::numeric AS amount
        FROM (
          SELECT outstanding_amount, GREATEST(0, (CURRENT_DATE - due_date))::int AS days_overdue
          FROM customer_invoices
          WHERE deleted_at IS NULL AND status IN ('APPROVED','SENT','PARTIALLY_PAID','OVERDUE') AND outstanding_amount > 0
        ) t
        GROUP BY bucket
      `).catch(() => ({ rows: [] })),
    ]);

    const bucketOrder = ['Current', '1-30', '31-60', '61-90', '90+'];
    const agingByBucket = new Map(arAging.rows.map((r) => [r.bucket, Number(r.amount)]));

    res.json({
      success: true,
      revenue_trend: revenueTrend.rows.map((r) => ({
        month: r.month,
        revenue: Number(r.revenue),
        expenses: Number(r.expenses),
      })),
      top_revenue_categories: topCategories.rows.map((r) => ({
        category: r.category,
        value: Number(r.value),
      })),
      ar_aging: bucketOrder.map((bucket) => ({ bucket, amount: agingByBucket.get(bucket) || 0 })),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('BI charts error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Dynamic NL → Chart generation
// POST /api/ai-insights/query-chart
// Takes a natural-language question, generates/executes safe SQL, produces a
// structured chart specification the frontend renders with Recharts.
// ---------------------------------------------------------------------------
router.post('/query-chart', auth, async (req, res) => {
  try {
    const { question, chart_type } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ success: false, error: 'A question is required.' });
    }
    const chartGenerator = require('../services/ai/chartGenerator');
    const result = await chartGenerator.ask(question.trim(), { chart_type });
    if (result.error) {
      return res.status(422).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result.chart_spec });
  } catch (error) {
    console.error('query-chart error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;