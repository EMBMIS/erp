/**
 * Unified Status Transition Manager (`applyStatusChange`) for Simeli ERP.
 *
 * This is the SINGLE ATOMIC PATH through which consequential business status changes must pass.
 * Sequence of operations inside ONE database transaction:
 *   1. Lock row (`FOR UPDATE`) to prevent concurrency races.
 *   2. Validate legal transition via `stateMachine.assertTransition`.
 *   3. Verify actor authority & SoD via `authority.can`.
 *   4. Execute entity side-effects callback (`executeSideEffects`).
 *   5. Record status history entry.
 *   6. Append transaction-atomic row to tamper-evident `audit_chain`.
 */

const { pool } = require('../config/database');
const { assertTransition } = require('./stateMachine');
const AuthorityEngine = require('./authority');
const { auditStatusTransition } = require('./auditHook');
const { AppError } = require('../middleware/errorHandler');

/**
 * Table name mapping for entity types.
 */
const ENTITY_TABLE_MAP = {
  JOURNAL_ENTRY: { table: 'journal_entries', historyTable: 'journal_entry_status_history', idCol: 'journal_entry_id' },
  SALES_ORDER: { table: 'sales_orders', historyTable: 'sales_order_status_history', idCol: 'sales_order_id' },
  CUSTOMER_PAYMENT: { table: 'customer_payments', historyTable: 'customer_payment_status_history', idCol: 'payment_id' },
  SUPPLIER_PAYMENT: { table: 'supplier_payments', historyTable: 'supplier_payment_status_history', idCol: 'payment_id' },
  CREDIT_NOTE: { table: 'credit_notes', historyTable: 'credit_note_status_history', idCol: 'credit_note_id' },
  PURCHASE_ORDER: { table: 'purchase_orders', historyTable: 'purchase_order_status_history', idCol: 'purchase_order_id' },
  PURCHASE_REQUISITION: { table: 'purchase_requisitions', historyTable: 'purchase_requisition_status_history', idCol: 'requisition_id' },
  CONTRACT: { table: 'contracts', historyTable: 'contract_status_history', idCol: 'contract_id' },
  SALES_QUOTATION: { table: 'sales_quotations', historyTable: 'sales_quotation_status_history', idCol: 'sales_quotation_id' },
  SALES_RFQ: { table: 'sales_rfqs', historyTable: 'sales_rfq_status_history', idCol: 'sales_rfq_id' },
  DELIVERY_SCHEDULE: { table: 'delivery_schedules', historyTable: 'delivery_status_history', idCol: 'delivery_schedule_id' },
  SUPPLIER_INVOICE: { table: 'supplier_invoices', historyTable: 'supplier_invoice_status_history', idCol: 'bill_id' },
  PAYROLL_RUN: { table: 'payroll_runs', historyTable: 'payroll_run_status_history', idCol: 'payroll_run_id' },
  FIXED_ASSET: { table: 'fixed_assets', historyTable: 'fixed_asset_status_history', idCol: 'asset_id' },
  WAREHOUSE_TRANSACTION: { table: 'warehouse_transactions', historyTable: 'warehouse_transaction_status_history', idCol: 'transaction_id' },
  WORK_ORDER: { table: 'work_orders', historyTable: 'work_order_status_history', idCol: 'work_order_id' },
  BUDGET: { table: 'budgets', historyTable: 'budget_status_history', idCol: 'budget_id' }
};

/**
 * Resolves the actual actor and their real database role.
 * Fails closed if the actor cannot be resolved or is missing.
 */
async function resolveActor(client, actorInput) {
  if (!actorInput) {
    throw new AppError('Actor identification failed: actor is required for status changes.', 401);
  }

  const actorId = typeof actorInput === 'string' ? actorInput : actorInput.id;
  const actorType = (typeof actorInput === 'object' && actorInput.type) || 'USER';

  if (!actorId) {
    throw new AppError('Actor identification failed: valid actor ID is required.', 401);
  }

  // Handle explicit non-UUID system actors (middleware/auth.js)
  if (actorId === 'ai-system' || String(actorId).startsWith('api-key-')) {
    return {
      id: actorId,
      role: (typeof actorInput === 'object' && actorInput.role) ? actorInput.role : 'USER',
      type: actorType
    };
  }

  // Query real user from database — fail closed if not found or inactive.
  //
  // Two things this query gets right that the obvious version does not:
  //
  //   • It reads `is_active`, not `status`. There is no `status` column on
  //     `users` (see the baseline schema: id, email, password_hash, first_name,
  //     last_name, role, is_active, last_login, …). Selecting a column that does
  //     not exist raises 42703, which the catch below turns into a 401 — so the
  //     earlier version of this query failed EVERY status transition in the
  //     system with "actor resolution database error" while looking correct.
  //
  //   • It prefers the caller's company-scoped role over their global one.
  //     `user_companies.role` is documented in migration 110 as overriding the
  //     global role within that company. Reading only `users.role` means someone
  //     who is ADMIN globally but USER inside company B is evaluated as ADMIN
  //     there — which is precisely the authority boundary multi-company exists
  //     to draw. The LEFT JOIN yields NULL when isolation is off or the user has
  //     no membership row, and COALESCE falls back to the global role, so
  //     single-company installs behave exactly as before.
  try {
    const userRes = await client.query(
      `SELECT u.id,
              COALESCE(uc.role, u.role) AS role,
              u.is_active
         FROM users u
         LEFT JOIN user_companies uc
                ON uc.user_id = u.id
               AND uc.company_id = public.current_company_id()
        WHERE u.id::text = $1::text AND u.deleted_at IS NULL`,
      [String(actorId)]
    );

    if (userRes.rows.length === 0) {
      throw new AppError(`Actor resolution failed: user record ${actorId} not found in database.`, 401);
    }

    const user = userRes.rows[0];
    if (user.is_active === false) {
      throw new AppError(`Actor resolution failed: user account ${actorId} is inactive.`, 403);
    }

    return {
      id: String(user.id),
      role: user.role,
      type: actorType
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`Actor resolution database error: ${err.message}`, 401);
  }
}

/**
 * Centralized status transition driver.
 *
 * @param {object} params
 * @param {string} params.entityType - e.g. 'SALES_ORDER', 'JOURNAL_ENTRY'
 * @param {string} params.entityId - Primary key ID of the record
 * @param {string} params.newStatus - Target status to transition to
 * @param {object|string} params.actor - Actor object { id, role, type: 'USER'|'AGENT' } or string userId
 * @param {object} [params.context] - Additional metadata / amounts
 * @param {Function} [params.executeSideEffects] - Callback (client) for atomic side-effects
 * @param {import('pg').PoolClient} [externalClient] - Optional external transaction client
 */
async function applyStatusChange(
  { entityType, entityId, newStatus, actor: rawActor, context = {}, executeSideEffects },
  externalClient = null
) {
  // Validate actor input parameter upfront
  if (!rawActor) {
    throw new AppError('Actor identification failed: actor is required for status changes.', 401);
  }
  const rawActorId = typeof rawActor === 'string' ? rawActor : rawActor?.id;
  if (!rawActorId) {
    throw new AppError('Actor identification failed: valid actor ID is required.', 401);
  }

  const client = externalClient || (await pool.connect());
  const ownTransaction = !externalClient;

  try {
    if (ownTransaction) await client.query('BEGIN');

    // Resolve strict actor and role from DB
    const actor = await resolveActor(client, rawActor);

    const typeKey = String(entityType).toUpperCase();
    const mapping = ENTITY_TABLE_MAP[typeKey];
    if (!mapping) {
      throw new AppError(`Unsupported entity type for status change: ${entityType}`, 400);
    }

    // 1. Lock row FOR UPDATE to prevent concurrent race conditions
    const lockQuery = `SELECT * FROM ${mapping.table} WHERE id = $1 FOR UPDATE`;
    const lockRes = await client.query(lockQuery, [entityId]);
    if (lockRes.rows.length === 0) {
      throw new AppError(`${entityType} record not found: ${entityId}`, 404);
    }

    const currentRecord = lockRes.rows[0];
    const currentStatus = currentRecord.status;

    // 2. Validate state machine transition legality
    assertTransition(typeKey, currentStatus, newStatus);

    // GL Balance Guard: Ensure journal entry balances before posting
    if (typeKey === 'JOURNAL_ENTRY' && newStatus === 'POSTED') {
      const totalDebit = Number(currentRecord.total_debit || 0);
      const totalCredit = Number(currentRecord.total_credit || 0);
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        throw new AppError(`Cannot post unbalanced journal entry. Debits: ${totalDebit}, Credits: ${totalCredit}`, 400);
      }
    }

    // 3. Verify actor authority, SoD, and threshold checks
    const actionName = `TRANSITION_${currentStatus}_TO_${newStatus}`;
    const resource = {
      type: typeKey,
      id: entityId,
      amount: currentRecord.total_amount || currentRecord.total_debit || currentRecord.amount || context.amount || 0,
      created_by: currentRecord.created_by || currentRecord.requested_by || null
    };

    // `client` goes through so the threshold lookup runs on THIS transaction's
    // connection — the one carrying the company context RLS reads. See the note
    // in authority.js for why a pool connection would silently find no template.
    const authResult = await AuthorityEngine.can(actor, actionName, resource, { ...context, client });
    if (!authResult.allow) {
      throw new AppError(`Authority denied: ${authResult.reason || 'Insufficient permissions for this status change.'}`, 403);
    }

    // 4. Update main record status
    const updateQuery = `
      UPDATE ${mapping.table}
         SET status = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *
    `;
    const updateRes = await client.query(updateQuery, [entityId, newStatus, actor.id]);
    const updatedRecord = updateRes.rows[0];

    // 5. Execute side effects callback (if provided)
    if (typeof executeSideEffects === 'function') {
      await executeSideEffects(client, updatedRecord);
    }

    // 6. Write status history entry (strict: must succeed to ensure audit completeness)
    //
    // Free-text reasons come straight from a browser prompt() with no
    // client-side validation, so a stray keystroke or accidental paste (a
    // single stray character, for example) was landing verbatim in the audit
    // trail. Trim it and require enough content to actually explain the
    // change; anything short of that reads as noise, not a reason, so we
    // fall back to the generated default instead of storing it.
    const trimmedReason = typeof context.reason === 'string' ? context.reason.trim() : '';
    const effectiveReason = trimmedReason.length >= 3 ? trimmedReason : null;

    const historyQuery = `
      INSERT INTO ${mapping.historyTable} (${mapping.idCol}, from_status, to_status, changed_by, reason)
      VALUES ($1, $2, $3, $4, $5)
    `;
    await client.query(historyQuery, [
      entityId,
      currentStatus,
      newStatus,
      actor.id,
      effectiveReason || `Status changed to ${newStatus}`
    ]);

    // 7. Append to tamper-evident audit chain inside transaction
    await auditStatusTransition({
      client,
      entityType: typeKey,
      entityId: entityId,
      fromStatus: currentStatus,
      toStatus: newStatus,
      actorId: actor.id,
      reason: effectiveReason || `Transitioned ${currentStatus} -> ${newStatus}`,
      companyId: currentRecord.company_id || context.company_id || null
    });

    if (ownTransaction) await client.query('COMMIT');

    // 8. Tell the ecosystem. AFTER the commit, deliberately: an event announces
    // something that HAPPENED, and a subscriber that reacts to a transition
    // which then rolls back is worse than one that hears about it late. Emission
    // is fire-and-forget (webhookService never throws), so a slow or dead
    // subscriber cannot affect this transaction.
    //
    // This lives here rather than at the call sites because every consequential
    // status change in the system already passes through this function — which
    // means a flow added next year cannot forget to announce itself.
    //
    // On an external transaction the caller still owns the commit, so the event
    // would be premature; those callers announce their own outcome instead.
    if (ownTransaction) {
      try {
        require('./domainEvents').statusChanged(typeKey, updatedRecord, currentStatus, newStatus, actor.id);
      } catch (err) {
        console.warn(`[statusTransition] event emission failed for ${typeKey} ${entityId}:`, err.message);
      }
    }

    return updatedRecord;
  } catch (error) {
    if (ownTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownTransaction) client.release();
  }
}

module.exports = {
  applyStatusChange,
  ENTITY_TABLE_MAP
};
