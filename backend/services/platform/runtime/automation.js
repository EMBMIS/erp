/**
 * Automations: EVENT -> CONDITION -> ACTION, from declarative primitives.
 *
 * ===========================================================================
 * WHAT AN AUTOMATION CAN AND CANNOT DO
 * ===========================================================================
 * The action vocabulary in spec/types.js IS the sandbox. There is no
 * `run_code`, no `http_request` to an address the specification chose, no
 * `send_email` to an arbitrary recipient. An automation can notify a role, set
 * a field, create a record, move a state, add a comment, or emit an event on a
 * declared integration — and nothing else, because dispatch here is a lookup in
 * a fixed table with no default branch.
 *
 * That is a deliberate trade. A generated application cannot express "call our
 * warehouse API when a claim is approved" as an automation; it expresses it as
 * an integration, which is a named, reviewed endpoint. The gap is visible. An
 * escape hatch would not be.
 *
 * ===========================================================================
 * LOOP PROTECTION
 * ===========================================================================
 * An automation's action writes a record; that write is an event; that event
 * may trigger an automation. Three things stop that becoming unbounded:
 *
 *   1. The validator reports a cycle in the automation graph as an error.
 *   2. Every run carries a depth. Past MAX_DEPTH the chain stops and the run is
 *      recorded as `suppressed` rather than silently dropped.
 *   3. A run records its root, so an operator can see the whole chain that one
 *      user action set off.
 *
 * (1) is the design; (2) and (3) are what happens when the design is wrong.
 */

const companyContext = require('../../companyContext');
const expressions = require('../spec/expressions');
const { AUTOMATION_ACTIONS } = require('../spec/types');
const resolver = require('./resolver');
const data = require('./data');
const workflowRuntime = require('./workflow');

const MAX_DEPTH = 3;

/**
 * A principal that acts as the application itself.
 *
 * Given every internal role the specification declares, because an automation
 * is the application's own behaviour rather than any person's — and given an
 * explicit `system` kind so anything it writes is attributable to automation
 * and not to whoever happened to trigger it.
 */
function systemPrincipal(context) {
  const roles = (context.spec.security?.roles || []).filter((r) => r.audience === 'internal');
  return {
    kind: 'internal',
    companyId: context.instance.companyId,
    instanceId: context.instance.id,
    userId: null,
    externalIdentityId: null,
    anchor: null,
    roles,
    roleKeys: roles.map((r) => r.key),
    surface: (context.spec.surfaces || []).find((s) => s.audience === 'internal') || null,
    label: 'automation',
    isSystem: true,
  };
}

/**
 * Run every automation that matches an event.
 *
 * Called after a record write. Failures are contained: an automation that
 * throws is recorded as failed and the next one still runs, because one broken
 * notification must not roll back the user's save.
 */
async function dispatch(context, event, { depth = 0, rootRunId = null } = {}) {
  const automations = (context.spec.automations || []).filter((a) => a.enabled !== false && matches(a, event));
  if (!automations.length) return [];

  const results = [];
  for (const automation of automations) {
    if (depth >= MAX_DEPTH) {
      results.push(await recordRun(context, automation, event, {
        status: 'suppressed', depth, rootRunId,
        error: `Automation chain reached the depth limit of ${MAX_DEPTH}. Nothing further was run.`,
      }));
      continue;
    }
    try {
      const shouldRun = evaluateCondition(automation, event.record);
      if (!shouldRun) {
        results.push(await recordRun(context, automation, event, { status: 'skipped', depth, rootRunId }));
        continue;
      }
      const performed = await performActions(context, automation, event, { depth, rootRunId });
      results.push(await recordRun(context, automation, event, {
        status: 'succeeded', depth, rootRunId, actions: performed,
      }));
    } catch (error) {
      results.push(await recordRun(context, automation, event, {
        status: 'failed', depth, rootRunId, error: error.message,
      }));
    }
  }
  return results;
}

function matches(automation, event) {
  const trigger = automation.trigger || {};
  if (trigger.kind !== event.kind) return false;
  if (trigger.entity && trigger.entity !== event.entityKey) return false;
  if (event.kind === 'state_changed') {
    if (trigger.workflow && trigger.workflow !== event.workflow) return false;
    if (trigger.to_state && trigger.to_state !== event.toState) return false;
  }
  return true;
}

function evaluateCondition(automation, record) {
  if (!automation.condition) return true;
  const ast = expressions.parse(automation.condition);
  return !!expressions.evaluate(ast, record || {}, {
    userId: null, userRole: '', surfaceKey: '',
  });
}

async function performActions(context, automation, event, { depth, rootRunId }) {
  const principal = systemPrincipal(context);
  const performed = [];

  for (const action of automation.actions || []) {
    // The dispatch table is a fixed lookup. An action kind that is not in the
    // vocabulary is an error, never a no-op — a silently ignored action is an
    // automation that reports success while doing nothing.
    if (!Object.prototype.hasOwnProperty.call(AUTOMATION_ACTIONS, action.kind)) {
      throw new Error(`Automation "${automation.key}" declares unsupported action "${action.kind}".`);
    }

    switch (action.kind) {
      case 'notify_role':
        await notifyRole(context, action, event, automation);
        performed.push({ kind: action.kind, role: action.role });
        break;

      case 'notify_external':
        await notifyExternal(context, action, event, automation);
        performed.push({ kind: action.kind, surface: action.surface });
        break;

      case 'set_field': {
        if (!event.recordId) break;
        const value = resolveActionValue(action.value, event.record);
        await data.update(context, principal, event.entityKey, event.recordId, { [action.field]: value });
        performed.push({ kind: action.kind, field: action.field });
        break;
      }

      case 'add_comment':
        await addSystemComment(context, event, renderTemplate(action.body, event.record), automation);
        performed.push({ kind: action.kind });
        break;

      case 'transition_state': {
        if (!event.recordId) break;
        const workflow = resolver.workflowDefinition(context.spec, action.workflow);
        const current = event.record?.[workflow.state_field];
        const declared = (workflow.transitions || []).find((t) => t.from === current && t.to === action.to_state);
        if (!declared) {
          throw new Error(`Automation "${automation.key}" cannot move a record from "${current}" to "${action.to_state}": no such transition.`);
        }
        await workflowRuntime.transition(context, principal, event.entityKey, event.recordId, declared.key, {
          reason: `Automation: ${automation.label || automation.key}`,
        });
        performed.push({ kind: action.kind, to: action.to_state });
        break;
      }

      case 'create_record': {
        const values = {};
        Object.entries(action.values || {}).forEach(([k, v]) => { values[k] = resolveActionValue(v, event.record); });
        const created = await data.create(context, principal, action.entity, values);
        performed.push({ kind: action.kind, entity: action.entity, id: created.id });
        // The new record is itself an event. Depth is what keeps this finite.
        await dispatch(context, {
          kind: 'record_created', entityKey: action.entity, recordId: created.id, record: created,
        }, { depth: depth + 1, rootRunId: rootRunId || event.runId || null });
        break;
      }

      case 'emit_integration_event': {
        const integration = (context.spec.integrations || []).find((i) => i.key === action.integration);
        if (!integration) throw new Error(`Automation "${automation.key}" emits on undeclared integration "${action.integration}".`);
        await recordIntegrationEvent(context, integration, event, automation);
        performed.push({ kind: action.kind, integration: integration.key });
        break;
      }

      default:
        throw new Error(`Automation action "${action.kind}" is declared but not implemented.`);
    }
  }
  return performed;
}

/**
 * An action value is a literal or a `{{field}}` reference to the triggering
 * record. Deliberately not the expression language: an action that computed
 * arbitrary values would need its own type checking against the TARGET
 * entity's schema, and a template that can only copy a field cannot go wrong
 * in an interesting way.
 */
function resolveActionValue(value, record) {
  if (typeof value !== 'string') return value;
  const match = /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/.exec(value);
  if (match) return record ? record[match[1]] ?? null : null;
  return renderTemplate(value, record);
}

function renderTemplate(template, record) {
  return String(template || '').replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, name) => {
    const v = record ? record[name] : null;
    return v === null || v === undefined ? '' : String(v);
  });
}

async function notifyRole(context, action, event, automation) {
  const subject = renderTemplate(action.subject, event.record) || automation.label;
  const body = renderTemplate(action.body, event.record);
  return companyContext.withCompany(context.instance.companyId, async (client) => {
    await client.query(
      `INSERT INTO app_notifications
         (company_id, app_instance_id, recipient_kind, recipient_role, subject, body, entity_key, record_id)
       VALUES ($1, $2, 'role', $3, $4, $5, $6, $7)`,
      [context.instance.companyId, context.instance.id, action.role, subject, body,
        event.entityKey || null, event.recordId || null]
    );
  });
}

/**
 * Notify the external identities who can see this record.
 *
 * Recipients are DERIVED from the record's anchor, not named by the automation.
 * An automation that could choose recipients could notify a supplier about
 * another supplier's finding — and the notification body would carry the
 * details with it.
 */
async function notifyExternal(context, action, event, automation) {
  const entity = event.entityKey ? resolver.entityDefinition(context.spec, event.entityKey) : null;
  if (!entity?.anchor?.field || !event.record) return;
  const anchorId = event.record[entity.anchor.field];
  if (!anchorId) return;

  const subject = renderTemplate(action.subject, event.record) || automation.label;
  const body = renderTemplate(action.body, event.record);

  return companyContext.withCompany(context.instance.companyId, async (client) => {
    await client.query(
      `INSERT INTO app_notifications
         (company_id, app_instance_id, recipient_kind, recipient_external_id, subject, body, entity_key, record_id)
       SELECT $1, $2, 'external', m.external_identity_id, $3, $4, $5, $6
         FROM app_portal_memberships m
         JOIN app_external_identities i ON i.id = m.external_identity_id
        WHERE m.app_instance_id = $2
          AND m.surface_key = $7
          AND m.status = 'active'
          AND i.status = 'active'
          AND i.subject_id = $8`,
      [context.instance.companyId, context.instance.id, subject, body,
        event.entityKey, event.recordId, action.surface, anchorId]
    );
  });
}

async function addSystemComment(context, event, body, automation) {
  if (!event.recordId || !body) return;
  return companyContext.withCompany(context.instance.companyId, async (client) => {
    await client.query(
      `INSERT INTO app_record_comments
         (company_id, app_instance_id, entity_key, record_id, body, visibility, author_kind, author_label)
       VALUES ($1, $2, $3, $4, $5, 'internal', 'system', $6)`,
      [context.instance.companyId, context.instance.id, event.entityKey, event.recordId, body,
        automation.label || automation.key]
    );
  });
}

async function recordIntegrationEvent(context, integration, event, automation) {
  const registry = require('../registry');
  return registry.recordEvent({
    companyId: context.instance.companyId,
    applicationId: context.instance.applicationId,
    instanceId: context.instance.id,
    eventType: 'integration.emitted',
    provenanceClass: 'execution',
    actorKind: 'system',
    summary: `Automation "${automation.key}" emitted on integration "${integration.key}".`,
    detail: { integration: integration.key, kind: integration.kind, entity: event.entityKey, recordId: event.recordId },
  });
}

async function recordRun(context, automation, event, { status, depth, rootRunId, actions = [], error = null }) {
  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO app_automation_runs
         (company_id, app_instance_id, automation_key, trigger_kind, trigger_payload,
          status, actions, depth, root_run_id, error, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
       RETURNING id, status`,
      [context.instance.companyId, context.instance.id, automation.key, event.kind,
        JSON.stringify({ entity: event.entityKey, recordId: event.recordId, toState: event.toState || null }),
        status, JSON.stringify(actions), depth, rootRunId, error]
    );
    return { automation: automation.key, ...rows[0] };
  });
}

/**
 * Scheduled automations: scan the entity, run the condition per record, act.
 *
 * Called by whatever scheduler the deployment runs. `cadence` is checked by the
 * caller; this function does the work for one cadence across one instance.
 */
async function runSchedule(context, cadence) {
  const automations = (context.spec.automations || [])
    .filter((a) => a.enabled !== false && a.trigger?.kind === 'schedule' && a.trigger.cadence === cadence);
  if (!automations.length) return [];

  const principal = systemPrincipal(context);
  const results = [];

  for (const automation of automations) {
    try {
      // The condition doubles as the selection filter: rather than reading
      // every record and testing each, it is compiled into the WHERE clause, so
      // a daily sweep over a large entity is one indexed query.
      const page = await data.list(context, principal, automation.trigger.entity, {
        expression: automation.condition || '',
        pageSize: 200,
      });
      for (const record of page.rows) {
        const performed = await performActions(context, automation, {
          kind: 'schedule',
          entityKey: automation.trigger.entity,
          recordId: record.id,
          record,
        }, { depth: 0, rootRunId: null });
        results.push(await recordRun(context, automation, {
          kind: 'schedule', entityKey: automation.trigger.entity, recordId: record.id,
        }, { status: 'succeeded', depth: 0, rootRunId: null, actions: performed }));
      }
      if (!page.rows.length) {
        results.push(await recordRun(context, automation, { kind: 'schedule', entityKey: automation.trigger.entity },
          { status: 'skipped', depth: 0, rootRunId: null }));
      }
    } catch (error) {
      results.push(await recordRun(context, automation, { kind: 'schedule', entityKey: automation.trigger?.entity },
        { status: 'failed', depth: 0, rootRunId: null, error: error.message }));
    }
  }
  return results;
}

module.exports = { dispatch, runSchedule, systemPrincipal, MAX_DEPTH, renderTemplate, resolveActionValue };
