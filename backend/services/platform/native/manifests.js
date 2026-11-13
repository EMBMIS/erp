/**
 * The built-in modules, described as applications.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * EMBMIS calls itself a Business OS. An operating system's defining property
 * is that it runs applications through one set of rules — the built-in ones
 * and the ones somebody else wrote. Until now Finance and a capability a
 * company designed this morning were different KINDS of thing: different
 * navigation, different catalogue, different idea of "installed". That is an
 * ERP with a plugin system, not an OS.
 *
 * A manifest is what makes Finance an application without rewriting Finance.
 * The claim is narrow and worth stating exactly:
 *
 *     An application is a manifest plus a set of surfaces.
 *     HOW a surface renders is that application's own business.
 *
 * A generated application's screens are specification blocks compiled by the
 * platform. A native application's screens are the React routes that already
 * exist. Both are applications. Neither one's rendering strategy is visible to
 * the shell, the catalogue, the permission model or the home page.
 *
 * ===========================================================================
 * WHAT A NATIVE APPLICATION IS NOT
 * ===========================================================================
 * It does not OWN tables. A generated application owns private per-company
 * tables and `app_instance_tables` is authoritative about their names. Finance
 * reads and writes the shared canonical tables that every other part of EMBMIS
 * also uses. Blurring that would quietly wreck the isolation story, so a
 * manifest has `references` and never `owns`, and nothing here can produce a
 * physical table name.
 *
 * Its on/off switch is `company_modules`, which has governed these modules
 * since long before the platform existed. Reusing it rather than minting a
 * second switch is deliberate: two places that both claim to say whether
 * Finance is on is a bug waiting for a support ticket.
 *
 * ===========================================================================
 * THE TILES
 * ===========================================================================
 * `home.tiles` are DECLARATIONS, not queries. One resolver
 * (native/summary.js) turns them into SQL, validating every entity and column
 * against the canonical catalogue first — so a typo in this file fails loudly
 * on the first test run instead of reaching a database.
 *
 * Every tile here is an aggregate that does not depend on guessing an enum
 * value. Where a status IS used it is one this codebase already uses in
 * pages/Dashboard.jsx, not one invented here.
 *
 * `home.tiles` are figures. `work.tiles` are the same declarations pointed at
 * a different question — not "how big is this" but "what is waiting". They
 * feed My Work, where a core application's overdue purchase orders sit beside
 * a finding awaiting review in something a company built last week. The
 * sentinel 'TODAY' is resolved by the resolver rather than written as a date,
 * because a date baked into a declaration is right for exactly one day.
 */

/**
 * @typedef {object} NativeManifest
 * @property {string}   key         Application key. Matches the frontend module key.
 * @property {string}   moduleKey   `modules.key` — the existing per-company switch.
 * @property {string[]} references  Canonical entities it reads. NEVER owns.
 * @property {string[]} writes      Of those, the ones it also writes.
 * @property {boolean}  catalogued  Defaults true. False means this
 *                                  application's data is deliberately outside
 *                                  the canonical catalogue, so no generated
 *                                  application can reference it.
 * @property {object}   home        What it contributes to the home page.
 */

const MANIFESTS = [
  {
    // ===========================================================================
    // Mail is the one application whose data is NOT in the canonical catalogue.
    // ===========================================================================
    // Mailboxes, conversations and messages are real company data and Mail
    // reads and writes them all day. They are deliberately absent from
    // spec/canonical.js, and adding them so that this manifest could list
    // something would be a security decision dressed up as tidiness: the
    // canonical catalogue is exactly the set of record types a GENERATED
    // application may reference, so putting mail in it would let a capability
    // somebody designed in a sentence read the company's correspondence.
    //
    // So `references` is empty and `catalogued: false` says why. An
    // application with no canonical references is not an application that
    // touches nothing — it is one whose data nothing else can reach.
    key: 'mail',
    name: 'Mail',
    description: 'Shared mailboxes, conversations, and the messages the business sends and receives.',
    icon: 'envelope',
    category: 'operations',
    moduleKey: 'mail',
    route: '/mail',
    match: ['/mail'],
    references: [],
    writes: [],
    catalogued: false,
    // No tiles. The tile resolver validates every entity and column against
    // the canonical catalogue before it builds SQL, and mail is not in it —
    // by design, above. Giving Mail figures on the home page or in My Work
    // means either widening that catalogue or giving the resolver a second
    // way in, and neither is worth doing for a message count.
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'The ledger, what customers owe and what is owed to suppliers.',
    icon: 'chart-bar',
    category: 'finance',
    moduleKey: 'finance',
    route: '/finance/overview',
    match: ['/finance'],
    references: ['customer_invoices', 'supplier_invoices', 'customers', 'suppliers'],
    writes: ['customer_invoices', 'supplier_invoices'],
    work: {
      tiles: [
        { key: 'overdue_invoices', label: 'Invoices past due', route: '/finance/receivables',
          entity: 'customer_invoices', aggregate: 'count',
          where: [['due_date', 'lt', 'TODAY'], ['outstanding_amount', 'gt', 0]] },
      ],
    },
    home: {
      tiles: [
        { key: 'receivables', label: 'Receivables', hint: 'Outstanding on customer invoices',
          entity: 'customer_invoices', aggregate: 'sum', field: 'outstanding_amount', format: 'money' },
        { key: 'payables', label: 'Payables', hint: 'Outstanding to suppliers',
          entity: 'supplier_invoices', aggregate: 'sum', field: 'outstanding_amount', format: 'money' },
        { key: 'invoiced', label: 'Invoiced', hint: 'Billed to customers, all time',
          entity: 'customer_invoices', aggregate: 'sum', field: 'total_amount', format: 'money' },
      ],
    },
  },
  {
    key: 'procurement',
    name: 'Procurement',
    description: 'Buying: requisitions, purchase orders and the suppliers behind them.',
    icon: 'building-storefront',
    category: 'procurement',
    moduleKey: 'procurement',
    route: '/procurement',
    match: ['/procurement'],
    references: ['purchase_orders', 'suppliers', 'goods_receipts', 'supplier_invoices'],
    writes: ['purchase_orders', 'goods_receipts'],
    work: {
      tiles: [
        { key: 'overdue_pos', label: 'Purchase orders past their delivery date', route: '/procurement',
          entity: 'purchase_orders', aggregate: 'count',
          where: [['delivery_date', 'lt', 'TODAY']] },
      ],
    },
    home: {
      tiles: [
        { key: 'open_pos', label: 'Purchase orders', hint: 'Approved or with suppliers',
          entity: 'purchase_orders', aggregate: 'count', format: 'number',
          where: [['status', 'in', ['APPROVED', 'SENT_TO_SUPPLIER']]] },
        { key: 'committed', label: 'Committed', hint: 'Value of open purchase orders',
          entity: 'purchase_orders', aggregate: 'sum', field: 'total_amount', format: 'money',
          where: [['status', 'in', ['APPROVED', 'SENT_TO_SUPPLIER']]] },
        { key: 'suppliers', label: 'Suppliers', hint: 'On the master list',
          entity: 'suppliers', aggregate: 'count', format: 'number' },
      ],
    },
  },
  {
    key: 'sales',
    name: 'Sales',
    description: 'Quotations, orders and what has been shipped against them.',
    icon: 'shopping-cart',
    category: 'sales',
    moduleKey: 'sales',
    route: '/sales/overview',
    match: ['/sales'],
    references: ['sales_orders', 'customers', 'shipments', 'customer_invoices'],
    writes: ['sales_orders', 'shipments'],
    home: {
      tiles: [
        { key: 'orders', label: 'Sales orders', hint: 'On the books',
          entity: 'sales_orders', aggregate: 'count', format: 'number' },
        { key: 'order_value', label: 'Order value', hint: 'Total across all orders',
          entity: 'sales_orders', aggregate: 'sum', field: 'total_amount', format: 'money' },
      ],
    },
  },
  {
    key: 'inventory',
    name: 'Inventory',
    description: 'What the company holds, where it is held and what it is worth.',
    icon: 'archive-box',
    category: 'operations',
    moduleKey: 'inventory',
    route: '/inventory',
    match: ['/inventory', '/items', '/warehouse', '/stocktake'],
    references: ['items', 'inventory_items', 'goods_receipts', 'shipments'],
    writes: ['items', 'inventory_items'],
    home: {
      tiles: [
        { key: 'items', label: 'Items', hint: 'On the item master',
          entity: 'items', aggregate: 'count', format: 'number' },
      ],
    },
  },
  {
    key: 'manufacturing',
    name: 'Manufacturing',
    description: 'Work orders on the floor and what they have produced.',
    icon: 'wrench-screwdriver',
    category: 'operations',
    moduleKey: 'manufacturing',
    route: '/manufacturing',
    match: ['/manufacturing'],
    references: ['work_orders', 'items', 'inventory_items'],
    writes: ['work_orders'],
    work: {
      tiles: [
        { key: 'late_work_orders', label: 'Work orders past their planned end', route: '/manufacturing',
          entity: 'work_orders', aggregate: 'count',
          where: [['planned_end_date', 'lt', 'TODAY']] },
      ],
    },
    home: {
      tiles: [
        { key: 'open_wos', label: 'Work orders', hint: 'Released or in progress',
          entity: 'work_orders', aggregate: 'count', format: 'number',
          where: [['status', 'in', ['RELEASED', 'IN_PROGRESS']]] },
      ],
    },
  },
  {
    key: 'crm',
    name: 'CRM',
    description: 'Customers, the pipeline and everything said to them.',
    icon: 'user-group',
    category: 'sales',
    moduleKey: 'crm',
    route: '/crm/overview',
    match: ['/crm'],
    references: ['customers', 'sales_orders'],
    writes: ['customers'],
    home: {
      tiles: [
        { key: 'customers', label: 'Customers', hint: 'On the master list',
          entity: 'customers', aggregate: 'count', format: 'number' },
      ],
    },
  },
  {
    key: 'hr',
    name: 'HR',
    description: 'People, what they cost and what they are assigned to.',
    icon: 'user',
    category: 'hr',
    moduleKey: 'hr',
    route: '/hr/overview',
    match: ['/hr'],
    // Deliberately narrow. `employees` exposes no compensation column in the
    // canonical catalogue and this manifest is not the place to widen it.
    references: ['employees', 'projects'],
    writes: ['employees'],
    home: {
      tiles: [
        { key: 'employees', label: 'People', hint: 'Active employees',
          entity: 'employees', aggregate: 'count', format: 'number' },
      ],
    },
  },
  {
    key: 'projects',
    name: 'Projects',
    description: 'Work with a start, an end and a budget.',
    icon: 'clipboard-document-list',
    category: 'operations',
    moduleKey: 'projects',
    route: '/projects/overview',
    match: ['/projects'],
    references: ['projects', 'employees', 'customers'],
    writes: ['projects'],
    work: {
      tiles: [
        { key: 'overrun_projects', label: 'Projects past their end date', route: '/projects/overview',
          entity: 'projects', aggregate: 'count',
          where: [['end_date', 'lt', 'TODAY']] },
      ],
    },
    home: {
      tiles: [
        { key: 'projects', label: 'Projects', hint: 'On the books',
          entity: 'projects', aggregate: 'count', format: 'number' },
      ],
    },
  },
];

const BY_KEY = new Map(MANIFESTS.map((m) => [m.key, Object.freeze(m)]));

/** Every native application, in the order they should appear. */
const list = () => MANIFESTS.map((m) => BY_KEY.get(m.key));

/** One, or undefined. */
const get = (key) => BY_KEY.get(key);

/** The `modules.key` switches these applications are governed by. */
const moduleKeys = () => MANIFESTS.map((m) => m.moduleKey);

/** Every tile any native application declares, flattened, with its owner. */
const tiles = () => MANIFESTS.flatMap((m) => [
  ...(m.home?.tiles || []),
  ...(m.work?.tiles || []),
].map((t) => ({ ...t, appKey: m.key })));

/** Just the "what is waiting" ones. */
const workTiles = () => MANIFESTS.flatMap((m) =>
  (m.work?.tiles || []).map((t) => ({ ...t, appKey: m.key, appName: m.name, icon: m.icon })));

module.exports = { list, get, moduleKeys, tiles, workTiles, MANIFESTS };
