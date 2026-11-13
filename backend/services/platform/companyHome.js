/**
 * The company home: what the business is, how it is doing, and what needs
 * looking at.
 *
 * ===========================================================================
 * EVERY NUMBER ON THIS SCREEN COMES FROM A ROW
 * ===========================================================================
 * A home page is the screen people trust most and check least, which makes it
 * the worst possible place for a figure nobody can trace. So the rule here is
 * absolute: if it cannot be computed from canonical data, it is not on the
 * page. Two tiles from the design were cut on that basis rather than filled
 * with something plausible:
 *
 *   "Factories · 3"          there is no factory or plant table. `Locations`,
 *                            from storage_locations, is the real version.
 *   "Sustainability · on     no emissions data exists anywhere in the schema.
 *    track, 12% lower"       An invented environmental claim is a worse thing
 *                            to ship than a missing tile.
 *   "Cash balance"           the ledger's cash position needs the GL, which is
 *                            not canonical. `Receivables` — money actually
 *                            owed on invoices — is sourceable and is what is
 *                            shown.
 *
 * ===========================================================================
 * THE HEALTH VERDICTS ARE RULES, NOT A MODEL
 * ===========================================================================
 * "Supply Chain · Attention" is a judgement, and a judgement on a home page
 * has to be the same judgement tomorrow for the same data. An LLM call per
 * company per page load would be none of: cheap, fast, or repeatable, and
 * nobody can argue with it.
 *
 * So each band is a threshold over a counted fact, declared in RULES below
 * where a person can read it and disagree. Simeli's job is to EXPLAIN a
 * verdict when asked, not to decide it.
 *
 * "Open" is defined by dates rather than status strings throughout. Status
 * vocabularies differ per deployment and guessing one produces a number that
 * is confidently wrong; `delivery_date >= today` means the same thing
 * everywhere.
 */

const companyContext = require('../companyContext');
const { asCompany } = require('./db');

const MONTHS = 12;

/** A month-by-month series, oldest first, for a sparkline. */
async function series(client, { table, dateColumn, expression = 'count(*)' }) {
  const { rows } = await client.query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', CURRENT_DATE) - INTERVAL '${MONTHS - 1} months',
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month'
       ) AS bucket
     )
     SELECT m.bucket, COALESCE(agg.value, 0)::float8 AS value
       FROM months m
       LEFT JOIN (
         SELECT date_trunc('month', ${dateColumn}) AS bucket, ${expression} AS value
           FROM ${table}
          WHERE ${dateColumn} IS NOT NULL
          GROUP BY 1
       ) agg ON agg.bucket = m.bucket
      ORDER BY m.bucket`
  );
  return rows.map((r) => Number(r.value));
}

/** One scalar. */
async function scalar(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  const value = rows[0] ? Object.values(rows[0])[0] : null;
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * The change between the last two complete months.
 *
 * Deliberately not "this month so far vs last month", which compares six days
 * against thirty and reports a collapse every time somebody opens the page on
 * the 6th. Where either month is empty there is no honest percentage, and the
 * delta is omitted rather than shown as a confident 0%.
 */
function delta(points) {
  if (points.length < 3) return null;
  const previous = points[points.length - 3];
  const last = points[points.length - 2];
  if (!previous) return null;
  return Math.round(((last - previous) / Math.abs(previous)) * 1000) / 10;
}

/**
 * The health rules, as data.
 *
 * `count` is a fact. `verdict` reads it and returns one of strong / healthy /
 * attention / risk with a sentence saying what the number is. Written out
 * rather than inferred so that someone who disagrees with a threshold can find
 * it, change it, and know exactly what they changed.
 */
const RULES = [
  {
    key: 'operations',
    label: 'Operations',
    icon: 'factory',
    route: '/manufacturing',
    async facts(client) {
      return {
        overdue: await scalar(client,
          `SELECT count(*) FROM work_orders
            WHERE planned_end_date < CURRENT_DATE
              AND COALESCE(quantity_produced, 0) < quantity_ordered`),
        open: await scalar(client,
          `SELECT count(*) FROM work_orders
            WHERE COALESCE(quantity_produced, 0) < quantity_ordered`),
      };
    },
    verdict({ overdue, open }) {
      if (!open) return { state: 'healthy', line: 'Nothing on the floor right now.' };
      if (overdue === 0) return { state: 'strong', line: `${open} work order${open === 1 ? '' : 's'} open, none late.` };
      if (overdue / open > 0.2) return { state: 'risk', line: `${overdue} of ${open} work orders are past their planned end.` };
      return { state: 'attention', line: `${overdue} work order${overdue === 1 ? ' is' : 's are'} past the planned end date.` };
    },
  },
  {
    key: 'supply_chain',
    label: 'Supply Chain',
    icon: 'truck',
    route: '/procurement',
    async facts(client) {
      return {
        late: await scalar(client,
          `SELECT count(*) FROM purchase_orders po
            WHERE po.delivery_date < CURRENT_DATE
              AND NOT EXISTS (SELECT 1 FROM goods_receipts gr WHERE gr.po_id = po.id)`),
        open: await scalar(client,
          `SELECT count(*) FROM purchase_orders po
            WHERE po.delivery_date IS NULL OR po.delivery_date >= CURRENT_DATE
               OR NOT EXISTS (SELECT 1 FROM goods_receipts gr WHERE gr.po_id = po.id)`),
      };
    },
    verdict({ late, open }) {
      if (!open) return { state: 'healthy', line: 'No purchase orders outstanding.' };
      if (late === 0) return { state: 'strong', line: `${open} purchase order${open === 1 ? '' : 's'} outstanding, none overdue.` };
      if (late > 5) return { state: 'risk', line: `${late} purchase orders are past their delivery date with nothing received.` };
      return { state: 'attention', line: `${late} purchase order${late === 1 ? '' : 's'} overdue with nothing received.` };
    },
  },
  {
    key: 'finance',
    label: 'Finance',
    icon: 'ledger',
    route: '/finance/overview',
    async facts(client) {
      return {
        overdue: await scalar(client,
          `SELECT COALESCE(sum(outstanding_amount), 0) FROM customer_invoices
            WHERE due_date < CURRENT_DATE AND COALESCE(outstanding_amount, 0) > 0`),
        outstanding: await scalar(client,
          `SELECT COALESCE(sum(outstanding_amount), 0) FROM customer_invoices
            WHERE COALESCE(outstanding_amount, 0) > 0`),
      };
    },
    verdict({ overdue, outstanding }) {
      if (!outstanding) return { state: 'healthy', line: 'Nothing outstanding from customers.' };
      const share = overdue / outstanding;
      const money = (n) => new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD', maximumFractionDigits: 0,
      }).format(n);
      if (overdue === 0) return { state: 'strong', line: `${money(outstanding)} outstanding, none past due.` };
      if (share > 0.3) return { state: 'risk', line: `${money(overdue)} of ${money(outstanding)} is past due.` };
      return { state: 'attention', line: `${money(overdue)} past due out of ${money(outstanding)}.` };
    },
  },
  {
    key: 'people',
    label: 'People',
    icon: 'people',
    route: '/hr/overview',
    async facts(client) {
      return {
        headcount: await scalar(client, 'SELECT count(*) FROM employees'),
        joined: await scalar(client,
          `SELECT count(*) FROM employees WHERE hire_date >= CURRENT_DATE - INTERVAL '90 days'`),
        // People who started more than a fortnight ago and still cannot log
        // in. The first draft of this rule counted headcount and joiners,
        // which are both good news by construction — the band could never say
        // anything but "healthy", which a test caught and which would have
        // shipped a decorative status light. This is a real gap somebody can
        // close, and the only one the employee catalogue can see: pay,
        // performance and leave dates are deliberately not in it.
        unonboarded: await scalar(client,
          `SELECT count(*) FROM employees
            WHERE user_id IS NULL AND hire_date <= CURRENT_DATE - INTERVAL '14 days'`),
      };
    },
    verdict({ headcount, joined, unonboarded }) {
      if (!headcount) return { state: 'healthy', line: 'No employee records yet.' };
      if (unonboarded && unonboarded / headcount > 0.25) {
        return { state: 'risk', line: `${unonboarded} of ${headcount} people still have no system account.` };
      }
      if (unonboarded) {
        return { state: 'attention', line: `${unonboarded} ${unonboarded === 1 ? 'person has' : 'people have'} no system account two weeks after starting.` };
      }
      if (joined) return { state: 'strong', line: `${headcount} people, ${joined} joined in the last quarter, all set up.` };
      return { state: 'healthy', line: `${headcount} people on the books.` };
    },
  },
];

/** Everything the home page draws, in one round trip. */
async function build(companyId) {
  return companyContext.withCompany(companyId, async (client) => {
    // The company itself. Read here rather than taken from the auth payload
    // because the auth payload does not carry it — and a home page that
    // greets you with "Your company" is a home page nobody believes is
    // actually looking at their data.
    const { rows: companyRows } = await client.query(
      'SELECT id, name, company_code, base_currency FROM companies WHERE id = $1', [companyId]
    );

    const [
      suppliers, customers, locations, activeProjects, openOrders,
      revenueSeries, ordersSeries, projectsSeries, headcount,
      receivables, onTime, delivered,
    ] = await Promise.all([
      scalar(client, 'SELECT count(*) FROM suppliers'),
      scalar(client, 'SELECT count(*) FROM customers'),
      scalar(client, 'SELECT count(*) FROM storage_locations').catch(() => 0),
      scalar(client, `SELECT count(*) FROM projects
                       WHERE end_date IS NULL OR end_date >= CURRENT_DATE`),
      scalar(client, `SELECT count(*) FROM sales_orders
                       WHERE delivery_date IS NULL OR delivery_date >= CURRENT_DATE`),
      series(client, { table: 'customer_invoices', dateColumn: 'invoice_date', expression: 'COALESCE(sum(total_amount), 0)' }),
      series(client, { table: 'sales_orders', dateColumn: 'order_date' }),
      series(client, { table: 'projects', dateColumn: 'start_date' }),
      scalar(client, 'SELECT count(*) FROM employees'),
      scalar(client, `SELECT COALESCE(sum(outstanding_amount), 0) FROM customer_invoices
                       WHERE COALESCE(outstanding_amount, 0) > 0`),
      // On-time delivery, from the two dates that actually exist: when the
      // shipment landed against when the order promised it.
      scalar(client, `SELECT count(*) FROM shipments s
                        JOIN sales_orders o ON o.id = s.sales_order_id
                       WHERE s.delivery_date IS NOT NULL AND o.delivery_date IS NOT NULL
                         AND s.delivery_date <= o.delivery_date`),
      scalar(client, `SELECT count(*) FROM shipments s
                        JOIN sales_orders o ON o.id = s.sales_order_id
                       WHERE s.delivery_date IS NOT NULL AND o.delivery_date IS NOT NULL`),
    ]);

    const health = [];
    for (const rule of RULES) {
      try {
        const facts = await rule.facts(client);
        health.push({
          key: rule.key, label: rule.label, icon: rule.icon, route: rule.route,
          ...rule.verdict(facts), facts,
        });
      } catch (error) {
        // A deployment without the manufacturing tables is a smaller
        // installation, not a broken one. It gets one fewer band.
        console.warn(`[platform] health rule ${rule.key} unavailable:`, error.message);
      }
    }

    return {
      company: companyRows[0] || { id: companyId, name: 'This company' },
      hero: [
        { key: 'suppliers', label: 'Suppliers', value: suppliers },
        { key: 'customers', label: 'Customers', value: customers },
        { key: 'locations', label: 'Locations', value: locations },
        { key: 'projects', label: 'Active projects', value: activeProjects },
        { key: 'orders', label: 'Open orders', value: openOrders },
      ].filter((s) => s.value > 0),
      metrics: [
        // The TWELVE-MONTH TOTAL, not the current month.
        //
        // The first version showed the latest bucket, which is the month in
        // progress — so on the 3rd it read "$0" underneath a sparkline
        // climbing steadily, which is the single most alarming thing a finance
        // tile can do while being technically correct. Orders is summed the
        // same way, so the two tiles mean the same kind of thing.
        { key: 'revenue', label: 'Revenue', format: 'money', accent: 'green',
          value: revenueSeries.reduce((a, b) => a + b, 0), series: revenueSeries,
          delta: delta(revenueSeries), href: '/finance/overview' },
        { key: 'receivables', label: 'Receivables', format: 'money', accent: 'blue',
          value: receivables, series: [], delta: null, href: '/finance/overview' },
        { key: 'orders', label: 'Orders', format: 'number', accent: 'blue',
          value: ordersSeries.reduce((a, b) => a + b, 0), series: ordersSeries,
          delta: delta(ordersSeries), href: '/sales/overview' },
        { key: 'on_time', label: 'On-time delivery', format: 'percent', accent: 'amber',
          value: delivered ? Math.round((onTime / delivered) * 1000) / 10 : null,
          series: [], delta: null, href: '/sales/overview' },
        { key: 'employees', label: 'Employees', format: 'number', accent: 'violet',
          value: headcount, series: [], delta: null, href: '/hr/overview' },
        { key: 'projects', label: 'Active projects', format: 'number', accent: 'cyan',
          value: activeProjects, series: projectsSeries, delta: delta(projectsSeries),
          href: '/projects/overview' },
      ],
      health,
    };
  });
}

module.exports = { build: (companyId) => asCompany(companyId, () => build(companyId)), RULES, delta };
