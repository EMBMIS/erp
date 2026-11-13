/**
 * Unified Authority Engine for Simeli ERP.
 *
 * Single interface for determining whether an actor (user or autonomous agent)
 * has authority to execute a commitment action at a given monetary value or governance level.
 *
 * Folds procurement (approvalRulesEngine) and sales (DelegationOfAuthority) threshold models
 * into Migration 099's generic amount-banded template engine (`approval_chain_templates` / `approval_chain_steps`).
 *
 * Enforces Segregation of Duties (SoD) and Four-Eyes Governance (C6).
 */

const { pool } = require('../config/database');
const { checkSoD } = require('../middleware/rbac');
const { isPlatformOwnerId } = require('./platformOwner');
const ApprovalRulesEngine = require('./approvalRulesEngine');

class AuthorityEngine {
  /**
   * Evaluates authority for an actor performing an action on a resource.
   *
   * @param {object} actor - { id, role, type: 'USER'|'AGENT' }
   * @param {string} action - Action name (e.g., 'POST_JOURNAL', 'CONFIRM_SALES_ORDER', 'GOVERNANCE_CHANGE')
   * @param {object} resource - Resource object (e.g., { type: 'JOURNAL_ENTRY', id: '...', amount: 5000, created_by: '...' })
   * @param {object} [context] - Additional context (e.g., { second_approver_id, company_id })
   * @returns {Promise<{ allow: boolean, reason?: string, needsApproval?: boolean, chain?: Array }>}
   */
  static async can(actor, action, resource = {}, context = {}) {
    if (!actor || !actor.id) {
      return { allow: false, reason: 'Unauthenticated actor' };
    }

    const actorId = String(actor.id);
    const actorRole = String(actor.role || 'USER').toUpperCase();
    const isAgent = actor.type === 'AGENT';
    const amount = Number(resource.amount || context.amount || 0);
    const documentType = (resource.type || context.documentType || 'GENERAL').toUpperCase();
    const creatorId = resource.created_by || resource.creator_id || context.created_by || null;

    // Runs on the caller's transaction client when there is one. Two reasons,
    // both of which turn a silent "allow" into a correct answer:
    //
    //   • Under company isolation, `app.current_company_id` is set on the
    //     connection the request is running on. A query issued on a DIFFERENT
    //     pool connection has no company context, so RLS shows it no rows —
    //     the template lookup comes back empty, no approval is deemed
    //     necessary, and the threshold check silently passes.
    //   • Within a transaction, a template written moments earlier is not
    //     visible from outside it.
    const db = context.client || pool;

    // -----------------------------------------------------------------------
    // 1. Autonomous Agent Governance Bounds
    // Autonomous agents MUST NEVER modify approval chains, DoA rules, roles, or grant autonomy.
    // -----------------------------------------------------------------------
    const governanceActions = [
      'MODIFY_APPROVAL_TEMPLATE',
      'MODIFY_DOA',
      'CHANGE_ROLE',
      'GRANT_AGENT_AUTONOMY',
      'GOVERNANCE_CHANGE'
    ];
    if (isAgent && governanceActions.includes(action)) {
      return {
        allow: false,
        reason: 'Autonomous agents are strictly forbidden from modifying governance, authority rules, or roles.'
      };
    }

    // -----------------------------------------------------------------------
    // 2. Segregation of Duties (SoD): Creator cannot approve or post their own record
    // -----------------------------------------------------------------------
    const sodActions = ['APPROVE', 'POST', 'POST_JOURNAL', 'CONFIRM_SALES_ORDER', 'COMPLETE'];
    if (creatorId && sodActions.some((a) => action.toUpperCase().includes(a))) {
      // The platform owner (the deployment's creator admin) may approve their
      // own operations. This is deliberately an identity check, resolved from
      // the database, not a role check — no role grants it, and it cannot be
      // self-assigned. Only performed when this is actually a self-approval
      // (the only case checkSoD would refuse), so ordinary approvals never
      // pay for a users-table lookup.
      const isSelfApproval = !!actorId && String(creatorId) === actorId;
      if (!isSelfApproval || !(await isPlatformOwnerId(actorId, db))) {
        try {
          checkSoD(creatorId, actorId, action);
        } catch (err) {
          return { allow: false, reason: err.message };
        }
      }
    }

    // -----------------------------------------------------------------------
    // 3. Governance / Authority-Over-Authority (C6 Four-Eyes Requirement)
    // Modifying approval templates or DoA rules requires ADMIN + distinct second approver.
    // -----------------------------------------------------------------------
    if (governanceActions.includes(action)) {
      if (actorRole !== 'ADMIN') {
        return { allow: false, reason: 'Governance changes require ADMIN role.' };
      }
      const secondApprover = context.second_approver_id || context.secondApproverId;
      if (!secondApprover || String(secondApprover) === actorId) {
        return {
          allow: false,
          needsApproval: true,
          reason: 'Four-eyes control violation: governance modifications require a second distinct approver signature.'
        };
      }
      return { allow: true };
    }

    // -----------------------------------------------------------------------
    // 4. Delegation of Authority money-band grants (delegation_of_authority)
    // -----------------------------------------------------------------------
    // The DoA engine (services/approvalRulesEngine.js) is the single authority
    // on amount-banded grants. A grant covering (amount, document type, cost
    // center) authorizes the actor directly; the chain-template resolution in
    // step 5 only decides who must approve when the actor holds no such grant.
    //
    // The platform owner (the deployment's creator admin) receives a synthetic
    // unlimited grant by identity from loadDoaDefinitions() — the deliberate
    // exception that keeps single-user / creator-only deployments working with
    // no DoA rows. It is an identity check resolved from the database, not a
    // role check, so no role can self-assign it.
    //
    // Note: checkUserAuthority reads through the shared pool, not the caller's
    // transaction client. Under company isolation the worst case is that a
    // grant is not visible here and resolution falls through to step 5 — the
    // same path as before this merge — never a false allow.
    try {
      const doaGrant = await ApprovalRulesEngine.checkUserAuthority(
        actorId,
        amount,
        context.costCenter || context.cost_center || resource.cost_center || null,
        documentType
      );
      if (doaGrant) {
        return { allow: true };
      }
    } catch (err) {
      // Fail toward the template/role checks below, never toward a grant.
      console.error(`[authority.js] DoA grant lookup failed for ${documentType}:`, err.message);
    }

    // -----------------------------------------------------------------------
    // 5. Threshold & Approval Chain Resolution (Migration 099)
    // -----------------------------------------------------------------------
    // Runs on the caller's transaction client when there is one.
    // (Declared above, before the SoD check, which also runs on it.)

    try {
      const tplRes = await db.query(
        `SELECT id FROM approval_chain_templates WHERE document_type = $1 AND is_active = true LIMIT 1`,
        [documentType]
      );

      if (tplRes.rows.length > 0) {
        const templateId = tplRes.rows[0].id;
        const stepsRes = await db.query(
          `SELECT * FROM approval_chain_steps WHERE template_id = $1 AND min_amount <= $2 ORDER BY step_number ASC`,
          [templateId, amount]
        );

        if (stepsRes.rows.length > 0) {
          // Check if actor carries any of the required approver roles or is specifically named
          const highestStep = stepsRes.rows[stepsRes.rows.length - 1];
          const hasRole = actorRole === 'ADMIN' || actorRole === highestStep.approver_role;
          const isNamed = highestStep.approver_user_id && String(highestStep.approver_user_id) === actorId;

          if (!hasRole && !isNamed) {
            return {
              allow: false,
              needsApproval: true,
              chain: stepsRes.rows,
              reason: `Action requires approval from role '${highestStep.approver_role}' for amount ${amount}.`
            };
          }
        }
      }
    } catch (err) {
      // Fail closed. This used to warn and fall through to the role-hierarchy
      // default below, which means any error reaching the threshold tables —
      // a dropped connection, an RLS filter, a missing table on a half-migrated
      // database — silently downgraded an amount-banded approval requirement to
      // "a MANAGER may do it". A control that disappears exactly when the
      // database is unhealthy is not a control.
      //
      // Note this is the ERROR path only. A document type with no configured
      // template is not an error: `tplRes.rows.length === 0` falls through by
      // design to the role-hierarchy check in step 5.
      console.error(`[authority.js] Threshold resolution failed for ${documentType}:`, err.message);
      return {
        allow: false,
        reason: `Authority thresholds could not be verified for ${documentType}. Refusing rather than assuming approval was unnecessary.`
      };
    }

    // -----------------------------------------------------------------------
    // 6. Default Role Authority Fallback
    // -----------------------------------------------------------------------
    const roleHierarchy = { ADMIN: 5, FINANCE_MANAGER: 4, MANAGER: 3, FINANCE_USER: 2, USER: 1 };
    const level = roleHierarchy[actorRole] || 1;

    if (action.includes('POST') || action.includes('APPROVE')) {
      if (level < 2) {
        return { allow: false, reason: `Role '${actorRole}' lacks permission for '${action}'.` };
      }
    }

    return { allow: true };
  }
}

module.exports = AuthorityEngine;
