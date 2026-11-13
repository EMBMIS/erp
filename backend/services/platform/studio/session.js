/**
 * A Studio session: the conversation that turns a sentence into a deployed
 * application, and then keeps changing it.
 *
 * ===========================================================================
 * THE SHAPE OF THE LOOP
 * ===========================================================================
 *     start      requirement -> plan -> version 1 (draft)
 *     iterate    instruction -> patch -> version N+1 (draft)
 *     validate   sandbox report on the current draft
 *     preview    synthetic data rendered through the real runtime shapes
 *     deploy     plan -> approve -> apply -> live
 *
 * Every step appends a message, and every message that changed the design
 * points at the version it produced. That is what makes "why does the
 * application look like this?" answerable six months later by reading the
 * session rather than by guessing.
 *
 * Nothing here deploys implicitly. `start` writes an application row and a
 * DRAFT version — no tables, no instance, nothing a user can open — because a
 * design is not a deployment and the gap between them is where the approval
 * lives.
 */

const { asCompany } = require('../db');
const companyContext = require('../../companyContext');
const registry = require('../registry');
const deployer = require('../deployer');
const generator = require('./generator');
const iterator = require('./iterate');
const sandbox = require('../sandbox');
const progress = require('./progress');
const validator = require('../spec/validator');

class SessionError extends Error {
  constructor(message, code = 'SESSION_ERROR', status = 400, detail = null) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Provenance for a version.
 *
 * Enough to reproduce the decision: what was asked, what the platform knew when
 * it answered, which path produced the answer, and the vocabulary versions the
 * answer was checked against. Not the model's weights, obviously — but enough
 * that a year from now someone can tell whether a design was a model's judgement
 * or the fallback rules, and what data it was looking at.
 */
function buildProvenance({ requirement, source, context, extra = {} }) {
  const { getAIProvider, resolveDefaultModel, isAIEnabled } = require('../../../config/aiConfig');
  return {
    requirement,
    designedBy: source,
    model: isAIEnabled() ? { provider: getAIProvider(), model: resolveDefaultModel() } : null,
    observedAt: new Date().toISOString(),
    canonicalSnapshot: (context?.canonical || []).map((c) => ({ key: c.key, count: c.count })),
    installedApplications: (context?.applications || []).map((a) => a.appKey),
    vocabularyVersion: 1,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
async function start({ companyId, userId, requirement, title = null, onProgress = null }) {
  const emit = progress.reporter(onProgress);
  const text = String(requirement || '').trim();
  if (text.length < 10) {
    throw new SessionError('Describe what you would like built in a sentence or two.', 'REQUIREMENT_TOO_SHORT');
  }
  if (text.length > 8000) {
    throw new SessionError('That requirement is too long. Summarise it.', 'REQUIREMENT_TOO_LONG');
  }

  const designed = await generator.design({ companyId, requirement: text, onProgress });

  // The application key is global, so a second company asking for the same
  // thing gets its own key rather than a collision.
  emit('naming');
  const appKey = await registry.availableApplicationKey(designed.spec.key, companyId);
  designed.spec.key = appKey;
  const revalidated = validator.validate(designed.spec);
  designed.spec = revalidated.spec;
  designed.validation = revalidated.report.toJSON();
  emit.done('naming', appKey);

  emit('saving');
  const application = await registry.createApplication({
    appKey,
    name: designed.spec.name,
    description: designed.spec.description,
    icon: designed.spec.icon,
    category: designed.spec.category,
    kind: 'generated',
    originCompanyId: companyId,
    createdBy: userId,
  });

  const version = await registry.createVersion({
    applicationId: application.id,
    spec: designed.spec,
    changeSummary: `Designed from: "${text.slice(0, 200)}"`,
    authoredBy: designed.source === 'analyzer' ? 'system' : 'ai',
    provenance: buildProvenance({ requirement: text, source: designed.source, context: designed.context }),
    createdBy: userId,
    validation: designed.validation,
    status: designed.validation.ok ? 'validated' : 'draft',
  });

  const session = await companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO app_studio_sessions (company_id, application_id, title, requirement, status, plan, created_by)
       VALUES ($1, $2, $3, $4, 'preview', $5, $6) RETURNING *`,
      [companyId, application.id, title || designed.spec.name, text, JSON.stringify(designed.plan), userId]
    );
    return rows[0];
  });

  await addMessage(companyId, session.id, { role: 'user', kind: 'message', content: text });
  await addMessage(companyId, session.id, {
    role: 'assistant', kind: 'plan',
    content: describePlan(designed.plan),
    payload: designed.plan,
    versionId: version.id,
  });

  await registry.recordEvent({
    companyId, applicationId: application.id, versionId: version.id,
    eventType: 'application.designed',
    provenanceClass: 'decision',
    actorKind: userId ? 'user' : 'system', actorId: userId,
    summary: `Designed "${designed.spec.name}" from a natural-language requirement (${designed.source}).`,
    detail: { requirement: text.slice(0, 500), source: designed.source, entities: designed.spec.data.entities.length },
  });
  emit.done('saving', `Draft v${version.version} — nothing deployed yet.`);
  emit('ready');
  emit.done('ready', designed.spec.name);

  return {
    session, application, version,
    plan: designed.plan, spec: designed.spec, validation: designed.validation,
    source: designed.source, modelError: designed.modelError || null,
  };
}

async function iterate({ companyId, sessionId, userId, instruction, onProgress = null }) {
  const emit = progress.reporter(onProgress);
  const session = await getSession(companyId, sessionId);
  if (!session.application_id) throw new SessionError('This session has no application yet.', 'NO_APPLICATION');

  const current = await registry.latestVersion(session.application_id);
  if (!current) throw new SessionError('This application has no version to change.', 'NO_VERSION');

  await addMessage(companyId, sessionId, { role: 'user', kind: 'message', content: instruction });

  let result;
  try {
    result = await iterator.iterate({ spec: current.spec, instruction, onProgress });
  } catch (error) {
    await addMessage(companyId, sessionId, {
      role: 'assistant', kind: 'error',
      content: error.message,
      payload: { code: error.code || 'ITERATION_FAILED' },
    });
    throw error;
  }

  if (result.noChange) {
    await addMessage(companyId, sessionId, { role: 'assistant', kind: 'message', content: result.note });
    return { session, version: current, spec: current.spec, noChange: true, note: result.note, diff: [] };
  }

  emit('saving');
  const version = await registry.createVersion({
    applicationId: session.application_id,
    spec: result.spec,
    parentVersionId: current.id,
    changeSummary: result.applied.map((a) => a.summary).join(' '),
    authoredBy: result.source === 'rules' ? 'system' : 'ai',
    provenance: buildProvenance({
      requirement: instruction, source: result.source, context: null,
      extra: { parentVersion: current.version, operations: result.operations },
    }),
    createdBy: userId,
    validation: result.report.toJSON(),
    status: 'validated',
  });

  await companyContext.withCompany(companyId, async (client) => {
    await client.query(
      "UPDATE app_studio_sessions SET status = 'iterating', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [sessionId]
    );
  });

  await addMessage(companyId, sessionId, {
    role: 'assistant', kind: 'build',
    content: result.applied.map((a) => a.summary).join('\n'),
    payload: { operations: result.operations, diff: result.diff, source: result.source, version: version.version },
    versionId: version.id,
  });
  emit.done('saving', `Draft v${version.version}.`);

  await registry.recordEvent({
    companyId, applicationId: session.application_id, versionId: version.id,
    eventType: 'application.modified',
    provenanceClass: 'decision',
    actorKind: userId ? 'user' : 'system', actorId: userId,
    summary: `Version ${version.version}: ${result.applied.map((a) => a.summary).join(' ')}`,
    detail: { instruction: String(instruction).slice(0, 500), operations: result.operations, source: result.source },
  });

  return {
    session, version, spec: result.spec, diff: result.diff,
    applied: result.applied, operations: result.operations, source: result.source,
  };
}

/** Run the sandbox against the session's current draft. */
async function validate({ companyId, sessionId }) {
  const session = await getSession(companyId, sessionId);
  const version = await registry.latestVersion(session.application_id);
  if (!version) throw new SessionError('This application has no version to validate.', 'NO_VERSION');

  const report = await sandbox.run({
    spec: version.spec, companyId, applicationId: session.application_id,
  });

  await registry.markVersionValidated(version.id, {
    ok: report.ok, errorCount: report.summary.errors, warningCount: report.summary.warnings,
    diagnostics: Object.values(report.sections).flatMap((s) => s.diagnostics),
  });

  await addMessage(companyId, sessionId, {
    role: 'assistant', kind: 'validation',
    content: report.ok
      ? `Validated: ${report.summary.entities} entities, ${report.summary.pages} pages, ${report.summary.surfaces} surface(s). ${report.summary.warnings} warning(s).`
      : `${report.summary.errors} problem(s) must be fixed before this can be deployed.`,
    payload: { summary: report.summary, sections: report.sections },
    versionId: version.id,
  });

  return { version, report };
}

async function preview({ companyId, sessionId }) {
  const session = await getSession(companyId, sessionId);
  const version = await registry.latestVersion(session.application_id);
  if (!version) throw new SessionError('This application has no version to preview.', 'NO_VERSION');
  const report = await sandbox.run({ spec: version.spec, companyId, applicationId: session.application_id });
  return { version, spec: version.spec, preview: report.preview, ok: report.ok, summary: report.summary };
}

/**
 * Deploy the session's current version for this company.
 *
 * Everything real happens in deployer.js; this is the Studio's side of it —
 * recording the outcome on the session so the conversation shows what happened.
 */
async function deploy({ companyId, sessionId, userId, acknowledge = null }) {
  const session = await getSession(companyId, sessionId);
  const version = await registry.latestVersion(session.application_id);
  if (!version) throw new SessionError('This application has no version to deploy.', 'NO_VERSION');

  await companyContext.withCompany(companyId, async (client) => {
    await client.query("UPDATE app_studio_sessions SET status = 'deploying', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [sessionId]);
  });

  try {
    const result = await deployer.deploy({
      companyId, applicationId: session.application_id, versionId: version.id,
      actorId: userId, acknowledge,
    });

    await companyContext.withCompany(companyId, async (client) => {
      await client.query(
        'UPDATE app_studio_sessions SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [sessionId, result.status === 'deployed' ? 'deployed' : 'preview']
      );
    });

    await addMessage(companyId, sessionId, {
      role: 'assistant', kind: 'deployment',
      content: result.status === 'deployed'
        ? `Deployed version ${version.version}. The application is live for this company.`
        : `This change needs approval before it can be applied: ${result.plan.summary.destructive.concat(result.plan.summary.review).join(' ')}`,
      payload: { status: result.status, plan: result.plan, deploymentId: result.deployment.id },
      versionId: version.id,
    });

    return { ...result, version };
  } catch (error) {
    await companyContext.withCompany(companyId, async (client) => {
      await client.query("UPDATE app_studio_sessions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [sessionId]);
    });
    await addMessage(companyId, sessionId, {
      role: 'assistant', kind: 'error',
      content: `Deployment failed and was rolled back: ${error.message}`,
      payload: { code: error.code || 'DEPLOY_FAILED', detail: error.detail || null },
      versionId: version.id,
    });
    throw error;
  }
}

/** Roll a session's application back to an earlier version, as a new deployment. */
async function rollback({ companyId, sessionId, userId, versionId, acknowledge = null }) {
  const session = await getSession(companyId, sessionId);
  const target = await registry.getVersion(versionId);
  if (!target || target.application_id !== session.application_id) {
    throw new SessionError('That version does not belong to this application.', 'VERSION_MISMATCH');
  }
  // A rollback is a deployment of an older specification, planned and approved
  // like any other — not a special path. Going back can drop a column that a
  // later version added, and that is exactly as destructive as it sounds, so it
  // goes through the same gate.
  const result = await deployer.deploy({
    companyId, applicationId: session.application_id, versionId, actorId: userId, acknowledge,
  });
  await addMessage(companyId, sessionId, {
    role: 'assistant', kind: 'deployment',
    content: result.status === 'deployed'
      ? `Rolled back to version ${target.version}.`
      : `Rolling back to version ${target.version} needs approval: it would ${result.plan.summary.destructive.join(' ')}`,
    payload: { status: result.status, plan: result.plan, rollbackTo: target.version },
    versionId,
  });
  return result;
}

// ---------------------------------------------------------------------------
async function getSession(companyId, sessionId) {
  const { rows } = await companyContext.withCompany(companyId, async (client) => client.query(
    'SELECT * FROM app_studio_sessions WHERE id = $1 AND company_id = $2',
    [sessionId, companyId]
  ));
  if (!rows.length) throw new SessionError('No such Studio session.', 'SESSION_NOT_FOUND', 404);
  return rows[0];
}

async function listSessions(companyId, limit = 50) {
  return companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT s.*, a.app_key, a.name AS application_name,
              (SELECT max(version) FROM application_versions v WHERE v.application_id = s.application_id) AS latest_version,
              (SELECT status FROM app_company_instances i WHERE i.application_id = s.application_id AND i.company_id = s.company_id) AS instance_status
         FROM app_studio_sessions s
         LEFT JOIN applications a ON a.id = s.application_id
        WHERE s.company_id = $1
        ORDER BY s.updated_at DESC LIMIT $2`,
      [companyId, Math.min(Math.max(1, limit), 200)]
    );
    return rows;
  });
}

async function messages(companyId, sessionId) {
  await getSession(companyId, sessionId);
  return companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT m.id, m.role, m.kind, m.content, m.payload, m.version_id, m.created_at, v.version
         FROM app_studio_messages m
         LEFT JOIN application_versions v ON v.id = m.version_id
        WHERE m.session_id = $1 ORDER BY m.created_at ASC`,
      [sessionId]
    );
    return rows;
  });
}

async function addMessage(companyId, sessionId, { role, kind = 'message', content = '', payload = {}, versionId = null }) {
  return companyContext.withCompany(companyId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO app_studio_messages (company_id, session_id, role, kind, content, payload, version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [companyId, sessionId, role, kind, String(content).slice(0, 20000), JSON.stringify(payload), versionId]
    );
    return rows[0];
  });
}

/** The plan as the sentences the Studio shows while it works. */
function describePlan(plan) {
  const lines = [];
  lines.push(`${plan.application.name}`);
  lines.push('');
  if (plan.existingData.length) {
    lines.push('Existing EMBMIS data this will use:');
    plan.existingData.forEach((d) => lines.push(`  ✓ ${d.label}${d.count !== null ? ` (${d.count} record${d.count === 1 ? '' : 's'})` : ''}`));
  } else {
    lines.push('No existing EMBMIS data is needed for this.');
  }
  lines.push('');
  lines.push('New application data:');
  plan.newData.forEach((d) => lines.push(`  + ${d.label} — ${d.fields} field${d.fields === 1 ? '' : 's'}${d.anchored ? ', visible to the party it belongs to' : ''}`));
  lines.push('');
  lines.push('Surfaces:');
  plan.surfaces.forEach((s) => lines.push(`  ✓ ${s.label} (${s.audience}) — ${s.pages} screen${s.pages === 1 ? '' : 's'}`));
  if (plan.workflows.length) {
    lines.push('');
    lines.push('Workflow:');
    plan.workflows.forEach((w) => lines.push(`  ${w.path.join(' → ')}`));
  }
  if (plan.automations.length) {
    lines.push('');
    lines.push('Automation:');
    plan.automations.forEach((a) => lines.push(`  · ${a}`));
  }
  return lines.join('\n');
}

/**
 * Every entry point runs with the company as the ambient context — see
 * db.asCompany(). Without it, a Studio call from anywhere but an HTTP request
 * (a test, a scheduled job, Simeli acting on a company's behalf) would be
 * refused by row-level security on its first write.
 */
const scoped = (fn) => (args = {}) => asCompany(args.companyId, () => fn(args));

module.exports = {
  SessionError,
  start: scoped(start),
  iterate: scoped(iterate),
  validate: scoped(validate),
  preview: scoped(preview),
  deploy: scoped(deploy),
  rollback: scoped(rollback),
  getSession: (companyId, sessionId) => asCompany(companyId, () => getSession(companyId, sessionId)),
  listSessions: (companyId, limit) => asCompany(companyId, () => listSessions(companyId, limit)),
  messages: (companyId, sessionId) => asCompany(companyId, () => messages(companyId, sessionId)),
  addMessage, describePlan, buildProvenance,
};
