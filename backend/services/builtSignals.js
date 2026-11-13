/**
 * "What you create does not sit beside the system. The sandbox neuron divides,
 * wires itself into what already exists, and becomes part of how your business
 * is understood."
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * A company builds Supplier Quality in Sandbox on Monday. On Wednesday a
 * critical finding against Nordbay goes past its response date. Before this
 * file, Simeli could read that finding if someone asked about supplier quality
 * by name — but its own picture of the business (supplier risk, the brief of
 * what needs a person, the watch that notices on its own) was built only from
 * the modules that shipped with the product. What the company built sat beside
 * the system, not in it.
 *
 * This reads every deployed application the way its own screens do, as the
 * person asking, and returns the open records that need someone — critical or
 * high severity, past a due date, or past the workflow's own time limit — each
 * with the EMBMIS records it points at (supplier, customer, order, item). The
 * existing watchers then treat those as part of the business: supplier risk
 * counts them as a signal, the brief ranks them next to everything else with
 * the customer orders they reach, and the watch notices them like anything
 * else.
 *
 * WHAT DECIDES "NEEDS SOMEONE"
 * ---------------------------------------------------------------------------
 * Nothing per application. Every rule reads the specification:
 *   • open      — the entity's workflow says the state is not terminal;
 *                 entities without a workflow are read for a bad rating only;
 *   • severe    — an enum named like severity / priority / criticality / impact
 *                 holding CRITICAL, HIGH, MAJOR, URGENT, BLOCKER or SEVERE;
 *   • overdue   — a date named like due / deadline / expected / promised /
 *                 target / expiry is past, on an open record;
 *   • stuck     — the workflow's own SLA for the state is exceeded
 *                 (runtime/workflow.slaBreaches, from transition history);
 *   • bad grade — an enum named like rating / grade / outcome / result / verdict
 *                 holding AT_RISK, UNACCEPTABLE, FAIL, POOR, NON_CONFORMING …
 *                 on a record touched in the last 120 days.
 * A record needs someone when it is open (or badly graded) and at least one of
 * the others holds.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *   • It reads as the person: their application roles, record scope and field
 *     access (runtime/authorization). An application they have no role in is
 *     reported as not in their view, never read with someone else's rights.
 *     Without a person there is nothing to read as, so nothing is read.
 *   • Company-scoped twice: the instance list is this company's, and every
 *     query runs inside asCompany (row-level security).
 *   • It changes nothing. A next step opens the record in its application or
 *     asks Simeli; any change is a person moving the workflow.
 */

const companyContext = require('./companyContext');
const registry = require('./platform/registry');
const resolver = require('./platform/runtime/resolver');
const authz = require('./platform/runtime/authorization');
const data = require('./platform/runtime/data');
const workflow = require('./platform/runtime/workflow');
const { asCompany } = require('./platform/db');
const { EXTERNAL_AUDIENCES } = require('./platform/spec/types');

const TTL_MS = 60 * 1000;
const PER_ENTITY = 100;
const cache = new Map();

const SEVERITY_FIELD = /(severity|priority|criticality|impact|urgency|risk_level|risk_band)/i;
const SEVERE_VALUE = /^(CRITICAL|HIGH|MAJOR|URGENT|BLOCKER|SEVERE|SEVERITY_?1|P1|P0)$/i;
const CRITICAL_VALUE = /^(CRITICAL|BLOCKER|URGENT|P0|SEVERITY_?1)$/i;
const DUE_FIELD = /(due|deadline|expected|promised|target|expir|valid_until|respond_by|needed_by)/i;
const NOT_DUE_FIELD = /(raised|created|completed|closed|resolved|received|start|assessed|opened)/i;
const GRADE_FIELD = /(rating|grade|outcome|result|verdict|assessment)/i;
const BAD_GRADE = /^(AT_RISK|UNACCEPTABLE|FAIL|FAILED|POOR|NON_?CONFORM(ING|ANCE)?|REJECTED|CRITICAL|RED|BLOCKED)$/i;

/** The EMBMIS records a built application can point at, and how the rest of the product names them. */
const CANONICAL_TYPE = {
  suppliers: 'supplier',
  customers: 'customer',
  items: 'item',
  sales_orders: 'sales_order',
  purchase_orders: 'purchase_order',
  employees: 'employee',
  projects: 'project',
  work_orders: 'work_order',
  shipments: 'shipment',
  goods_receipts: 'goods_receipt',
  customer_invoices: 'customer_invoice',
  supplier_invoices: 'supplier_invoice',
  inventory_items: 'inventory_item',
  storage_locations: 'storage_location',
};

const round = (v, p = 2) => Math.round((Number(v) || 0) * 10 ** p) / 10 ** p;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const humanise = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/** Where a person opens this record: the entity's internal detail page, else its list. */
function recordLink(appKey, spec, entityKey, recordId) {
  const internal = new Set((spec.surfaces || []).filter((s) => !EXTERNAL_AUDIENCES.has(s.audience)).map((s) => s.key));
  const pages = (spec.ui?.pages || []).filter((p) => p.entity === entityKey && (!p.surface || internal.has(p.surface)));
  const detail = pages.find((p) => p.kind === 'detail');
  if (detail && recordId) return `/apps/${appKey}/${detail.key}/${recordId}`;
  const list = pages.find((p) => p.kind === 'list') || pages[0];
  return list ? `/apps/${appKey}/${list.key}` : `/apps/${appKey}`;
}

/** What the specification says about one entity, for the rules above. */
function shapeOf(spec, entity) {
  const wf = resolver.workflowForEntity(spec, entity.key);
  const terminal = wf ? wf.states.filter((s) => s.terminal).map((s) => s.key) : [];
  const fields = entity.fields || [];
  const enumWith = (nameRe, valueRe) => fields.filter((f) => f.type === 'enum' && nameRe.test(f.name)
    && (f.values || []).some((v) => valueRe.test(String(v))));
  return {
    workflow: wf,
    stateField: wf?.state_field || null,
    terminal,
    stateLabels: Object.fromEntries((wf?.states || []).map((s) => [s.key, s.label || humanise(s.key)])),
    severity: enumWith(SEVERITY_FIELD, SEVERE_VALUE),
    due: fields.filter((f) => ['date', 'datetime'].includes(f.type) && DUE_FIELD.test(f.name) && !NOT_DUE_FIELD.test(f.name)),
    grade: enumWith(GRADE_FIELD, BAD_GRADE).filter((f) => f.name !== wf?.state_field),
    money: fields.filter((f) => f.type === 'money'),
    refs: fields.filter((f) => f.type === 'reference' && f.target?.kind === 'canonical' && CANONICAL_TYPE[f.target.entity]),
    title: entity.display?.title_field || fields.find((f) => ['text', 'slug'].includes(f.type))?.name || null,
    number: fields.find((f) => /^(reference|number|code|ref|.*_number|.*_no)$/.test(f.name) && ['text', 'slug'].includes(f.type))?.name || null,
  };
}

async function readEntity({ context, principal, entity, shape, today }) {
  const { readable } = authz.fieldAccess(principal, entity.key, entity);
  const open = shape.workflow && readable.has(shape.stateField);
  const grades = shape.grade.filter((f) => readable.has(f.name));
  if (!open && !grades.length) return [];

  const filters = open
    ? (shape.terminal.length ? [{ field: shape.stateField, operator: 'not_in', value: shape.terminal }] : [])
    : [];
  // Newest first (the runtime's default order), the most a person could act on.
  const { rows, total } = await data.list(context, principal, entity.key, { filters, direction: 'desc', pageSize: PER_ENTITY });

  let stuck = new Map();
  if (open && shape.workflow.slas?.length) {
    const breaches = await workflow.slaBreaches(context, principal, shape.workflow.key).catch(() => []);
    stuck = new Map(breaches.map((b) => [b.recordId, b]));
  }

  const out = [];
  for (const row of rows) {
    const signals = [];
    let critical = false;

    for (const f of shape.severity) {
      const v = row[f.name];
      if (v != null && readable.has(f.name) && SEVERE_VALUE.test(String(v))) {
        if (CRITICAL_VALUE.test(String(v))) critical = true;
        signals.push({ kind: 'severe', text: `${humanise(v)} ${humanise(f.label || f.name)}`, value: String(v) });
      }
    }
    if (open) {
      for (const f of shape.due) {
        const v = row[f.name];
        if (!v || !readable.has(f.name)) continue;
        const days = Math.floor((today - new Date(`${iso(v)}T00:00:00Z`)) / 86400000);
        if (days > 0) signals.push({ kind: 'overdue', days, text: `${plural(days, 'day')} past its ${humanise(f.label || f.name)} (${iso(v)})`, date: iso(v) });
      }
      const sla = stuck.get(row.id);
      if (sla) signals.push({ kind: 'stuck', hours: sla.hoursInState, text: `${sla.label} — ${humanise(shape.stateLabels[sla.state] || sla.state)} for ${Math.round(sla.hoursInState / 24)} days, the limit is ${Math.round(sla.limitHours / 24) || 1}`, escalate_to_role: sla.escalateToRole });
    }
    const recent = row.updated_at && (today - new Date(row.updated_at)) / 86400000 <= 120;
    for (const f of grades) {
      const v = row[f.name];
      if (v != null && recent && BAD_GRADE.test(String(v))) signals.push({ kind: 'bad_grade', text: `rated ${humanise(v)}`, value: String(v) });
    }

    // Severity alone on an open record is enough; a closed-out record only counts for a bad grade.
    if (!signals.length) continue;
    if (!open && !signals.some((s) => s.kind === 'bad_grade')) continue;

    const overdueDays = Math.max(0, ...signals.filter((s) => s.kind === 'overdue').map((s) => s.days));
    const own = shape.money.filter((f) => readable.has(f.name)).reduce((sum, f) => sum + (Number(row[f.name]) || 0), 0);
    out.push({
      id: row.id,
      entity: entity.key,
      entity_label: entity.singular || entity.label || humanise(entity.key),
      number: (shape.number && row[shape.number]) || null,
      title: (shape.title && row[shape.title]) || null,
      state: open ? row[shape.stateField] : null,
      state_label: open ? (shape.stateLabels[row[shape.stateField]] || humanise(row[shape.stateField])) : null,
      critical,
      overdue_days: overdueDays || null,
      signals,
      own_value: own > 0 ? round(own) : null,
      refs: shape.refs
        .filter((f) => readable.has(f.name) && row[f.name])
        .map((f) => ({
          entity: f.target.entity,
          type: CANONICAL_TYPE[f.target.entity],
          id: row[f.name],
          label: row[`${f.name}__label`] || null,
          via: f.label || humanise(f.name),
        })),
      updated_at: row.updated_at,
    });
  }
  return { records: out, open_total: total };
}

async function compute({ companyId, userId, role }) {
  const instances = (await asCompany(companyId, () => registry.listInstancesForCompany(companyId)))
    .filter((i) => i.status === 'active' && i.version_id);
  const today = new Date(`${iso(new Date())}T00:00:00Z`);

  const applications = [];
  const records = [];
  for (const inst of instances) {
    const app = { key: inst.app_key, name: inst.name, status: 'read', entities_read: 0, open: 0, flagged: 0 };
    applications.push(app);
    try {
      await asCompany(companyId, async () => {
        const context = await resolver.resolveApplication(companyId, inst.app_key);
        let principal;
        try {
          principal = await authz.internalPrincipal({
            companyId, instance: context.instance, spec: context.spec, userId, platformRole: role, surfaceKey: null,
          });
        } catch {
          app.status = 'not_in_view';
          return;
        }
        for (const entity of context.spec.data?.entities || []) {
          if (!authz.can(principal, entity.key, 'read')) continue;
          const shape = shapeOf(context.spec, entity);
          if (!shape.workflow && !shape.grade.length) continue;
          let got;
          try {
            got = await readEntity({ context, principal, entity, shape, today });
          } catch (err) {
            if (err?.status === 403 || err?.code === 'FILTER_DENIED') continue;
            throw err;
          }
          if (!got || !got.records) continue;
          app.entities_read += 1;
          app.open += shape.workflow ? (got.open_total || 0) : 0;
          for (const r of got.records) {
            records.push({
              ...r,
              application: { key: inst.app_key, name: inst.name },
              link: recordLink(inst.app_key, context.spec, entity.key, r.id),
            });
          }
          app.flagged += got.records.length;
        }
      });
    } catch (err) {
      console.warn(`[builtSignals] ${inst.app_key} could not be read:`, err.message);
      app.status = 'failed';
    }
  }

  // Most pressing first: critical, then longest overdue, then stuck, then money.
  const weight = (r) => (r.critical ? 1000 : 0) + Math.min(r.overdue_days || 0, 365)
    + (r.signals.some((s) => s.kind === 'stuck') ? 50 : 0) + (r.signals.some((s) => s.kind === 'severe') ? 100 : 0);
  records.sort((a, b) => weight(b) - weight(a) || (b.own_value || 0) - (a.own_value || 0));

  const { rows: [co] } = await companyContext.withCompany(companyId, (c) => c.query('SELECT base_currency FROM companies WHERE id = $1', [companyId]));
  return {
    as_of: new Date().toISOString(),
    currency: co?.base_currency || null,
    applications,
    records,
    summary: {
      applications: applications.length,
      read: applications.filter((a) => a.status === 'read').length,
      not_in_view: applications.filter((a) => a.status === 'not_in_view').length,
      flagged: records.length,
      critical: records.filter((r) => r.critical).length,
      overdue: records.filter((r) => r.overdue_days).length,
    },
  };
}

/**
 * Every open record in this company's built applications that needs someone,
 * read as the person. Cached for a minute per person.
 *
 * @param {object} opts { companyId, userId, role, fresh }
 */
async function readBuiltSignals(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  if (!companyId) return { error: 'No company to read.' };
  if (!opts.userId) {
    return { as_of: new Date().toISOString(), applications: [], records: [], summary: { applications: 0, read: 0, not_in_view: 0, flagged: 0, critical: 0, overdue: 0 }, note: 'Built applications are read as a person; there is no person here.' };
  }
  const role = opts.role ? String(opts.role).toUpperCase() : null;
  const key = `${companyId}:${opts.userId}:${role || '-'}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = compute({ companyId, userId: opts.userId, role });
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return promise;
}

/** One line for a record: "QF-7 'Surface finish…' (critical severity, 6 days past its response due)". */
function describeRecord(r) {
  const name = [r.number, r.title && `“${r.title}”`].filter(Boolean).join(' ') || r.entity_label;
  const why = r.signals.map((s) => s.text).join(', ');
  return `${name}${r.state_label ? ` — ${r.state_label}` : ''}${why ? ` (${why})` : ''}`;
}

/** The flagged records that point at one EMBMIS record, grouped by application. */
function recordsFor(result, type, id) {
  return (result?.records || []).filter((r) => r.refs.some((x) => x.type === type && x.id === id));
}

module.exports = { readBuiltSignals, describeRecord, recordsFor, CANONICAL_TYPE };
