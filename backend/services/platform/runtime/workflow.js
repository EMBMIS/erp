/**
 * Workflow execution: moving a record from one state to the next, and refusing
 * to when the specification says no.
 *
 * ===========================================================================
 * WHY STATE IS NOT AN EDITABLE FIELD
 * ===========================================================================
 * The state column is an ordinary enum column, and data.js explicitly refuses
 * to let anyone PATCH it. That is the whole design: if a status could be set
 * by an update, every condition, role check, approval and evidence requirement
 * on the transition would be advisory — a suggestion the UI makes and an API
 * client ignores.
 *
 * So the only way a record's state changes is through this file, which:
 *
 *   1. reads the record through the principal's own visibility, so you cannot
 *      transition a record you cannot see;
 *   2. finds the declared transition FROM the record's actual current state,
 *      so a stale client cannot skip a step by naming a later transition;
 *   3. checks every requirement the transition declares;
 *   4. writes the new state and an immutable transition record in ONE
 *      transaction, so a state change without its history entry is not a
 *      reachable outcome.
 *
 * Requirements, and what each means at runtime:
 *
 *   role       the actor holds that application role.
 *   approval   the actor holds approval authority for this transition, which
 *              is granted separately from the role that performs the work —
 *              this is the segregation-of-duties primitive.
 *   condition  the transition's own boolean expression over the record.
 *   evidence   at least one attachment on the record. "Show me, do not tell
 *              me" as a state machine edge.
 *   comment    a reason was supplied. Cheap, and the difference between an
 *              audit trail and a list of timestamps.
 *   authority  the actor is not the person who created the record. The
 *              four-eyes rule.
 */

const companyContext = require('../../companyContext');
const { quoteIdent } = require('../identifiers');
const expressions = require('../spec/expressions');
const resolver = require('./resolver');
const authz = require('./authorization');
const data = require('./data');

class WorkflowError extends Error {
  constructor(message, code = 'WORKFLOW_ERROR', status = 409, detail = null) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * The transitions this principal could take on this record right now.
 *
 * Used by the runtime to render action buttons, and — importantly — recomputed
 * server-side on execute. The UI showing a button is not what makes it allowed.
 */
function availableTransitions(spec, workflow, record, principal) {
  const current = record[workflow.state_field];
  return (workflow.transitions || [])
    .filter((t) => t.from === current)
    .map((t) => {
      const blocked = describeBlockers(workflow, t, record, principal);
      return {
        key: t.key,
        label: t.label,
        from: t.from,
        to: t.to,
        allowed: blocked.length === 0,
        blockedBy: blocked,
        requires: (t.requires || []).map((r) => r.type),
      };
    });
}

function describeBlockers(workflow, transition, record, principal) {
  const blockers = [];
  (transition.requires || []).forEach((requirement) => {
    switch (requirement.type) {
      case 'role':
        if (!principal.roleKeys.includes(requirement.role)) {
          blockers.push(`needs the "${requirement.role}" role`);
        }
        break;
      case 'approval':
        if (!authz.hasApprovalAuthority(principal, workflow.key, transition.key)
          && !principal.roleKeys.includes(requirement.role)) {
          blockers.push(`needs approval from "${requirement.role}"`);
        }
        break;
      case 'authority':
        if (principal.kind === 'internal' && record.created_by_user_id === principal.userId) {
          blockers.push('cannot be done by the person who raised it');
        }
        if (principal.kind === 'external' && record.created_by_external_id === principal.externalIdentityId) {
          blockers.push('cannot be done by the person who raised it');
        }
        break;
      default:
        break;
    }
  });

  if (transition.condition) {
    try {
      // Evaluated against the record in memory, not re-queried: the condition
      // is about the record the actor is looking at, and it was read through
      // their own visibility a moment ago.
      const ast = expressions.parse(transition.condition);
      const satisfied = expressions.evaluate(ast, record, {
        userId: principal.userId,
        userRole: principal.roleKeys[0] || '',
        surfaceKey: principal.surface?.key || '',
      });
      if (!satisfied) blockers.push(`the record does not meet the condition for "${transition.label}"`);
    } catch (error) {
      // A condition that cannot be evaluated blocks the transition. Treating
      // an unevaluable rule as satisfied would make a broken specification
      // permissive, which is the wrong direction to fail in.
      blockers.push(`this transition's condition could not be evaluated (${error.message})`);
    }
  }
  return blockers;
}

/**
 * Execute a transition.
 *
 * @param {object} options
 * @param {string} options.reason    Free text; required when the transition
 *                                   declares a `comment` requirement.
 */
async function transition(context, principal, entityKey, recordId, transitionKey, options = {}) {
  const entity = resolver.entityDefinition(context.spec, entityKey);
  const workflow = resolver.workflowForEntity(context.spec, entityKey);
  if (!workflow) {
    throw new WorkflowError(`"${entityKey}" has no workflow, so it has no transitions.`, 'NO_WORKFLOW', 400);
  }
  authz.assertCan(principal, entityKey, 'update');

  // Read through the principal's own visibility. A record they cannot see is a
  // record they cannot move.
  const record = await data.get(context, principal, entityKey, recordId);
  const current = record[workflow.state_field];

  const declared = (workflow.transitions || []).find((t) => t.key === transitionKey);
  if (!declared) {
    throw new WorkflowError(`Workflow "${workflow.key}" has no transition "${transitionKey}".`, 'TRANSITION_UNKNOWN', 404);
  }
  if (declared.from !== current) {
    throw new WorkflowError(
      `"${declared.label}" moves a record from "${declared.from}", but this one is "${current}". Someone may have changed it since you loaded the page.`,
      'STATE_MISMATCH'
    );
  }

  const blockers = describeBlockers(workflow, declared, record, principal);

  // Evidence and comment are checked here rather than in describeBlockers
  // because both depend on things outside the record row itself.
  for (const requirement of declared.requires || []) {
    if (requirement.type === 'comment' && !String(options.reason || '').trim()) {
      blockers.push('needs a reason');
    }
    if (requirement.type === 'evidence') {
      const hasEvidence = await recordHasAttachment(context, entityKey, recordId);
      if (!hasEvidence) blockers.push('needs at least one document attached to the record');
    }
  }

  if (blockers.length) {
    throw new WorkflowError(
      `"${declared.label}" is not available: ${blockers.join('; ')}.`,
      'TRANSITION_BLOCKED', 403, { blockers }
    );
  }

  const table = await resolver.entityTable(context, entityKey);
  const where = data.buildWhere({ principal, entity, entityKey, instanceId: context.instance.id });

  const result = await companyContext.withCompany(context.instance.companyId, async (client) => {
    const params = [...where.params, declared.to, current, recordId];
    const stateHole = `$${where.params.length + 1}`;
    const expectedHole = `$${where.params.length + 2}`;
    const idHole = `$${where.params.length + 3}`;

    // The `= expected` in the WHERE is the concurrency guard: two approvers
    // clicking at once both pass the checks above, and exactly one of them
    // updates a row. The other gets zero rows and a clear message, rather than
    // both transitions "succeeding" and the second overwriting the first.
    const { rows } = await client.query(
      `UPDATE ${table.qualified} t
          SET ${quoteIdent(workflow.state_field)} = ${stateHole},
              ${quoteIdent('updated_at')} = CURRENT_TIMESTAMP
        WHERE ${where.sql}
          AND t.${quoteIdent('id')} = ${idHole}::uuid
          AND t.${quoteIdent(workflow.state_field)} = ${expectedHole}
     RETURNING t.${quoteIdent('id')}`,
      params
    );
    if (!rows.length) {
      throw new WorkflowError(
        'This record changed while you were looking at it. Reload and try again.',
        'CONCURRENT_TRANSITION'
      );
    }

    await client.query(
      `INSERT INTO app_workflow_transitions
         (company_id, app_instance_id, entity_key, record_id, workflow_key,
          from_state, to_state, transition_key, actor_kind, actor_id, surface_key, reason, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        context.instance.companyId, context.instance.id, entityKey, recordId, workflow.key,
        current, declared.to, declared.key,
        principal.kind === 'external' ? 'external' : 'user',
        String(principal.userId || principal.externalIdentityId || ''),
        principal.surface?.key || null,
        options.reason || null,
        JSON.stringify({ roles: principal.roleKeys }),
      ]
    );
    return { id: recordId, from: current, to: declared.to };
  });

  return {
    ...result,
    workflow: workflow.key,
    transition: declared.key,
    record: await data.get(context, principal, entityKey, recordId),
  };
}

async function recordHasAttachment(context, entityKey, recordId) {
  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM app_record_attachments
        WHERE app_instance_id = $1 AND entity_key = $2 AND record_id = $3 LIMIT 1`,
      [context.instance.id, entityKey, recordId]
    );
    return rows.length > 0;
  });
}

/** The transition history of one record, newest first. */
async function history(context, principal, entityKey, recordId) {
  // Reading the record first is the authorization check: history is as visible
  // as the record it is about, and no more.
  await data.get(context, principal, entityKey, recordId);
  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT wt.id, wt.workflow_key, wt.from_state, wt.to_state, wt.transition_key,
              wt.actor_kind, wt.reason, wt.created_at,
              u.first_name, u.last_name, e.display_name AS external_name
         FROM app_workflow_transitions wt
         LEFT JOIN users u ON wt.actor_kind = 'user' AND u.id::text = wt.actor_id
         LEFT JOIN app_external_identities e ON wt.actor_kind = 'external' AND e.id::text = wt.actor_id
        WHERE wt.app_instance_id = $1 AND wt.entity_key = $2 AND wt.record_id = $3
        ORDER BY wt.created_at DESC`,
      [context.instance.id, entityKey, recordId]
    );
    return rows.map((r) => ({
      id: r.id,
      workflow: r.workflow_key,
      from: r.from_state,
      to: r.to_state,
      transition: r.transition_key,
      reason: r.reason,
      at: r.created_at,
      actor: r.actor_kind === 'external'
        ? { kind: 'external', name: r.external_name || 'Portal user' }
        : { kind: r.actor_kind, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'System' },
    }));
  });
}

/**
 * SLA breaches: records that have sat in a state longer than the workflow
 * allows.
 *
 * Computed from the transition history rather than from a timestamp column on
 * the record, so it stays correct when a record goes back and forth between
 * states.
 */
async function slaBreaches(context, principal, workflowKey) {
  const workflow = resolver.workflowDefinition(context.spec, workflowKey);
  if (!workflow.slas?.length) return [];
  const entity = resolver.entityDefinition(context.spec, workflow.entity);
  authz.assertCan(principal, workflow.entity, 'read');
  const table = await resolver.entityTable(context, workflow.entity);
  const where = data.buildWhere({
    principal, entity, entityKey: workflow.entity, instanceId: context.instance.id,
  });

  const breaches = [];
  for (const sla of workflow.slas) {
    const params = [...where.params, sla.state, sla.hours];
    const stateHole = `$${where.params.length + 1}`;
    const hoursHole = `$${where.params.length + 2}`;
    const rows = await companyContext.withCompany(context.instance.companyId, async (client) => {
      const result = await client.query(
        `SELECT t.${quoteIdent('id')} AS id,
                COALESCE(MAX(wt.created_at), t.${quoteIdent('created_at')}) AS entered_at,
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(MAX(wt.created_at), t.${quoteIdent('created_at')}))) / 3600 AS hours_in_state
           FROM ${table.qualified} t
           LEFT JOIN app_workflow_transitions wt
             ON wt.app_instance_id = t.${quoteIdent('app_instance_id')}
            AND wt.entity_key = ${quoteLiteralSafe(workflow.entity)}
            AND wt.record_id = t.${quoteIdent('id')}
            AND wt.to_state = ${stateHole}
          WHERE ${where.sql} AND t.${quoteIdent(workflow.state_field)} = ${stateHole}
          GROUP BY t.${quoteIdent('id')}, t.${quoteIdent('created_at')}
         HAVING EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(MAX(wt.created_at), t.${quoteIdent('created_at')}))) / 3600 > ${hoursHole}`,
        params
      );
      return result.rows;
    });
    rows.forEach((r) => breaches.push({
      workflow: workflowKey,
      entity: workflow.entity,
      state: sla.state,
      recordId: r.id,
      enteredAt: r.entered_at,
      hoursInState: Math.round(Number(r.hours_in_state)),
      limitHours: sla.hours,
      escalateToRole: sla.escalate_to_role || null,
      label: sla.label || `${sla.state} longer than ${sla.hours}h`,
    }));
  }
  return breaches;
}

// The entity key comes from the specification and has already passed the
// identifier rules, but it still reaches SQL as a literal rather than as an
// identifier, so it is quoted as one.
function quoteLiteralSafe(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = { WorkflowError, availableTransitions, transition, history, slaBreaches };
