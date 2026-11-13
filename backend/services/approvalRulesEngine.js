/**
 * Unified Approval Rules Engine.
 *
 * Consolidates Delegation of Authority (DoA), Approval Chains, and Threshold Rules
 * into a single deterministic engine.
 *
 * Design:
 *  - `evaluate(definition, context, options)` is PURE: given a set of rules
 *    (chain steps and/or DoA rows) and a transaction context it returns the
 *    routing decision. No database access, fully unit-testable.
 *  - The DB-backed methods (`evaluateRules`, `checkUserAuthority`,
 *    `getAuthorizedUsers`, `userHasAuthority`) load rule definitions from the
 *    real schema and then delegate to the pure evaluation. Every loader is
 *    defensive: if a table/column is missing (e.g. migrations not yet applied)
 *    it degrades to the data that is available instead of failing the request.
 *  - The engine is the single authority on "who approves this". Routes and
 *    middlewares must not re-implement amount-band / applies_to / delegation
 *    matching.
 */

const { pool } = require('../config/database');
const { currentCompanyId } = require('./companyContext');
const { isPlatformOwnerId } = require('./platformOwner');

// Transaction-type spellings that mean the same grant. The DoA form offers the
// plural (PURCHASE_REQUISITIONS / PURCHASE_ORDERS), the approve routes check the
// short code (PR / PO / PURCHASE_REQUISITION / PURCHASE_ORDER), and legacy seed
// data used yet another form (CONTRACT / RFQ_APPROVAL). A grant stored under any
// spelling must authorize a request under any other.
const APPLIES_TO_ALIASES = {
  PR: ['PR', 'PURCHASE_REQUISITION', 'PURCHASE_REQUISITIONS'],
  PURCHASE_REQUISITION: ['PR', 'PURCHASE_REQUISITION', 'PURCHASE_REQUISITIONS'],
  PURCHASE_REQUISITIONS: ['PR', 'PURCHASE_REQUISITION', 'PURCHASE_REQUISITIONS'],
  PO: ['PO', 'PURCHASE_ORDER', 'PURCHASE_ORDERS'],
  PURCHASE_ORDER: ['PO', 'PURCHASE_ORDER', 'PURCHASE_ORDERS'],
  PURCHASE_ORDERS: ['PO', 'PURCHASE_ORDER', 'PURCHASE_ORDERS'],
  CONTRACT: ['CONTRACT', 'CONTRACTS'],
  CONTRACTS: ['CONTRACT', 'CONTRACTS'],
  RFQ: ['RFQ', 'RFQ_APPROVAL'],
  RFQ_APPROVAL: ['RFQ', 'RFQ_APPROVAL']
};

// Keys we have already warned about, so missing optional tables log once.
const warnedQueries = new Set();

/**
 * Run the first query variant that succeeds; return [] if all fail.
 * Used to make optional/newer tables (approval_delegations, company_id
 * columns) non-fatal while still using them when present.
 */
async function tryQuery(variants, key) {
  let lastError = null;
  for (const variant of variants) {
    try {
      const { rows } = await pool.query(variant.sql, variant.values);
      return rows;
    } catch (error) {
      lastError = error;
    }
  }
  if (!warnedQueries.has(key)) {
    warnedQueries.add(key);
    console.warn(`[approvalRulesEngine] "${key}" query failed, treating as empty: ${lastError.message}`);
  }
  return [];
}

class ApprovalRulesEngine {
  // ---------------------------------------------------------------------
  // Pure condition matching
  // ---------------------------------------------------------------------

  static normalizeAmount(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Does `rule` apply to `context`?
   * Conditions supported: amount (inclusive band: exactly-at-threshold passes),
   * cost center (rule.cost_center is a wildcard when empty), category /
   * applies_to ('ALL' is a wildcard), and entity (rule.entity_id is a
   * wildcard when empty).
   */
  static matchConditions(rule, context = {}) {
    if (!rule) return false;
    const amount = this.normalizeAmount(context.amount);

    const min = rule.min_amount === null || rule.min_amount === undefined || rule.min_amount === ''
      ? 0 : this.normalizeAmount(rule.min_amount);
    const max = rule.max_amount === null || rule.max_amount === undefined || rule.max_amount === ''
      ? Infinity : this.normalizeAmount(rule.max_amount);
    if (amount < min || amount > max) return false;

    const ruleCc = rule.cost_center || rule.costCenterId || null;
    const ctxCc = context.costCenter || context.cost_center || null;
    if (ruleCc && ctxCc && String(ruleCc) !== String(ctxCc)) return false;

    const ruleCat = rule.applies_to || rule.category || rule.document_type || 'ALL';
    const ctxCat = context.category || context.documentType || 'ALL';
    // Alias-aware: a grant stored under any spelling (PR / PURCHASE_REQUISITION /
    // PURCHASE_REQUISITIONS) authorizes a request under any other.
    const catsMatch = (a, b) => a === b || a === 'ALL' || b === 'ALL'
      || (APPLIES_TO_ALIASES[a] && APPLIES_TO_ALIASES[a].includes(b))
      || (APPLIES_TO_ALIASES[b] && APPLIES_TO_ALIASES[b].includes(a));
    if (Array.isArray(ruleCat)) {
      if (!ruleCat.some((c) => catsMatch(c, ctxCat))) return false;
    } else if (!catsMatch(ruleCat, ctxCat)) {
      return false;
    }

    const ruleEntity = rule.entity_id || rule.entity || null;
    const ctxEntity = context.entity || context.entity_id || null;
    if (ruleEntity && ctxEntity && String(ruleEntity) !== String(ctxEntity)) return false;

    return true;
  }

  static ruleLevel(rule) {
    if (rule.level !== null && rule.level !== undefined) return Number(rule.level);
    if (rule.step_number !== null && rule.step_number !== undefined) return Number(rule.step_number);
    return 1;
  }

  /** Order rules: chain steps first by level, then DoA rows by tightest band. */
  static compareRules(a, b) {
    const aChain = a.template_id || a.source === 'chain' ? 1 : 0;
    const bChain = b.template_id || b.source === 'chain' ? 1 : 0;
    if (aChain !== bChain) return bChain - aChain;
    const aLevel = this.ruleLevel(a);
    const bLevel = this.ruleLevel(b);
    if (aLevel !== bLevel) return aLevel - bLevel;
    const aMax = a.max_amount === null || a.max_amount === undefined ? Infinity : this.normalizeAmount(a.max_amount);
    const bMax = b.max_amount === null || b.max_amount === undefined ? Infinity : this.normalizeAmount(b.max_amount);
    return aMax - bMax;
  }

  /**
   * Resolve who a rule names as approver:
   *  - named user: rule.approver_user_id / approver_id / user_id
   *  - manager-of: the requester's manager (context.requesterManagerId or an
   *    injected options.resolveManager(requesterId))
   *  - role: any user holding the role (role string kept; resolution to a
   *    concrete user can be injected via options.resolveRoleUsers)
   */
  static resolveApprover(rule, context = {}, options = {}) {
    const named = rule.approver_user_id || rule.approver_id || rule.user_id;
    const role = rule.approver_role || rule.role || null;
    if (named) return { approver: named, role: role || null };

    if (role && String(role).toUpperCase() === 'MANAGER_OF') {
      if (options.resolveManager && context.requesterId) {
        const managerId = options.resolveManager(context.requesterId);
        return { approver: managerId || role, role: 'MANAGER_OF' };
      }
      return { approver: context.requesterManagerId || role, role: 'MANAGER_OF' };
    }

    if (options.resolveRoleUsers && role) {
      const users = options.resolveRoleUsers(role);
      if (Array.isArray(users) && users.length > 0) {
        return { approver: users[0], role };
      }
    }

    return { approver: role || null, role };
  }

  static dedupeApprovers(approvers) {
    const seen = new Set();
    return approvers.filter((a) => {
      const key = `${a.level}:${a.approver}:${a.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ---------------------------------------------------------------------
  // Pure delegation (delegation-while-absent)
  // ---------------------------------------------------------------------

  /**
   * Replace an approver with their active delegate when a delegation covers
   * `now`. Original approver is preserved in `original_approver`.
   */
  static applyDelegations(approvers, delegations = [], now = new Date()) {
    if (!delegations || delegations.length === 0) return approvers;
    const t = new Date(now).getTime();

    const active = delegations.filter((d) => {
      if (!d) return false;
      const status = d.status === null || d.status === undefined ? 'ACTIVE' : String(d.status).toUpperCase();
      if (status !== 'ACTIVE') return false;
      const from = d.start_date ? new Date(d.start_date).getTime() : -Infinity;
      const to = d.end_date ? new Date(d.end_date).getTime() : Infinity;
      return from <= t && t <= to;
    });

    if (active.length === 0) return approvers;

    return approvers.map((a) => {
      const delegation = active.find((d) => String(d.delegator_id) === String(a.approver));
      if (!delegation) return a;
      return {
        ...a,
        approver: delegation.delegate_id,
        is_delegated: true,
        original_approver: a.approver,
        delegation: {
          delegator_id: delegation.delegator_id,
          delegate_id: delegation.delegate_id
        }
      };
    });
  }

  // ---------------------------------------------------------------------
  // Pure SLA / escalation
  // ---------------------------------------------------------------------

  /**
   * Attach SLA deadlines to every approver. When the request has been waiting
   * longer than the SLA, mark the current approvers overdue and escalate to
   * the next higher tier defined in the definition (level + 1), even if the
   * amount would not normally trigger that tier.
   */
  static escalateOverdue(approvers, context = {}, options = {}) {
    const slaHours = options.slaHours || context.slaHours || 48;
    const created = new Date(context.requestCreatedAt).getTime();
    const slaMs = this.normalizeAmount(slaHours) * 3600 * 1000;
    const deadline = created + slaMs;
    const now = new Date(context.now || Date.now()).getTime();

    const withSla = approvers.map((a) => ({
      ...a,
      sla_hours: slaHours,
      sla_deadline: new Date(deadline).toISOString()
    }));

    if (now <= deadline) {
      return {
        approvers: withSla,
        escalation: {
          escalated: false,
          reason: null,
          sla_hours: slaHours,
          sla_deadline: new Date(deadline).toISOString()
        }
      };
    }

    const marked = withSla.map((a) => ({
      ...a,
      is_overdue: true,
      escalated: true,
      escalation_reason: 'sla_timeout'
    }));

    // Pull in the next higher tier (level + 1) from the definition.
    const definition = Array.isArray(context.definition) ? context.definition : [];
    const maxLevel = marked.reduce((m, a) => Math.max(m, Number(a.level || 1)), 1);
    const nextRules = definition.filter(
      (r) => this.ruleLevel(r) === maxLevel + 1
    );

    let final = marked;
    for (const rule of nextRules) {
      const resolved = this.resolveApprover(rule, context, options);
      final.push({
        level: this.ruleLevel(rule),
        approver: resolved.approver,
        role: resolved.role,
        source: rule.source || (rule.template_id ? 'chain' : 'doa'),
        rule_id: rule.id || null,
        is_delegated: false,
        original_approver: resolved.approver,
        escalated: true,
        escalation_reason: 'sla_timeout'
      });
    }
    final = this.applyDelegations(this.dedupeApprovers(final), context.delegations || [], new Date(now));

    return {
      approvers: final,
      escalation: {
        escalated: true,
        reason: 'sla_timeout',
        sla_hours: slaHours,
        sla_deadline: new Date(deadline).toISOString()
      }
    };
  }

  // ---------------------------------------------------------------------
  // Pure evaluation entry point
  // ---------------------------------------------------------------------

  /**
   * Evaluate a rule definition against a transaction context.
   *
   * definition: array of rules. Each rule may carry:
   *   amount conditions  - min_amount / max_amount (inclusive)
   *   cost center        - cost_center
   *   category           - applies_to / category / document_type ('ALL' = any)
   *   entity             - entity_id / entity
   *   approver           - approver_user_id (named user), approver_role
   *                        ('MANAGER_OF' = manager of requester, else a role)
   *   level / step_number - approval tier (chain steps) or 1 (DoA rows)
   *
   * context: { amount, costCenter, category, entity, requesterId,
   *            requesterManagerId, delegations, requestCreatedAt, now }
   * options: { slaHours, resolveManager, resolveRoleUsers }
   */
  static evaluate(definition, context = {}, options = {}) {
    const amount = this.normalizeAmount(context.amount);
    const category = context.category || context.documentType || 'ALL';
    const now = context.now ? new Date(context.now) : new Date();
    const rules = Array.isArray(definition)
      ? definition
      : (definition && Array.isArray(definition.rules) ? definition.rules : []);

    const matched = rules
      .filter((rule) => this.matchConditions(rule, { ...context, category, amount }))
      .sort((a, b) => this.compareRules(a, b));

    let approvers = [];
    for (const rule of matched) {
      const resolved = this.resolveApprover(rule, context, options);
      approvers.push({
        level: this.ruleLevel(rule),
        approver: resolved.approver,
        role: resolved.role,
        source: rule.source || (rule.template_id ? 'chain' : 'doa'),
        rule_id: rule.id || null,
        is_delegated: false,
        original_approver: resolved.approver
      });
    }
    approvers = this.dedupeApprovers(approvers);
    approvers = this.applyDelegations(approvers, context.delegations || [], now);

    let escalation = { escalated: false, reason: null };
    if (context.requestCreatedAt && options.slaHours) {
      const sla = this.escalateOverdue(approvers, { ...context, definition: rules }, options);
      approvers = sla.approvers;
      escalation = sla.escalation;
    }

    const requiresApproval = amount > 0 && approvers.length > 0;
    const chainTemplateIds = new Set(
      matched.filter((r) => r.template_id || r.source === 'chain').map((r) => r.template_id || r.id)
    );

    return {
      requires_approval: requiresApproval,
      decision: requiresApproval ? 'REQUIRES_APPROVAL' : 'APPROVE',
      document_type: category,
      category,
      entity: context.entity || null,
      amount,
      approvers,
      matched_rules: matched.map((r) => r.id || r),
      matching_chains: chainTemplateIds.size,
      escalation,
      evaluated_at: now.toISOString()
    };
  }

  // ---------------------------------------------------------------------
  // DB-backed definition loaders (defensive)
  // ---------------------------------------------------------------------

  /** Load active approval chain steps for a document type. */
  static async loadChainSteps(documentType, companyId = null) {
    const baseSql = `SELECT t.id AS template_id, t.name AS template_name,
            s.id, s.step_number, s.min_amount, s.approver_role, s.approver_user_id
      FROM approval_chain_templates t
      JOIN approval_chain_steps s ON s.template_id = t.id
      WHERE t.document_type = $1 AND t.is_active = true`;

    const variants = [];
    if (companyId) {
      variants.push({
        sql: `${baseSql} AND t.company_id = $2 ORDER BY s.step_number ASC`,
        values: [documentType, companyId]
      });
    }
    variants.push({ sql: `${baseSql} ORDER BY s.step_number ASC`, values: [documentType] });

    const rows = await tryQuery(variants, 'chains');
    return rows.map((r) => ({
      id: r.id,
      template_id: r.template_id,
      template_name: r.template_name,
      level: Number(r.step_number),
      step_number: Number(r.step_number),
      min_amount: r.min_amount === null || r.min_amount === undefined ? 0 : Number(r.min_amount),
      approver_role: r.approver_role,
      approver_user_id: r.approver_user_id,
      source: 'chain'
    }));
  }

  /**
   * Load active DoA rows. transactionType filters by applies_to
   * ('ALL' rows always included); userId narrows to one user.
   */
  static async loadDoaDefinitions({ userId = null, transactionType = null, companyId = null } = {}) {
    const where = [
      'doa.is_active = TRUE',
      'doa.effective_from <= CURRENT_DATE',
      '(doa.effective_until IS NULL OR doa.effective_until >= CURRENT_DATE)'
    ];
    const values = [];

    if (userId) {
      where.push(`doa.user_id = $${values.length + 1}`);
      values.push(userId);
    }
    if (transactionType) {
      const key = String(transactionType).toUpperCase();
      const aliases = APPLIES_TO_ALIASES[key] || [key];
      // Expanded into individual parameters rather than ANY($n::text[]):
      // node-postgres serializes JS arrays as JSON, which is not a valid
      // Postgres array literal, so the ANY form throws and the defensive
      // loader silently degrades to zero rows.
      const placeholders = aliases.map((_, i) => `$${values.length + i + 1}`).join(', ');
      where.push(`(doa.applies_to = 'ALL' OR doa.applies_to IN (${placeholders}))`);
      values.push(...aliases);
    }

    const baseSql = `SELECT doa.*,
        u.first_name || ' ' || u.last_name AS user_name,
        u.email AS user_email
      FROM delegation_of_authority doa
      LEFT JOIN users u ON doa.user_id = u.id
      WHERE ${where.join(' AND ')}`;

    const variants = [];
    if (companyId) {
      variants.push({
        sql: `${baseSql} AND doa.company_id = $${values.length + 1} ORDER BY doa.max_amount ASC`,
        values: [...values, companyId]
      });
    }
    variants.push({ sql: `${baseSql} ORDER BY doa.max_amount ASC`, values });

    const rows = await tryQuery(variants, 'doa');
    const result = rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      user_name: r.user_name,
      user_email: r.user_email,
      cost_center: r.cost_center,
      min_amount: r.min_amount === null || r.min_amount === undefined ? 0 : Number(r.min_amount),
      max_amount: r.max_amount === null || r.max_amount === undefined ? null : Number(r.max_amount),
      applies_to: r.applies_to,
      currency: r.currency,
      source: 'doa',
      level: 1
    }));

    // The platform owner (the deployment's creator admin) holds authority for
    // EVERY transaction type, amount, and cost center by identity — no DoA row
    // is required. The synthetic entry below makes every engine consumer
    // (userHasAuthority, checkUserAuthority, getAuthorizedUsers, the pending
    // lists) treat the owner as authorized for anything, including categories
    // no DoA row has ever been created for.
    if (userId && (await isPlatformOwnerId(userId))) {
      const ownerRows = await tryQuery([{
        sql: 'SELECT first_name, last_name, email FROM users WHERE id::text = $1::text',
        values: [String(userId)]
      }], 'platform-owner-info');
      const owner = ownerRows[0];
      result.push({
        id: null,
        user_id: userId,
        user_name: owner ? `${owner.first_name} ${owner.last_name}`.trim() : 'Platform Owner',
        user_email: owner ? owner.email : null,
        cost_center: null,
        min_amount: 0,
        max_amount: null,
        applies_to: 'ALL',
        currency: 'USD',
        source: 'doa',
        level: 1,
        is_platform_owner_override: true
      });
    }

    return result;
  }

  /** Load currently active delegations (delegation-while-absent). */
  static async loadActiveDelegations(_companyId = null) {
    const rows = await tryQuery([{
      sql: `SELECT delegator_id, delegate_id, start_date, end_date, status
        FROM approval_delegations
        WHERE status = 'ACTIVE'
          AND start_date <= CURRENT_TIMESTAMP
          AND (end_date IS NULL OR end_date >= CURRENT_TIMESTAMP)`,
      values: []
    }], 'delegations');
    return rows;
  }

  // ---------------------------------------------------------------------
  // DB-backed evaluation (route/middleware entry points)
  // ---------------------------------------------------------------------

  /**
   * Evaluate approval routing for a document request.
   * Loads chain steps + DoA rows + active delegations from the database and
   * delegates to the pure `evaluate()`.
   */
  static async evaluateRules({
    documentType,
    amount = 0,
    costCenterId = null,
    requesterId = null,
    companyId = currentCompanyId(),
    entity = null,
    delegations = null,
    slaHours = null,
    requestCreatedAt = null
  } = {}) {
    const numAmount = this.normalizeAmount(amount);
    const category = documentType || 'ALL';

    const [chainRules, doaRules] = await Promise.all([
      this.loadChainSteps(category, companyId),
      this.loadDoaDefinitions({ transactionType: category, companyId })
    ]);
    const definition = [...chainRules, ...doaRules];

    const activeDelegations = delegations !== null
      ? delegations
      : await this.loadActiveDelegations(companyId);

    return this.evaluate(definition, {
      amount: numAmount,
      costCenter: costCenterId,
      category,
      entity,
      requesterId,
      delegations: activeDelegations,
      requestCreatedAt: requestCreatedAt ? new Date(requestCreatedAt) : null
    }, { slaHours: slaHours || null });
  }

  /**
   * Simulation helper: "who would approve a $X PO from cost center Y?"
   */
  static async simulateApprovalRoute(params) {
    return this.evaluateRules(params);
  }

  /**
   * Does `userId` hold a DoA covering `amount` for `transactionType`?
   * Returns the tightest matching authority row (or null).
   */
  static async checkUserAuthority(userId, amount, costCenter = null, transactionType = 'ALL', companyId = currentCompanyId()) {
    const rows = await this.loadDoaDefinitions({ userId, transactionType, companyId });
    const matching = rows
      .filter((r) => this.matchConditions(r, {
        amount: this.normalizeAmount(amount),
        costCenter,
        category: transactionType || 'ALL'
      }))
      .sort((a, b) => this.compareRules(a, b));
    return matching.length > 0 ? matching[0] : null;
  }

  /** Users holding a DoA that covers `amount` for `transactionType`. */
  static async getAuthorizedUsers(amount, costCenter = null, transactionType = 'ALL', companyId = currentCompanyId()) {
    const rows = await this.loadDoaDefinitions({ transactionType, companyId });
    const matching = rows.filter((r) => this.matchConditions(r, {
      amount: this.normalizeAmount(amount),
      costCenter,
      category: transactionType || 'ALL'
    }));

    const seen = new Set();
    const users = [];
    for (const r of matching) {
      if (!r.user_id || seen.has(String(r.user_id))) continue;
      seen.add(String(r.user_id));
      users.push({
        user_id: r.user_id,
        user_name: r.user_name,
        user_email: r.user_email,
        cost_center: r.cost_center,
        max_amount: r.max_amount
      });
    }

    // The platform owner is authorized for every amount and transaction type
    // by identity (see loadDoaDefinitions) — include them in "who may approve
    // this" listings even when no DoA row names them.
    const owner = await this.loadPlatformOwner();
    if (owner && !seen.has(String(owner.user_id))) {
      users.push(owner);
    }

    users.sort((a, b) => {
      const aMax = a.max_amount === null ? Infinity : Number(a.max_amount);
      const bMax = b.max_amount === null ? Infinity : Number(b.max_amount);
      return aMax - bMax;
    });
    return users;
  }

  /**
   * Resolve the platform owner (creator admin) as an authorized-user entry.
   * Honors the same precedence as middleware/auth.js: PLATFORM_OWNER_EMAIL
   * (env) wins over the one-time claim. Returns null when nobody holds it.
   */
  static async loadPlatformOwner() {
    const configured = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
    const where = configured
      ? "u.deleted_at IS NULL AND LOWER(u.email) = $1"
      : 'u.deleted_at IS NULL AND u.is_platform_owner = TRUE';
    const values = configured ? [configured] : [];
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.email
           FROM users u
          WHERE ${where}
          LIMIT 1`,
        values
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        user_id: r.id,
        user_name: `${r.first_name} ${r.last_name}`.trim(),
        user_email: r.email,
        cost_center: null,
        max_amount: null,
        is_platform_owner_override: true
      };
    } catch (error) {
      console.warn('[approvalRulesEngine] platform-owner lookup failed, treating as absent:', error.message);
      return null;
    }
  }

  /** Does this user hold any active authority for the transaction type? */
  static async userHasAuthority(userId, transactionType = 'ALL', costCenter = null, companyId = currentCompanyId()) {
    const rows = await this.loadDoaDefinitions({ userId, transactionType, companyId });
    if (rows.length === 0) return false;
    if (costCenter) {
      return rows.some((r) => !r.cost_center || String(r.cost_center) === String(costCenter));
    }
    return true;
  }
}

module.exports = ApprovalRulesEngine;
