/**
 * Transactional Audit Hook for Simeli ERP.
 *
 * Wrapper over `auditTrailService.appendAuditRecord` that mandates passing the
 * caller's open database transaction `{ client }`. Ensures that audit log appends
 * commit atomically with the business status change and roll back if the business transaction fails.
 */

const { appendAuditRecord } = require('./auditTrailService');

/**
 * Appends an audit record to the tamper-evident audit_chain inside an active transaction.
 *
 * @param {object} params
 * @param {import('pg').PoolClient} params.client - Active database transaction client (REQUIRED)
 * @param {string} params.entityType - Type of entity (e.g., 'JOURNAL_ENTRY', 'SALES_ORDER')
 * @param {string} params.entityId - ID of entity being updated
 * @param {string} [params.fromStatus] - Previous status
 * @param {string} [params.toStatus] - New status
 * @param {string} [params.actorId] - User or agent ID performing the action
 * @param {string} [params.reason] - Reason or notes for the action
 * @param {string} [params.companyId] - Tenant company ID
 */
async function auditStatusTransition({ client, entityType, entityId, fromStatus, toStatus, actorId, reason, companyId }) {
  if (!client) {
    throw new Error('[auditHook] A database transaction client is required for atomic audit appends.');
  }

  return await appendAuditRecord(
    {
      entity_type: entityType,
      entity_id: entityId,
      from_status: fromStatus,
      to_status: toStatus,
      changed_by: actorId,
      reason: reason || null,
      company_id: companyId || null
    },
    { client }
  );
}

module.exports = {
  auditStatusTransition
};
