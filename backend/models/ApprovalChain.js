const { pool } = require('../config/database');
const { isPlatformOwnerId } = require('../services/platformOwner');

/**
 * Generic, configurable N-step approval chain (ERP-Roadmap P2 #7).
 *
 * Deliberately additive — new document types opt in to this engine; it does
 * NOT replace the existing DelegationOfAuthority (DOA) single-tier checks that
 * sales/procurement already depend on. A template defines amount-banded
 * escalation steps: a request only walks through the steps whose band the
 * request amount actually crosses, in ascending order, so a small amount may
 * need one approval while a large one needs several, sequentially.
 */
class ApprovalChain {
  // ---- Templates ------------------------------------------------------------

  static async createTemplate({ name, document_type, steps }, userId) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('At least one step is required');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tpl = await client.query(
        `INSERT INTO approval_chain_templates (name, document_type, created_by) VALUES ($1,$2,$3) RETURNING *`,
        [name, document_type, userId]
      );
      const templateId = tpl.rows[0].id;
      for (const [i, step] of steps.entries()) {
        await client.query(
          `INSERT INTO approval_chain_steps (template_id, step_number, min_amount, approver_role, approver_user_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [templateId, i + 1, step.min_amount || 0, step.approver_role, step.approver_user_id || null]
        );
      }
      await client.query('COMMIT');
      return this.findTemplateById(templateId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async findTemplateById(id) {
    const tpl = await pool.query('SELECT * FROM approval_chain_templates WHERE id = $1', [id]);
    if (tpl.rows.length === 0) return null;
    const steps = await pool.query('SELECT * FROM approval_chain_steps WHERE template_id = $1 ORDER BY step_number', [id]);
    return { ...tpl.rows[0], steps: steps.rows };
  }

  static async findAllTemplates() {
    const r = await pool.query('SELECT * FROM approval_chain_templates ORDER BY created_at DESC');
    return r.rows;
  }

  // ---- Requests ---------------------------------------------------------------

  // Returns the template's steps applicable to this amount (min_amount <= amount),
  // ordered ascending — these are the steps the request must walk through.
  static async getApplicableSteps(templateId, amount) {
    const r = await pool.query(
      'SELECT * FROM approval_chain_steps WHERE template_id = $1 AND min_amount <= $2 ORDER BY step_number ASC',
      [templateId, amount]
    );
    return r.rows;
  }

  static async startRequest({ template_id, document_type, document_id, amount, currency = 'USD' }, userId) {
    const steps = await this.getApplicableSteps(template_id, amount);
    if (steps.length === 0) {
      throw new Error('No approval step applies to this amount — check the template configuration');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const req = await client.query(
        `INSERT INTO approval_requests (template_id, document_type, document_id, requested_by, amount, currency, status, current_step)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING',1) RETURNING *`,
        [template_id, document_type, document_id, userId, amount, currency]
      );
      const requestId = req.rows[0].id;

      for (const step of steps) {
        await client.query(
          `INSERT INTO approval_request_steps (request_id, step_number, approver_role, approver_user_id)
           VALUES ($1,$2,$3,$4)`,
          [requestId, step.step_number, step.approver_role, step.approver_user_id]
        );
      }

      await client.query('COMMIT');
      return this.findRequestById(requestId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async findRequestById(id) {
    const req = await pool.query('SELECT * FROM approval_requests WHERE id = $1', [id]);
    if (req.rows.length === 0) return null;
    const steps = await pool.query('SELECT * FROM approval_request_steps WHERE request_id = $1 ORDER BY step_number', [id]);
    return { ...req.rows[0], steps: steps.rows };
  }

  static async findAllRequests(filters = {}) {
    const conditions = [];
    const values = [];
    if (filters.status) { values.push(filters.status); conditions.push(`status = $${values.length}`); }
    if (filters.document_type) { values.push(filters.document_type); conditions.push(`document_type = $${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM approval_requests ${where} ORDER BY created_at DESC`, values);
    return r.rows;
  }

  // List steps currently awaiting a decision from this user (by role, or by a
  // specific approver_user_id set on the step).
  static async findPendingForUser(userId, userRole) {
    const r = await pool.query(
      `SELECT ars.*, ar.document_type, ar.document_id, ar.amount, ar.currency, ar.requested_by
       FROM approval_request_steps ars
       JOIN approval_requests ar ON ars.request_id = ar.id
       WHERE ars.status = 'PENDING'
         AND ar.status = 'PENDING'
         AND ars.step_number = ar.current_step
         AND (ars.approver_user_id = $1 OR (ars.approver_user_id IS NULL AND ars.approver_role = $2))
       ORDER BY ar.created_at ASC`,
      [userId, userRole]
    );
    return r.rows;
  }

  // Decide the CURRENT step of a request. Rejecting stops the whole chain;
  // approving advances to the next step, or completes the request if this was
  // the last one.
  static async decide(requestId, userId, userRole, decision, comments = '') {
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new Error('decision must be APPROVE or REJECT');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const reqRes = await client.query('SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE', [requestId]);
      if (reqRes.rows.length === 0) throw new Error('Approval request not found');
      const request = reqRes.rows[0];
      if (request.status !== 'PENDING') throw new Error(`This request is already ${request.status}`);

      const stepRes = await client.query(
        'SELECT * FROM approval_request_steps WHERE request_id = $1 AND step_number = $2',
        [requestId, request.current_step]
      );
      if (stepRes.rows.length === 0) throw new Error('Current step not found (data inconsistency)');
      const step = stepRes.rows[0];

      // The platform owner (the deployment's creator admin) may decide ANY
      // step — approve or reject — regardless of which role or named user it
      // is assigned to. Identity check against the same transaction client so
      // it is consistent with the rows being decided.
      const ownerOverride = await isPlatformOwnerId(userId, client);
      const authorized = ownerOverride || (step.approver_user_id ? step.approver_user_id === userId : step.approver_role === userRole);
      if (!authorized) {
        throw new Error(`You are not authorized to decide step ${request.current_step} (requires role ${step.approver_role}${step.approver_user_id ? ' or a specific approver' : ''})`);
      }

      const newStepStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await client.query(
        `UPDATE approval_request_steps SET status = $1, decided_by = $2, decided_at = CURRENT_TIMESTAMP, comments = $3
         WHERE request_id = $4 AND step_number = $5`,
        [newStepStatus, userId, comments, requestId, request.current_step]
      );

      if (decision === 'REJECT') {
        await client.query(
          `UPDATE approval_request_steps SET status = 'SKIPPED' WHERE request_id = $1 AND step_number > $2 AND status = 'PENDING'`,
          [requestId, request.current_step]
        );
        await client.query(
          `UPDATE approval_requests SET status = 'REJECTED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [requestId]
        );
      } else {
        const nextStep = await client.query(
          'SELECT step_number FROM approval_request_steps WHERE request_id = $1 AND step_number > $2 ORDER BY step_number ASC LIMIT 1',
          [requestId, request.current_step]
        );
        if (nextStep.rows.length > 0) {
          await client.query('UPDATE approval_requests SET current_step = $1 WHERE id = $2', [nextStep.rows[0].step_number, requestId]);
        } else {
          await client.query(
            `UPDATE approval_requests SET status = 'APPROVED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [requestId]
          );
        }
      }

      await client.query('COMMIT');
      return this.findRequestById(requestId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async cancel(requestId, userId) {
    const r = await pool.query(
      `UPDATE approval_requests SET status = 'CANCELLED', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [requestId]
    );
    if (r.rows.length === 0) throw new Error('Request not found or not pending');
    return r.rows[0];
  }
}

module.exports = ApprovalChain;
