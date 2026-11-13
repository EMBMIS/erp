const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');

/**
 * AI Analytics Endpoints
 * Provides aggregated business intelligence data for AI chat analysis
 * All endpoints are user-isolated and require authentication
 */

/**
 * GET /ai-analytics/overview?months=12
 *
 * Simeli's own module overview in one round trip: findings, agent runs,
 * escalations and knowledge, each counted from the table that holds it. Sits
 * here rather than in ai-modules.js because that router is not mounted.
 */
router.get('/overview', auth, async (req, res) => {
  try {
    const { getSimeliAnalytics } = require('../services/simeliAnalytics');
    const data = await getSimeliAnalytics(Number(req.query.months) || 12);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Simeli analytics error:', error);
    res.status(500).json({ success: false, error: 'Failed to load Simeli analytics' });
  }
});

/**
 * GET /ai-analytics/sales - Sales Performance Analytics
 */
router.get('/sales', auth, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const userId = req.user.id;
    
    // Get comprehensive sales analytics
    const salesAnalytics = await client.query(`
      SELECT 
        -- Basic counts and totals
        COUNT(*) as total_orders,
        SUM(CASE WHEN status != 'CANCELLED' THEN total_amount::numeric ELSE 0 END) as total_pipeline_value,
        AVG(CASE WHEN status != 'CANCELLED' THEN total_amount::numeric ELSE NULL END) as avg_deal_size,
        
        -- Status breakdown
        SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) as draft_orders,
        SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 ELSE 0 END) as pending_approval,
        SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved_orders,
        SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END) as confirmed_orders,
        SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered_orders,
        
        -- Time-based analysis (last 30 days vs previous 30)
        SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN total_amount::numeric ELSE 0 END) as last_30_days_value,
        SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '60 days' AND created_at < CURRENT_DATE - INTERVAL '30 days' THEN total_amount::numeric ELSE 0 END) as previous_30_days_value,
        
        -- Customer analysis
        COUNT(DISTINCT customer_id) as unique_customers,
        
        -- Priority breakdown  
        SUM(CASE WHEN priority = 'HIGH' THEN 1 ELSE 0 END) as high_priority_orders,
        SUM(CASE WHEN priority = 'NORMAL' THEN 1 ELSE 0 END) as normal_priority_orders,
        SUM(CASE WHEN priority = 'LOW' THEN 1 ELSE 0 END) as low_priority_orders
        
      FROM sales_orders 
      WHERE deleted_at IS NULL 
      AND created_by = $1
    `, [userId]);

    // Get top performing customers
    const topCustomers = await client.query(`
      SELECT 
        c.customer_name,
        c.customer_type,
        COUNT(so.id) as order_count,
        SUM(so.total_amount::numeric) as total_value,
        AVG(so.total_amount::numeric) as avg_order_value,
        MAX(so.created_at) as last_order_date
      FROM sales_orders so
      JOIN customers c ON so.customer_id = c.id
      WHERE so.deleted_at IS NULL 
      AND so.created_by = $1
      GROUP BY c.id, c.customer_name, c.customer_type
      ORDER BY total_value DESC
      LIMIT 5
    `, [userId]);

    // Get recent sales trend (last 12 months by month)
    const monthlyTrend = await client.query(`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) as order_count,
        SUM(total_amount::numeric) as total_value
      FROM sales_orders
      WHERE deleted_at IS NULL 
      AND created_at >= CURRENT_DATE - INTERVAL '12 months'
      AND created_by = $1
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
    `, [userId]);

    // Calculate derived metrics
    const analytics = salesAnalytics.rows[0];
    const growthRate = analytics.previous_30_days_value > 0 
      ? ((analytics.last_30_days_value - analytics.previous_30_days_value) / analytics.previous_30_days_value * 100)
      : null;

    const conversionRate = analytics.total_orders > 0
      ? (analytics.delivered_orders / analytics.total_orders * 100)
      : 0;

    res.json({
      success: true,
      data: {
        summary: {
          total_orders: parseInt(analytics.total_orders),
          total_pipeline_value: parseFloat(analytics.total_pipeline_value || 0),
          avg_deal_size: parseFloat(analytics.avg_deal_size || 0),
          unique_customers: parseInt(analytics.unique_customers),
          conversion_rate: parseFloat(conversionRate.toFixed(2)),
          growth_rate_30d: growthRate ? parseFloat(growthRate.toFixed(2)) : null
        },
        status_breakdown: {
          draft: parseInt(analytics.draft_orders),
          pending_approval: parseInt(analytics.pending_approval),
          approved: parseInt(analytics.approved_orders),
          confirmed: parseInt(analytics.confirmed_orders),
          delivered: parseInt(analytics.delivered_orders)
        },
        priority_breakdown: {
          high: parseInt(analytics.high_priority_orders),
          normal: parseInt(analytics.normal_priority_orders),
          low: parseInt(analytics.low_priority_orders)
        },
        top_customers: topCustomers.rows.map(customer => ({
          name: customer.customer_name,
          type: customer.customer_type,
          order_count: parseInt(customer.order_count),
          total_value: parseFloat(customer.total_value),
          avg_order_value: parseFloat(customer.avg_order_value),
          last_order_date: customer.last_order_date
        })),
        monthly_trend: monthlyTrend.rows.map(month => ({
          month: month.month,
          order_count: parseInt(month.order_count),
          total_value: parseFloat(month.total_value)
        }))
      }
    });

  } catch (error) {
    console.error('Sales analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate sales analytics'
    });
  } finally {
    client.release();
  }
});

/**
 * GET /ai-analytics/customers - Customer Portfolio Analytics
 */
router.get('/customers', auth, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const userId = req.user.id;
    
    // Get customer analytics
    const customerAnalytics = await client.query(`
      SELECT 
        COUNT(*) as total_customers,
        SUM(credit_limit::numeric) as total_credit_extended,
        AVG(credit_limit::numeric) as avg_credit_limit,
        SUM(current_balance::numeric) as total_outstanding,
        
        -- Customer types
        SUM(CASE WHEN customer_type = 'COMPANY' THEN 1 ELSE 0 END) as company_customers,
        SUM(CASE WHEN customer_type = 'INDIVIDUAL' THEN 1 ELSE 0 END) as individual_customers,
        
        -- Status breakdown
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_customers,
        SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END) as inactive_customers,
        
        -- Risk levels
        SUM(CASE WHEN credit_risk_level = 'HIGH' THEN 1 ELSE 0 END) as high_risk_customers,
        SUM(CASE WHEN credit_risk_level = 'MEDIUM' THEN 1 ELSE 0 END) as medium_risk_customers,
        SUM(CASE WHEN credit_risk_level = 'LOW' THEN 1 ELSE 0 END) as low_risk_customers,
        
        -- Recent additions
        SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 ELSE 0 END) as new_customers_30d
        
      FROM customers 
      WHERE deleted_at IS NULL 
      AND created_by = $1
    `, [userId]);

    // Get customer activity analysis
    const customerActivity = await client.query(`
      SELECT 
        c.customer_name,
        c.customer_type,
        c.credit_limit::numeric as credit_limit,
        c.current_balance::numeric as current_balance,
        COUNT(so.id) as order_count,
        SUM(so.total_amount::numeric) as lifetime_value,
        MAX(so.created_at) as last_order_date,
        MIN(so.created_at) as first_order_date
      FROM customers c
      LEFT JOIN sales_orders so ON c.id = so.customer_id AND so.deleted_at IS NULL
      WHERE c.deleted_at IS NULL 
      AND c.created_by = $1
      GROUP BY c.id, c.customer_name, c.customer_type, c.credit_limit, c.current_balance
      ORDER BY lifetime_value DESC NULLS LAST
      LIMIT 10
    `, [userId]);

    const analytics = customerAnalytics.rows[0];

    res.json({
      success: true,
      data: {
        summary: {
          total_customers: parseInt(analytics.total_customers),
          total_credit_extended: parseFloat(analytics.total_credit_extended || 0),
          avg_credit_limit: parseFloat(analytics.avg_credit_limit || 0),
          total_outstanding: parseFloat(analytics.total_outstanding || 0),
          new_customers_30d: parseInt(analytics.new_customers_30d)
        },
        segmentation: {
          by_type: {
            company: parseInt(analytics.company_customers),
            individual: parseInt(analytics.individual_customers)
          },
          by_status: {
            active: parseInt(analytics.active_customers),
            inactive: parseInt(analytics.inactive_customers)
          },
          by_risk: {
            high: parseInt(analytics.high_risk_customers),
            medium: parseInt(analytics.medium_risk_customers),
            low: parseInt(analytics.low_risk_customers)
          }
        },
        top_customers: customerActivity.rows.map(customer => ({
          name: customer.customer_name,
          type: customer.customer_type,
          credit_limit: parseFloat(customer.credit_limit || 0),
          current_balance: parseFloat(customer.current_balance || 0),
          order_count: parseInt(customer.order_count || 0),
          lifetime_value: parseFloat(customer.lifetime_value || 0),
          last_order_date: customer.last_order_date,
          first_order_date: customer.first_order_date
        }))
      }
    });

  } catch (error) {
    console.error('Customer analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate customer analytics'
    });
  } finally {
    client.release();
  }
});

/**
 * GET /ai-analytics/procurement - Procurement Analytics
 */
router.get('/procurement', auth, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const userId = req.user.id;
    
    // Get procurement analytics
    const procurementAnalytics = await client.query(`
      SELECT 
        COUNT(*) as total_purchase_orders,
        SUM(CASE WHEN status != 'CANCELLED' THEN total_amount::numeric ELSE 0 END) as total_spend,
        AVG(CASE WHEN status != 'CANCELLED' THEN total_amount::numeric ELSE NULL END) as avg_po_value,
        
        -- Status breakdown
        SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) as draft_pos,
        SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 ELSE 0 END) as pending_approval,
        SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved_pos,
        SUM(CASE WHEN status = 'SENT_TO_SUPPLIER' THEN 1 ELSE 0 END) as sent_to_supplier,
        SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END) as confirmed_pos,
        
        COUNT(DISTINCT supplier_id) as unique_suppliers,
        
        -- Recent activity
        SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN total_amount::numeric ELSE 0 END) as last_30_days_spend
        
      FROM purchase_orders
      WHERE created_by = $1
    `, [userId]);

    // Get top suppliers
    const topSuppliers = await client.query(`
      SELECT 
        s.legal_name as supplier_name,
        COUNT(po.id) as po_count,
        SUM(po.total_amount::numeric) as total_spend,
        AVG(po.total_amount::numeric) as avg_po_value,
        MAX(po.created_at) as last_po_date
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      WHERE po.created_by = $1
      GROUP BY s.id, s.legal_name
      ORDER BY total_spend DESC
      LIMIT 5
    `, [userId]);

    const analytics = procurementAnalytics.rows[0];

    res.json({
      success: true,
      data: {
        summary: {
          total_purchase_orders: parseInt(analytics.total_purchase_orders),
          total_spend: parseFloat(analytics.total_spend || 0),
          avg_po_value: parseFloat(analytics.avg_po_value || 0),
          unique_suppliers: parseInt(analytics.unique_suppliers),
          last_30_days_spend: parseFloat(analytics.last_30_days_spend || 0)
        },
        status_breakdown: {
          draft: parseInt(analytics.draft_pos),
          pending_approval: parseInt(analytics.pending_approval),
          approved: parseInt(analytics.approved_pos),
          sent_to_supplier: parseInt(analytics.sent_to_supplier),
          confirmed: parseInt(analytics.confirmed_pos)
        },
        top_suppliers: topSuppliers.rows.map(supplier => ({
          name: supplier.supplier_name,
          po_count: parseInt(supplier.po_count),
          total_spend: parseFloat(supplier.total_spend),
          avg_po_value: parseFloat(supplier.avg_po_value),
          last_po_date: supplier.last_po_date
        }))
      }
    });

  } catch (error) {
    console.error('Procurement analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate procurement analytics'
    });
  } finally {
    client.release();
  }
});

module.exports = router;