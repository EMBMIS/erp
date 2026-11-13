/**
 * "Describe what you need and Sandbox builds it inside the system you already
 * run." — from wherever the person is asking.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The Capability Studio turns a sentence into an application, and Capability
 * Discovery proposes what to build from counted evidence. Both were reachable
 * only from the Studio's own screens, by an administrator. The place a person
 * actually says "create a supplier risk monitor" is Simeli — and that sentence
 * used to go nowhere.
 *
 * This takes the sentence from Simeli (or the Capability opportunities
 * screen) and puts it through the same pipeline the Studio uses:
 *
 *   Administrator   session.start designs it (the model, or the deterministic
 *                   process analyser when no model is configured) and saves a
 *                   DRAFT version; session.validate rehearses it in the sandbox
 *                   against the real schema. What comes back is what the
 *                   design is wired into — the existing records it references,
 *                   the live measures it shows (supplier risk, the warehouse
 *                   twin), its workflows, who sees it — the rehearsal verdict
 *                   and the database plan with each step's safety class.
 *   Anyone else     the request is recorded as a capability opportunity in the
 *                   person's own words, and the company's administrators are
 *                   told who asked for what. An administrator designs it from
 *                   the opportunities screen exactly as from discovery.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It deploys nothing. No table exists until an administrator opens the session
 * in the Studio, reads the plan and approves the deployment — the same gate as
 * every other application. Designing stays an administrator's act because a
 * design decides what data exists and who can see it.
 */

const crypto = require('crypto');
const companyContext = require('./companyContext');
const { asCompany } = require('./platform/db');
const session = require('./platform/studio/session');
const canonical = require('./platform/spec/canonical');

const isAdmin = (role) => String(role || '').toUpperCase() === 'ADMIN';

function requestKey(text) {
  const norm = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return crypto.createHash('sha256').update(`person_request:${norm}`).digest('hex').slice(0, 40);
}

/** What a design is made of, in the terms a person reads a plan in. */
function describeDesign(spec, report) {
  const entities = spec?.data?.entities || [];
  const byKey = new Map(entities.map((e) => [e.key, e]));
  const wired = new Map();
  const records = entities.map((e) => {
    const links = [];
    for (const f of e.fields || []) {
      if (f.type !== 'reference' || !f.target) continue;
      if (f.target.kind === 'canonical') {
        const c = canonical.entity(f.target.entity);
        const label = c?.label || f.target.entity;
        links.push(`${f.label || f.name} → ${label} (existing)`);
        if (!wired.has(label)) wired.set(label, { existing: label, how: `referenced by ${e.label}` });
      } else {
        links.push(`${f.label || f.name} → ${byKey.get(f.target.entity)?.label || f.target.entity}`);
      }
    }
    return { record: e.label, fields: (e.fields || []).length, links };
  });

  const pages = spec?.ui?.pages || [];
  const live = [];
  for (const p of pages) {
    for (const b of p.layout || []) {
      if (b.type !== 'live_monitor' || !b.canonical) continue;
      const measures = canonical.live(b.canonical);
      const c = canonical.entity(b.canonical);
      if (!measures || live.some((l) => l.monitor === measures.label)) continue;
      live.push({ monitor: measures.label, on: c?.label || b.canonical, reads: measures.description });
      wired.set(`${measures.label} (live)`, { existing: `${measures.label} (live)`, how: measures.description });
    }
  }

  const plan = report?.sections?.database?.plan || null;
  const operations = plan?.operations || [];
  const bySafety = {};
  for (const op of operations) bySafety[op.safety] = (bySafety[op.safety] || 0) + 1;

  return {
    wires_into: [...wired.values()],
    live_measures: live,
    records,
    workflows: (spec?.workflows || []).map((w) => ({
      workflow: w.label,
      on: byKey.get(w.entity)?.label || w.entity,
      states: (w.states || []).map((s) => s.label),
      deadlines: (w.slas || []).map((s) => s.label),
    })),
    seen_by: (spec?.surfaces || []).map((s) => ({
      surface: s.label, audience: s.audience, roles: s.roles || [],
    })),
    pages: pages.length,
    agents: (spec?.ai?.agents || []).map((a) => a.label || a.key),
    rehearsal: report ? {
      ok: !!report.ok,
      errors: report.summary?.errors || 0,
      warnings: report.summary?.warnings || 0,
      problems: Object.values(report.sections || {}).flatMap((s) => s.diagnostics || [])
        .filter((d) => d.level === 'error').slice(0, 5).map((d) => d.message),
    } : null,
    deployment_plan: operations.length ? {
      steps: operations.length,
      by_safety: bySafety,
      first_steps: operations.slice(0, 8).map((op) => ({ step: op.description || op.kind, safety: op.safety })),
    } : null,
  };
}

async function personName(userId) {
  if (!userId) return null;
  const { pool } = require('../config/database');
  const { rows } = await pool.query(
    "SELECT TRIM(CONCAT(first_name, ' ', last_name)) AS name, email FROM users WHERE id = $1", [userId]
  );
  return rows[0]?.name || rows[0]?.email || null;
}

/** The administrators of this company — the people who can design and deploy. */
async function companyAdmins(client, companyId) {
  const { rows } = await client.query(
    `SELECT u.id AS user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name
       FROM users u JOIN user_companies uc ON uc.user_id = u.id
      WHERE uc.company_id = $1 AND COALESCE(u.is_active, true) AND u.deleted_at IS NULL
        AND UPPER(COALESCE(uc.role, u.role)) = 'ADMIN'
      ORDER BY u.first_name, u.last_name`,
    [companyId]
  );
  return rows;
}

/**
 * Record a non-administrator's request as an opportunity and tell the
 * administrators. Asking twice for the same thing adds the asker to the one
 * request rather than raising a second.
 */
async function recordRequest({ companyId, userId, requirement, title, channel }) {
  const who = (await personName(userId)) || 'Someone';
  const name = title || requirement.replace(/\s+/g, ' ').slice(0, 80);
  return asCompany(companyId, () => companyContext.withCompany(companyId, async (client) => {
    const asked = { user_id: userId, name: who, at: new Date().toISOString(), channel };
    const { rows: [row] } = await client.query(
      `INSERT INTO capability_opportunities
         (company_id, title, description, reason, evidence, confidence, source_signal, dedupe_key, status, requires_new_data_model)
       VALUES ($1, $2, $3, $4, $5, 1, 'person_request', $6, 'proposed', false)
       ON CONFLICT (company_id, dedupe_key) DO UPDATE
         SET evidence = jsonb_set(capability_opportunities.evidence, '{requested_by}',
               COALESCE(capability_opportunities.evidence->'requested_by', '[]'::jsonb) || $7::jsonb),
             status = CASE WHEN capability_opportunities.status IN ('dismissed', 'expired') THEN 'proposed'
                           ELSE capability_opportunities.status END,
             updated_at = CURRENT_TIMESTAMP
       RETURNING *, (xmax = 0) AS created`,
      [companyId, name, requirement, `Asked for by ${who}${channel === 'simeli' ? ' in Simeli' : ''}.`,
        JSON.stringify({ requested_by: [asked] }), requestKey(requirement), JSON.stringify([asked])]
    );

    const admins = await companyAdmins(client, companyId);
    for (const a of admins) {
      await client.query(
        `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
         VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [`${who} asked for a new capability`.slice(0, 255),
          `"${requirement.slice(0, 300)}" — open it on Capability opportunities and choose Design it to have Sandbox build it.`,
          JSON.stringify({ link: '/capability-opportunities', opportunity_id: row.id }), a.user_id, companyId]
      );
    }

    return {
      status: row.status === 'accepted' ? 'already_designed' : 'requested',
      opportunity_id: row.id,
      title: row.title,
      sent_to: admins.map((a) => a.name),
      state: row.created ? 'New request — nothing is built.' : 'Already requested; you were added to the request.',
      next_step: admins.length
        ? `An administrator (${admins.map((a) => a.name).join(', ')}) designs it from Capability opportunities; Sandbox builds it there and they approve the deployment.`
        : 'This company has no administrator to design it yet. It waits on Capability opportunities.',
      open: '/capability-opportunities',
    };
  }));
}

/**
 * The one entry point, for Simeli and for the opportunities screen alike.
 *
 * @returns for an administrator, the draft design and its rehearsal; for anyone
 *          else, the recorded request and who it went to.
 */
async function buildInSandbox({ companyId, userId, role, requirement, title = null, channel = 'simeli' }) {
  const text = String(requirement || '').trim();
  const { SessionError } = session;
  if (!companyId) throw new SessionError('No company is selected.', 'NO_COMPANY');
  if (!userId) throw new SessionError('Sandbox builds for the person asking, so it needs to know who that is.', 'NO_USER');
  if (text.length < 10) throw new SessionError('Describe what you would like built in a sentence or two.', 'REQUIREMENT_TOO_SHORT');
  if (text.length > 8000) throw new SessionError('That requirement is too long. Summarise it.', 'REQUIREMENT_TOO_LONG');

  if (!isAdmin(role)) return recordRequest({ companyId, userId, requirement: text, title, channel });

  const started = await session.start({ companyId, userId, requirement: text, title });
  const sessionId = started.session.id;
  let report = null;
  try {
    ({ report } = await session.validate({ companyId, sessionId }));
  } catch (err) {
    report = { ok: false, summary: { errors: 1, warnings: 0 }, sections: { application: { diagnostics: [{ level: 'error', message: err.message }] } } };
  }

  // Someone may already have asked for this in the same words: their request is
  // now this design, and they are told who took it up.
  const answered = await asCompany(companyId, () => companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      `UPDATE capability_opportunities
          SET status = 'accepted', application_id = $3, version_id = $4, studio_session_id = $5,
              reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $6, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND dedupe_key = $2 AND status IN ('detected', 'proposed')
        RETURNING evidence`,
      [companyId, requestKey(text), started.application.id, started.version.id, sessionId, userId]
    );
    const askers = rows.flatMap((r) => r.evidence?.requested_by || []).filter((a) => a.user_id && a.user_id !== userId);
    const by = (await personName(userId)) || 'An administrator';
    for (const a of new Map(askers.map((x) => [x.user_id, x])).values()) {
      await client.query(
        `INSERT INTO notifications (id, type, title, message, data, user_id, company_id, created_at)
         VALUES (gen_random_uuid(), 'AI_FINDING', $1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [`Sandbox is building what you asked for`.slice(0, 255),
          `${by} had Sandbox design "${started.application.name}" from your request. It goes live once it is approved in the Studio.`,
          JSON.stringify({ link: '/capability-opportunities' }), a.user_id, companyId]
      );
    }
    return askers.map((a) => a.name);
  }));

  return {
    status: 'designed',
    asked_for_by: answered.length ? [...new Set(answered)] : undefined,
    application: started.application.name,
    app_key: started.application.app_key,
    description: started.spec?.description || null,
    designed_by: started.source === 'analyzer' ? 'the deterministic process analyser (no AI model configured)' : 'the AI model',
    model_error: started.modelError || undefined,
    version: started.version.version,
    ...describeDesign(started.spec, report),
    state: 'Draft in Sandbox — nothing is deployed and no table exists yet.',
    next_step: 'Open it in the Studio, read the plan and approve the deployment. Changes can be asked for there in plain words first.',
    studio_session_id: sessionId,
    open: `/studio/${sessionId}`,
  };
}

module.exports = { buildInSandbox, describeDesign };
