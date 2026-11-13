/**
 * What a Business OS tool call looks like to EMBMIS Gateway.
 *
 * The gateway's decide API takes an action type (READ | WRITE | PAYMENT), a
 * resource (kind, module, classification) and a context (amount, currency).
 * Business OS tools carry none of that explicitly, so it is derived here from
 * what IS reliably known: whether the tool is read-only, its name, and the
 * amount and table named in its arguments. Pure and synchronous, so the same
 * call always describes the same way.
 */

const MODULE_HINTS = [
  ['finance', /(journal|ledger|(^|_)gl(_|$)|payment|invoice|bank|(^|_)tax|fixed_asset|trial_balance|(^|_)(ar|ap)_|aging|dunning|reconcil|revaluation|budget|cash|(^|_)fx_|payable|receivable|accounting)/i],
  ['procurement', /(purchase|supplier|requisition|\bpo_|_po\b|rfq_|vendor)/i],
  ['manufacturing', /(work_order|mrp|bill_of_material|production|routing)/i],
  ['sales', /(sales|quotation|customer|delivery|order|contract)/i],
  ['inventory', /(stock|inventory|warehouse|reorder|transfer|bin\b|item)/i],
  ['hr', /(employee|payroll|leave|attendance|salary|candidate|timesheet)/i],
  ['crm', /(deal|pipeline|contact|lead|crm)/i],
  ['projects', /(project|milestone|time_entry)/i],
];

const PAYMENT_RE = /(payment|pay_|_pay\b|payout|disburse|remit|transfer_funds|wire|refund|settle)/i;
const PERSONAL_RE = /(employee|payroll|salary|leave|candidate|personal|contact|passport|national_id|home_address|date_of_birth|bank_account_number)/i;
const AMOUNT_FIELDS = ['amount', 'total_amount', 'total', 'grand_total', 'payment_amount', 'value', 'net_amount', 'gross_amount'];

function moduleFor(text) {
  for (const [name, re] of MODULE_HINTS) if (re.test(text)) return name;
  return 'general';
}

function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** First monetary amount in the args: top level, then one level down (rows, values, payload). */
function findAmount(args) {
  if (!args || typeof args !== 'object') return null;
  const scan = (obj) => {
    for (const f of AMOUNT_FIELDS) {
      const n = num(obj[f]);
      if (n !== null) return n;
    }
    return null;
  };
  const top = scan(args);
  if (top !== null) return Math.abs(top);
  for (const v of Object.values(args)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const n = scan(v);
      if (n !== null) return Math.abs(n);
    } else if (Array.isArray(v)) {
      // A batch is as large as its sum.
      let sum = 0, any = false;
      for (const row of v.slice(0, 500)) {
        if (row && typeof row === 'object') {
          const n = scan(row);
          if (n !== null) { sum += Math.abs(n); any = true; }
        }
      }
      if (any) return sum;
    }
  }
  return null;
}

function findCurrency(args) {
  if (!args || typeof args !== 'object') return undefined;
  const c = args.currency || args.currency_code || (args.values && args.values.currency) || (args.row && args.row.currency);
  return typeof c === 'string' && c.length <= 8 ? c.toUpperCase() : undefined;
}

/**
 * A copy of the arguments that is safe to hand to the gateway's audit chain:
 * same shape, bounded size. Long strings are cut, long lists truncated, depth
 * limited — the gateway needs to understand what is being attempted, not to
 * receive a document.
 */
function boundArgs(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => boundArgs(v, depth + 1));
    return value.length > 20 ? [...head, `… ${value.length - 20} more`] : head;
  }
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = boundArgs(v, depth + 1);
  return out;
}

/**
 * @param {object} p
 * @param {string} p.name       tool name or agent action type
 * @param {object} [p.args]
 * @param {boolean} [p.readOnly]  true for tools that cannot change data
 * @param {number} [p.amount]     explicit amount (agent actions carry one)
 * @param {string} [p.currency]
 */
function describe({ name, args = {}, readOnly = false, amount, currency }) {
  const table = typeof args.table === 'string' ? args.table : '';
  const haystack = `${name} ${table}`;

  const explicit = num(amount);
  const found = explicit !== null ? Math.abs(explicit) : findAmount(args);

  let action = 'WRITE';
  if (readOnly) action = 'READ';
  else if (PAYMENT_RE.test(haystack)) action = 'PAYMENT';

  const module = moduleFor(haystack);
  let classification = 'internal';
  if (PERSONAL_RE.test(haystack) || module === 'hr') classification = 'personal';
  else if (module === 'finance') classification = 'financial';

  return {
    tool: String(name).slice(0, 200),
    action,
    args: boundArgs(args),
    resource: { kind: table || String(name).replace(/^(get|list|create|update|record|run|post|approve|export|search|find)_/, ''), module, classification },
    amount: found !== null && found > 0 ? Math.round(found * 100) / 100 : undefined,
    currency: currency || findCurrency(args),
  };
}

module.exports = { describe, findAmount, boundArgs, moduleFor };
