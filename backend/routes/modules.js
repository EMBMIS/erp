const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const schemaExtractor = require('../services/schemaExtractor');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');

// Every route in this file requires authentication. Schema introspection
// and sample data are privileged operations — they expose table structure
// and live row data that an unauthenticated caller must never see.
router.use(auth);

/**
 * ERP Modules Discovery API
 * Provides information about all available modules, their objects, and schemas
 */

/**
 * GET / — list all known ERP modules with record counts.
 * Authenticated only; no record-level data exposed.
 */
router.get('/', async (req, res) => {
  try {
    const modules = [
      { name: 'Items', key: 'items', description: 'Item master data management', api_endpoint: '/api/items', table: 'items', category: 'Inventory', icon: 'Package', features: ['Create items', 'Manage specifications', 'Track lifecycle', 'Approval workflow'] },
      { name: 'Inventory Items', key: 'inventory-items', description: 'Stock and inventory management', api_endpoint: '/api/inventory-items', table: 'inventory_items', category: 'Inventory', icon: 'Archive', features: ['Track stock levels', 'Location management', 'Stock adjustments', 'Reorder points'] },
      { name: 'Storage Locations', key: 'storage-locations', description: 'Warehouse storage location management', api_endpoint: '/api/storage-locations', table: 'storage_locations', category: 'Warehouse', icon: 'MapPin', features: ['Location hierarchy', 'Capacity management', 'Zone assignment'] },
      { name: 'Bins', key: 'bins', description: 'Storage bin and rack management', api_endpoint: '/api/bins', table: 'bins', category: 'Warehouse', icon: 'Grid3x3', features: ['Bin locations', 'Capacity tracking', 'Assignment rules'] },
      { name: 'Suppliers', key: 'suppliers', description: 'Supplier and vendor management', api_endpoint: '/api/suppliers', table: 'suppliers', category: 'Procurement', icon: 'Building2', features: ['Supplier profiles', 'Certifications', 'Performance tracking', 'Contracts'] },
      { name: 'Customers', key: 'customers', description: 'Customer relationship management', api_endpoint: '/api/customers', table: 'customers', category: 'Sales', icon: 'Users', features: ['Customer profiles', 'Contact management', 'Credit limits', 'History tracking'] },
      { name: 'Purchase Orders', key: 'purchase-orders', description: 'Purchase order management', api_endpoint: '/api/purchase-orders', table: 'purchase_orders', category: 'Procurement', icon: 'ShoppingCart', features: ['PO creation', 'Approval workflow', 'Delivery tracking', 'Invoice matching'] },
      { name: 'Sales Orders', key: 'sales-orders', description: 'Sales order processing', api_endpoint: '/api/sales-orders', table: 'sales_orders', category: 'Sales', icon: 'TrendingUp', features: ['Order creation', 'Pricing', 'Delivery scheduling', 'Invoicing'] },
      { name: 'Purchase Requisitions', key: 'purchase-requisitions', description: 'Internal purchase request management', api_endpoint: '/api/purchase-requisitions', table: 'purchase_requisitions', category: 'Procurement', icon: 'FileText', features: ['Request creation', 'Approval routing', 'Budget control', 'PO conversion'] },
      { name: 'Sales Quotations', key: 'sales-quotations', description: 'Sales quotation and proposal management', api_endpoint: '/api/sales-quotations', table: 'sales_quotations', category: 'Sales', icon: 'FileCheck', features: ['Quote creation', 'Pricing rules', 'Validity tracking', 'Order conversion'] },
      { name: 'Contracts', key: 'contracts', description: 'Contract lifecycle management', api_endpoint: '/api/contracts', table: 'contracts', category: 'Procurement', icon: 'FileSignature', features: ['Contract creation', 'Terms management', 'Renewal tracking', 'Compliance'] },
      { name: 'Sales Contracts', key: 'sales-contracts', description: 'Sales contract management', api_endpoint: '/api/sales-contracts', table: 'sales_contracts', category: 'Sales', icon: 'Handshake', features: ['Contract creation', 'Revenue recognition', 'Milestone tracking'] },
      { name: 'RFQs', key: 'request-for-quotations', description: 'Request for quotation management', api_endpoint: '/api/request-for-quotations', table: 'request_for_quotations', category: 'Procurement', icon: 'MessageSquare', features: ['RFQ creation', 'Supplier responses', 'Comparison analysis', 'PO conversion'] },
      { name: 'Sales RFQs', key: 'sales-rfqs', description: 'Sales request for quotation responses', api_endpoint: '/api/sales-rfqs', table: 'sales_rfqs', category: 'Sales', icon: 'MessageCircle', features: ['RFQ responses', 'Competitive analysis', 'Proposal generation'] },
      { name: 'Warehouse Transactions', key: 'warehouse-transactions', description: 'Warehouse movement and transaction tracking', api_endpoint: '/api/warehouse/transactions', table: 'warehouse_transactions', category: 'Warehouse', icon: 'ArrowRightLeft', features: ['Stock movements', 'Receipts', 'Issues', 'Transfers', 'Adjustments'] },
      { name: 'Delivery Schedules', key: 'delivery-schedules', description: 'Delivery planning and scheduling', api_endpoint: '/api/delivery-schedules', table: 'delivery_schedules', category: 'Logistics', icon: 'Truck', features: ['Schedule planning', 'Route optimization', 'Tracking', 'Customer notifications'] },
      { name: 'Chart of Accounts', key: 'chart-of-accounts', description: 'Financial account structure', api_endpoint: '/api/chart-of-accounts', table: 'chart_of_accounts', category: 'Finance', icon: 'Calculator', features: ['Account hierarchy', 'Balance tracking', 'Financial reporting'] },
      { name: 'Journal Entries', key: 'journal-entries', description: 'Financial transaction recording', api_endpoint: '/api/journal-entries', table: 'journal_entries', category: 'Finance', icon: 'BookOpen', features: ['Transaction recording', 'Double-entry bookkeeping', 'Audit trail'] },
      { name: 'Notifications', key: 'notifications', description: 'System notification management', api_endpoint: '/api/notifications', table: 'notifications', category: 'System', icon: 'Bell', features: ['Alert system', 'User notifications', 'Workflow alerts', 'Escalations'] },
    ];

    const modulesWithStats = await Promise.all(
      modules.map(async (mod) => {
        try {
          const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${mod.table}`);
          return { ...mod, record_count: parseInt(countResult.rows[0].count) };
        } catch (_) {
          return { ...mod, record_count: 0 };
        }
      })
    );

    const modulesByCategory = modulesWithStats.reduce((acc, m) => {
      if (!acc[m.category]) acc[m.category] = [];
      acc[m.category].push(m);
      return acc;
    }, {});

    res.json({
      success: true,
      total_modules: modules.length,
      modules: modulesWithStats,
      modules_by_category: modulesByCategory,
      categories: Object.keys(modulesByCategory),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error getting modules:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve modules', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /database/schema — complete database schema (manager/admin only)
// MUST come before /:moduleKey/schema or Express sees "database" as :moduleKey.
// ---------------------------------------------------------------------------
router.get('/database/schema', requireManagerOrAdmin, async (req, res) => {
  try {
    // Live schema only — the legacy complete-database-schema.json snapshot was
    // deleted; a stale file would only drift from the real database anyway.
    const completeSchema = await schemaExtractor.extractCompleteSchema();

    const simplifiedSchema = {};
    for (const [tableName, tableData] of Object.entries(completeSchema.tables || {})) {
      simplifiedSchema[tableName] = {
        columns: (tableData.columns || []).map((col) => ({
          name: col.name,
          type: col.type,
          required: col.required || col.nullable === false,
          primary_key: col.name === 'id',
          foreign_key: col.name.endsWith('_id') && col.name !== 'id',
          max_length: col.max_length,
        })),
        relationships: tableData.relationships || [],
        description: tableData.description || `${tableName} table`,
        record_count: 0,
      };
    }

    res.json({
      success: true,
      database_name: completeSchema.database_name || 'ERP Database',
      total_tables: Object.keys(simplifiedSchema).length,
      tables: simplifiedSchema,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error getting database schema:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve database schema', message: error.message });
  }
});

const MODULE_TABLE_MAP = {
  'items': 'items',
  'inventory-items': 'inventory_items',
  'storage-locations': 'storage_locations',
  'bins': 'bins',
  'suppliers': 'suppliers',
  'customers': 'customers',
  'purchase-orders': 'purchase_orders',
  'sales-orders': 'sales_orders',
  'purchase-requisitions': 'purchase_requisitions',
  'sales-quotations': 'sales_quotations',
  'contracts': 'contracts',
  'sales-contracts': 'sales_contracts',
  'request-for-quotations': 'request_for_quotations',
  'sales-rfqs': 'sales_rfqs',
  'warehouse-transactions': 'warehouse_transactions',
  'delivery-schedules': 'delivery_schedules',
  'chart-of-accounts': 'chart_of_accounts',
  'journal-entries': 'journal_entries',
  'notifications': 'notifications',
};

// ---------------------------------------------------------------------------
// GET /:moduleKey/schema — schema for a specific table (manager/admin only)
// ---------------------------------------------------------------------------
router.get('/:moduleKey/schema', requireManagerOrAdmin, async (req, res) => {
  try {
    const { moduleKey } = req.params;
    const tableName = MODULE_TABLE_MAP[moduleKey];
    if (!tableName) {
      return res.status(404).json({ success: false, error: 'Module not found', available_modules: Object.keys(MODULE_TABLE_MAP) });
    }

    const completeSchema = await schemaExtractor.extractCompleteSchema();

    const tableSchema = completeSchema.tables?.[tableName];
    if (!tableSchema) return res.status(404).json({ success: false, error: 'Table schema not found', table: tableName });

    res.json({
      success: true,
      schema: {
        module_key: moduleKey,
        table_name: tableName,
        ...tableSchema,
        field_summary: {
          total_fields: tableSchema.columns?.length || 0,
          required_fields: tableSchema.columns?.filter((c) => c.required).length || 0,
          optional_fields: tableSchema.columns?.filter((c) => !c.required).length || 0,
        },
        api_endpoints: {
          list: `/api/${moduleKey.replace('_', '-')}`,
          read: `/api/${moduleKey.replace('_', '-')}/:id`,
        },
      },
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error getting module schema:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve module schema', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /:moduleKey/sample — sample rows from a table (manager/admin only)
// Limit clamped to 100 to prevent abuse.
// ---------------------------------------------------------------------------
router.get('/:moduleKey/sample', requireManagerOrAdmin, async (req, res) => {
  try {
    const { moduleKey } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 5, 100);

    const tableName = MODULE_TABLE_MAP[moduleKey];
    if (!tableName) return res.status(404).json({ success: false, error: 'Module not found' });

    const result = await pool.query(
      `SELECT * FROM ${tableName} ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    res.json({
      success: true,
      module_key: moduleKey,
      table_name: tableName,
      sample_count: result.rows.length,
      sample_data: result.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error getting sample data:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve sample data', message: error.message });
  }
});

module.exports = router;
