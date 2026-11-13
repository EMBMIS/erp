/**
 * The applications a company built, as part of the business — for one screen
 * or one question. The brief (whatMattersNow) already ranks them with
 * everything else and ties each to the supplier, customer or order it points
 * at; this keeps the part that came from what the company built, optionally
 * for one application. Read as the person asking; changes nothing.
 */

const { whatMattersNow } = require('./whatMattersNow');
const { readBuiltSignals } = require('./builtSignals');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function builtInTheBusiness({ companyId, userId, role, application }) {
  if (!userId) return { error: 'What a company built is read as a person; sign in as one.' };
  const [brief, built] = await Promise.all([
    whatMattersNow({ companyId, userId, role, all: true }),
    readBuiltSignals({ companyId, userId, role }),
  ]);
  if (brief.error) return { error: brief.error };
  if (built.error) return { error: built.error };

  const want = application ? norm(application) : null;
  const matches = (key, name) => !want || norm(key) === want || norm(name).includes(want) || want.includes(norm(key));
  const apps = built.applications.filter((a) => matches(a.key, a.name));
  if (want && !apps.length) return { error: `No application called ${application} is deployed in this company.` };
  const keys = new Set(apps.map((a) => a.key));

  const items = brief.items
    .filter((i) => (i.area === 'Built in Sandbox' && keys.has(i.record?.application))
      || (i.area === 'Suppliers' && (i.built_records || []).some((b) => !want || matches('', b.application))))
    .map((i) => (i.area === 'Suppliers'
      ? {
        ...i,
        title: `${i.title} — and open in what you built`,
        // Supplier risk usually leads with the built record already; say it once.
        cause: i.built_records.some((b) => b.number && (i.cause || '').includes(b.number))
          ? i.cause
          : i.built_records.map((b) => `${b.application}: ${[b.number, b.title].filter(Boolean).join(' ')} (${b.why.join(', ')})`).join('; ') + (i.cause ? `. Also: ${i.cause}` : ''),
      }
      : i))
    .map((i, n) => ({ ...i, rank: n + 1 }));

  const records = built.records.filter((r) => keys.has(r.application.key));
  const reached = new Set(items.flatMap((i) => i.order_numbers || []));
  const notInView = apps.filter((a) => a.status === 'not_in_view').map((a) => a.name);
  const headline = !apps.length
    ? 'Nothing has been built in Sandbox yet. Describe what you need and Simeli drafts it (build_in_sandbox).'
    : !records.length
      ? `${apps.filter((a) => a.status === 'read').map((a) => a.name).join(', ') || 'No application'} read as you: nothing open is severe, past due or stuck.`
      : `${records.length} open record${records.length === 1 ? '' : 's'} in what you built need${records.length === 1 ? 's' : ''} someone`
        + `${built.summary.critical ? ` (${records.filter((r) => r.critical).length} critical)` : ''}`
        + `${reached.size ? `, reaching ${reached.size} customer order${reached.size === 1 ? '' : 's'}` : ''}. First: ${items[0]?.title || records[0].application.name}`;

  return {
    as_of: brief.as_of,
    headline,
    items,
    applications: apps.map((a) => ({ key: a.key, name: a.name, status: a.status, open: a.open, need_someone: a.flagged })),
    not_in_your_view: notInView,
    records: records.slice(0, 25).map((r) => ({
      application: r.application.name, entity: r.entity_label, number: r.number, title: r.title, state: r.state_label,
      critical: r.critical, overdue_days: r.overdue_days, why: r.signals.map((s) => s.text),
      points_at: r.refs.map((x) => ({ type: x.type, label: x.label })), link: r.link,
    })),
    method:
      'Every deployed application was read with your role in it. A record needs someone when its workflow state is not terminal '
      + 'and it is critical or high severity, past a due date, or past the workflow\'s time limit for its state (or it carries a '
      + 'failing grade). Each is tied to the supplier, customer or order it references: supplier risk counts it as a signal, and '
      + 'the customer orders it reaches come from the delivery trace. Nothing was changed.',
  };
}

module.exports = { builtInTheBusiness };
