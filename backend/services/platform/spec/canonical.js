/**
 * The canonical EMBMIS entities a generated application may reference.
 *
 * ===========================================================================
 * WHY A HAND-WRITTEN CATALOGUE AND NOT information_schema
 * ===========================================================================
 * Reading the live catalogue would let an application reference any of the 190
 * tables in this database, including `users`, `ai_credentials`,
 * `company_isolation_config` and `audit_log`. "Which tables may an application
 * built by a language model join against, and which of their columns may reach
 * a supplier's browser?" is a security question with a specific answer, and a
 * specific answer has to be written down.
 *
 * So this file is the answer. An entity absent from here does not exist as far
 * as the platform is concerned, and a column absent from an entity's list
 * cannot be selected, filtered, sorted, displayed or aggregated — the runtime
 * resolves every canonical column name through `column()` below and refuses
 * anything it does not find.
 *
 * SENSITIVITY
 * ---------------------------------------------------------------------------
 * `shared: true` means the column may appear on an EXTERNAL surface — a
 * supplier portal, a customer portal. Everything else is internal by default,
 * which is the safe direction to be wrong in: a new column added to this file
 * without thinking about it stays inside the company. Cost, margin, internal
 * notes, credit standing and approval trails are never shared, and the
 * validator refuses a specification that puts an unshared column on an
 * external surface rather than trusting the UI to hide it.
 *
 * ANCHORS
 * ---------------------------------------------------------------------------
 * `anchorKind` marks the two entities an external identity can BE. A supplier
 * portal user is supplier 0f3a…; every row they can reach is reached through a
 * reference to that id. This is what turns "suppliers only see their own
 * findings" from a filter someone remembered to write into a property of the
 * data model that the runtime derives.
 */

const CANONICAL_ENTITIES = {
  suppliers: {
    key: 'suppliers',
    table: 'suppliers',
    label: 'Suppliers',
    singular: 'Supplier',
    description: 'Companies EMBMIS buys from. Authoritative supplier master data.',
    companyScoped: true,
    anchorKind: 'supplier',
    display: ['legal_name', 'supplier_code'],
    search: ['legal_name', 'trade_name', 'supplier_code', 'email'],
    defaultSort: 'legal_name',
    columns: {
      id:                     { type: 'reference', shared: true },
      supplier_code:          { type: 'text',   shared: true },
      legal_name:             { type: 'text',   shared: true },
      trade_name:             { type: 'text',   shared: true },
      email:                  { type: 'email',  shared: true },
      phone:                  { type: 'phone',  shared: true },
      country:                { type: 'text',   shared: true },
      city:                   { type: 'text',   shared: true },
      address:                { type: 'long_text', shared: false },
      supplier_type:          { type: 'text',   shared: true },
      certification_status:   { type: 'text',   shared: true },
      payment_terms:          { type: 'text',   shared: false },
      currency:               { type: 'text',   shared: false },
      status:                 { type: 'text',   shared: true },
      created_at:             { type: 'datetime', shared: false },
    },
    // Measures computed live from this company's purchase orders, goods
    // receipts and the delivery trace (services/supplierRisk.js). Read-only,
    // never stored, and never shared: a supplier does not see its own score.
    live: {
      provider: 'supplier_risk',
      label: 'Supplier risk',
      description: 'Reliability, lead time, open exposure and the customer orders each supplier puts at risk, read live from purchasing.',
      columns: {
        risk_band:          { type: 'text',    label: 'Risk' },
        risk_score:         { type: 'integer', label: 'Score' },
        on_time_rate:       { type: 'percent', label: 'On time' },
        avg_days_late:      { type: 'decimal', label: 'Avg days late' },
        lead_time_days:     { type: 'decimal', label: 'Lead time (days)' },
        open_exposure:      { type: 'money',   label: 'Open exposure' },
        overdue_lines:      { type: 'integer', label: 'Overdue lines' },
        single_source_items:{ type: 'integer', label: 'Single-source items' },
        orders_at_risk:     { type: 'integer', label: 'Orders at risk' },
        value_at_risk:      { type: 'money',   label: 'Value at risk' },
        top_signal:         { type: 'text',    label: 'Why' },
      },
    },
  },

  customers: {
    key: 'customers',
    table: 'customers',
    label: 'Customers',
    singular: 'Customer',
    description: 'Companies and people EMBMIS sells to. Authoritative customer master data.',
    companyScoped: true,
    anchorKind: 'customer',
    display: ['customer_name', 'customer_code'],
    search: ['customer_name', 'legal_entity_name', 'customer_code', 'primary_email'],
    defaultSort: 'customer_name',
    columns: {
      id:                  { type: 'reference', shared: true },
      customer_code:       { type: 'text',  shared: true },
      customer_name:       { type: 'text',  shared: true },
      legal_entity_name:   { type: 'text',  shared: true },
      customer_type:       { type: 'text',  shared: true },
      primary_email:       { type: 'email', shared: true },
      phone:               { type: 'phone', shared: true },
      billing_city:        { type: 'text',  shared: true },
      billing_country:     { type: 'text',  shared: true },
      // Credit standing is a judgement the company makes about the customer.
      // It is never shown to the customer.
      status:              { type: 'text',  shared: false },
      created_at:          { type: 'datetime', shared: false },
    },
  },

  items: {
    key: 'items',
    table: 'items',
    label: 'Products & Items',
    singular: 'Item',
    description: 'The product/material master: everything the business buys, makes, stocks or sells.',
    companyScoped: true,
    display: ['name', 'item_code'],
    search: ['name', 'item_code', 'description', 'manufacturer_part_number'],
    defaultSort: 'name',
    columns: {
      id:               { type: 'reference', shared: true },
      item_code:        { type: 'text', shared: true },
      name:             { type: 'text', shared: true },
      description:      { type: 'long_text', shared: true },
      item_category:    { type: 'text', shared: true },
      unit_of_measure:  { type: 'text', shared: true },
      manufacturer:     { type: 'text', shared: true },
      manufacturer_part_number: { type: 'text', shared: true },
      criticality:      { type: 'text', shared: false },
      status:           { type: 'text', shared: false },
      created_at:       { type: 'datetime', shared: false },
    },
  },

  employees: {
    key: 'employees',
    table: 'employees',
    label: 'Employees',
    singular: 'Employee',
    description: 'People who work for the company. Pay and bank details are not exposed here at all.',
    companyScoped: true,
    display: ['first_name', 'last_name'],
    search: ['first_name', 'last_name', 'email', 'employee_number'],
    defaultSort: 'last_name',
    columns: {
      id:              { type: 'reference', shared: false },
      employee_number: { type: 'text',  shared: false },
      first_name:      { type: 'text',  shared: false },
      last_name:       { type: 'text',  shared: false },
      email:           { type: 'email', shared: false },
      department:      { type: 'text',  shared: false },
      position:        { type: 'text',  shared: false },
      hire_date:       { type: 'date',  shared: false },
      status:          { type: 'text',  shared: false },
      user_id:         { type: 'reference', shared: false },
      // base_salary, allowances, bank_account_number and every other payroll
      // column are deliberately absent. An application cannot reference what
      // the catalogue does not name.
    },
  },

  purchase_orders: {
    key: 'purchase_orders',
    table: 'purchase_orders',
    label: 'Purchase Orders',
    singular: 'Purchase Order',
    description: 'Commitments to buy from a supplier.',
    companyScoped: true,
    display: ['po_number'],
    search: ['po_number'],
    defaultSort: 'po_date',
    references: { supplier_id: 'suppliers' },
    columns: {
      id:            { type: 'reference', shared: true },
      po_number:     { type: 'text',  shared: true },
      supplier_id:   { type: 'reference', shared: true, target: 'suppliers' },
      po_date:       { type: 'date',  shared: true },
      delivery_date: { type: 'date',  shared: true },
      status:        { type: 'text',  shared: true },
      currency:      { type: 'text',  shared: true },
      total_amount:  { type: 'money', shared: true },
      // Internal approval trail stays internal.
      approved_by:   { type: 'reference', shared: false },
      approved_at:   { type: 'datetime', shared: false },
      created_at:    { type: 'datetime', shared: false },
    },
  },

  sales_orders: {
    key: 'sales_orders',
    table: 'sales_orders',
    label: 'Sales Orders',
    singular: 'Sales Order',
    description: 'Commitments to sell to a customer.',
    companyScoped: true,
    display: ['so_number'],
    search: ['so_number', 'customer_name', 'reference_number'],
    defaultSort: 'order_date',
    references: { customer_id: 'customers' },
    columns: {
      id:            { type: 'reference', shared: true },
      so_number:     { type: 'text',  shared: true },
      customer_id:   { type: 'reference', shared: true, target: 'customers' },
      order_date:    { type: 'date',  shared: true },
      delivery_date: { type: 'date',  shared: true },
      status:        { type: 'text',  shared: true },
      currency:      { type: 'text',  shared: true },
      total_amount:  { type: 'money', shared: true },
      priority:      { type: 'text',  shared: false },
      internal_notes:{ type: 'long_text', shared: false },
      created_at:    { type: 'datetime', shared: false },
    },
  },

  shipments: {
    key: 'shipments',
    table: 'shipments',
    label: 'Shipments',
    singular: 'Shipment',
    description: 'Outbound deliveries against a sales order, with carrier and tracking.',
    companyScoped: true,
    display: ['shipment_number'],
    search: ['shipment_number', 'tracking_number', 'carrier_name'],
    defaultSort: 'ship_date',
    references: { sales_order_id: 'sales_orders' },
    columns: {
      id:              { type: 'reference', shared: true },
      shipment_number: { type: 'text', shared: true },
      sales_order_id:  { type: 'reference', shared: true, target: 'sales_orders' },
      carrier_name:    { type: 'text', shared: true },
      tracking_number: { type: 'text', shared: true },
      shipping_status: { type: 'text', shared: true },
      ship_date:       { type: 'date', shared: true },
      delivery_date:   { type: 'date', shared: true },
      created_at:      { type: 'datetime', shared: false },
    },
  },

  goods_receipts: {
    key: 'goods_receipts',
    table: 'goods_receipts',
    label: 'Goods Receipts',
    singular: 'Goods Receipt',
    description: 'What actually arrived against a purchase order, and in what condition.',
    companyScoped: true,
    display: ['id'],
    search: ['batch_lot_number'],
    defaultSort: 'received_date',
    references: { po_id: 'purchase_orders' },
    columns: {
      id:                { type: 'reference', shared: true },
      po_id:             { type: 'reference', shared: true, target: 'purchase_orders' },
      quantity_received: { type: 'decimal', shared: true },
      condition_grade:   { type: 'text', shared: true },
      batch_lot_number:  { type: 'text', shared: true },
      received_date:     { type: 'datetime', shared: true },
      notes:             { type: 'long_text', shared: false },
      created_at:        { type: 'datetime', shared: false },
    },
  },

  projects: {
    key: 'projects',
    table: 'projects',
    label: 'Projects',
    singular: 'Project',
    description: 'Delivery projects, their schedule and their customer.',
    companyScoped: true,
    display: ['name', 'project_code'],
    search: ['name', 'project_code'],
    defaultSort: 'name',
    references: { customer_id: 'customers' },
    columns: {
      id:            { type: 'reference', shared: true },
      project_code:  { type: 'text', shared: true },
      name:          { type: 'text', shared: true },
      description:   { type: 'long_text', shared: true },
      customer_id:   { type: 'reference', shared: true, target: 'customers' },
      status:        { type: 'text', shared: true },
      start_date:    { type: 'date', shared: true },
      end_date:      { type: 'date', shared: true },
      manager_id:    { type: 'reference', shared: false },
      budget_amount: { type: 'money', shared: false },
      created_at:    { type: 'datetime', shared: false },
    },
  },

  customer_invoices: {
    key: 'customer_invoices',
    table: 'customer_invoices',
    label: 'Customer Invoices',
    singular: 'Customer Invoice',
    description: 'What the company has billed its customers.',
    companyScoped: true,
    display: ['invoice_number'],
    search: ['invoice_number'],
    defaultSort: 'invoice_date',
    references: { customer_id: 'customers' },
    columns: {
      id:                 { type: 'reference', shared: true },
      invoice_number:     { type: 'text', shared: true },
      customer_id:        { type: 'reference', shared: true, target: 'customers' },
      invoice_date:       { type: 'date', shared: true },
      due_date:           { type: 'date', shared: true },
      currency:           { type: 'text', shared: true },
      total_amount:       { type: 'money', shared: true },
      outstanding_amount: { type: 'money', shared: true },
      status:             { type: 'text', shared: true },
      internal_notes:     { type: 'long_text', shared: false },
      created_at:         { type: 'datetime', shared: false },
    },
  },

  supplier_invoices: {
    key: 'supplier_invoices',
    table: 'supplier_invoices',
    label: 'Supplier Invoices',
    singular: 'Supplier Invoice',
    description: 'What suppliers have billed the company.',
    companyScoped: true,
    display: ['bill_number'],
    search: ['bill_number', 'supplier_invoice_number'],
    defaultSort: 'invoice_date',
    references: { supplier_id: 'suppliers' },
    columns: {
      id:                 { type: 'reference', shared: true },
      bill_number:        { type: 'text', shared: true },
      supplier_invoice_number: { type: 'text', shared: true },
      supplier_id:        { type: 'reference', shared: true, target: 'suppliers' },
      invoice_date:       { type: 'date', shared: true },
      due_date:           { type: 'date', shared: true },
      currency:           { type: 'text', shared: true },
      total_amount:       { type: 'money', shared: true },
      outstanding_amount: { type: 'money', shared: true },
      status:             { type: 'text', shared: true },
      internal_notes:     { type: 'long_text', shared: false },
      created_at:         { type: 'datetime', shared: false },
    },
  },

  inventory_items: {
    key: 'inventory_items',
    table: 'inventory_items',
    label: 'Inventory',
    singular: 'Inventory Item',
    description: 'Stock positions: what is on hand, and where the reorder points sit.',
    companyScoped: true,
    display: ['id'],
    search: [],
    defaultSort: 'created_at',
    references: { item_master_id: 'items' },
    columns: {
      id:                     { type: 'reference', shared: false },
      item_master_id:         { type: 'reference', shared: false, target: 'items' },
      current_stock_quantity: { type: 'decimal', shared: false },
      minimum_stock_level:    { type: 'decimal', shared: false },
      reorder_point:          { type: 'decimal', shared: false },
      unit_price:             { type: 'money', shared: false },
      currency:               { type: 'text', shared: false },
      status:                 { type: 'text', shared: false },
      created_at:             { type: 'datetime', shared: false },
    },
  },

  storage_locations: {
    key: 'storage_locations',
    table: 'storage_locations',
    label: 'Storage Locations',
    singular: 'Storage Location',
    description: 'Warehouses and sites where stock is held, with their bins.',
    companyScoped: true,
    display: ['name'],
    search: ['code', 'name', 'city'],
    defaultSort: 'code',
    references: {},
    columns: {
      id:         { type: 'reference', shared: false },
      code:       { type: 'text', shared: false },
      name:       { type: 'text', shared: false },
      city:       { type: 'text', shared: false },
      country:    { type: 'text', shared: false },
      is_active:  { type: 'boolean', shared: false },
      status:     { type: 'text', shared: false },
      created_at: { type: 'datetime', shared: false },
    },
    // The warehouse twin: every bay, its stock, how many days it lasts and the
    // customer orders a short one puts at risk, computed live from placed
    // stock, goods issues and the delivery trace (services/warehouseTwin.js).
    // Read-only, never stored, never shared.
    live: {
      provider: 'warehouse_twin',
      view: 'twin',
      label: 'Warehouse twin',
      description: 'Every bay drawn from live stock: what is on it, days of cover, and the customer orders a short bay puts at risk.',
      columns: {
        city:           { type: 'text',    label: 'City' },
        bays:           { type: 'integer', label: 'Bays' },
        short_bays:     { type: 'integer', label: 'Short' },
        low_bays:       { type: 'integer', label: 'Low cover' },
        fill_pct:       { type: 'percent', label: 'Fill' },
        units:          { type: 'decimal', label: 'Units placed' },
        orders_at_risk: { type: 'integer', label: 'Orders at risk' },
        value_at_risk:  { type: 'money',   label: 'Value at risk' },
        in_transit:     { type: 'integer', label: 'In transit' },
        top_signal:     { type: 'text',    label: 'Why' },
      },
    },
  },

  work_orders: {
    key: 'work_orders',
    table: 'work_orders',
    label: 'Work Orders',
    singular: 'Work Order',
    description: 'Production orders: what is being made, how much, and where it stands.',
    companyScoped: true,
    display: ['wo_number'],
    search: ['wo_number'],
    defaultSort: 'planned_start_date',
    references: { item_id: 'items' },
    columns: {
      id:                 { type: 'reference', shared: false },
      wo_number:          { type: 'text', shared: false },
      item_id:            { type: 'reference', shared: false, target: 'items' },
      quantity_ordered:   { type: 'decimal', shared: false },
      quantity_produced:  { type: 'decimal', shared: false },
      status:             { type: 'text', shared: false },
      planned_start_date: { type: 'date', shared: false },
      planned_end_date:   { type: 'date', shared: false },
      created_at:         { type: 'datetime', shared: false },
    },
  },
};

/** Entities an external identity can be anchored to, by subject kind. */
const ANCHOR_ENTITIES = Object.fromEntries(
  Object.values(CANONICAL_ENTITIES)
    .filter((e) => e.anchorKind)
    .map((e) => [e.anchorKind, e.key])
);

function entity(key) {
  return Object.prototype.hasOwnProperty.call(CANONICAL_ENTITIES, key)
    ? CANONICAL_ENTITIES[key]
    : null;
}

/**
 * Resolve a canonical column, or null.
 *
 * Every read path calls this before a column name goes anywhere near SQL. It
 * returns the descriptor rather than a boolean so the caller also gets the type
 * and the sharing decision from the same lookup — two lookups is two chances to
 * check one and forget the other.
 */
function column(entityKey, columnName) {
  const e = entity(entityKey);
  if (!e) return null;
  if (!Object.prototype.hasOwnProperty.call(e.columns, columnName)) return null;
  return { name: columnName, ...e.columns[columnName] };
}

/**
 * The live measures a canonical entity offers, or null. These are not columns
 * of its table: the runtime asks their provider for them, for one company, on
 * an internal surface only.
 */
function live(entityKey) {
  const e = entity(entityKey);
  return e && e.live ? e.live : null;
}

/** Columns of a canonical entity that may cross to an external surface. */
function sharedColumns(entityKey) {
  const e = entity(entityKey);
  if (!e) return [];
  return Object.entries(e.columns).filter(([, c]) => c.shared).map(([name]) => name);
}

function list() {
  return Object.values(CANONICAL_ENTITIES).map((e) => ({
    key: e.key,
    label: e.label,
    singular: e.singular,
    description: e.description,
    anchorKind: e.anchorKind || null,
    live: e.live ? { label: e.live.label, description: e.live.description, columns: Object.keys(e.live.columns) } : null,
    columns: Object.entries(e.columns).map(([name, c]) => ({
      name, type: c.type, shared: !!c.shared, target: c.target || null,
    })),
  }));
}

module.exports = { CANONICAL_ENTITIES, ANCHOR_ENTITIES, entity, column, sharedColumns, live, list };
