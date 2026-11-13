/**
 * Lightweight CRM: contacts, deals, activities.
 *
 * Sized for a salesperson at a 50-person company. The whole module is one file
 * because it is genuinely small — splitting it across three would add imports
 * without adding clarity.
 *
 * Two opinions are baked in rather than configured:
 *
 * 1. Win probability is derived from the pipeline stage, not typed by hand.
 *    A forecast built from numbers people invent is worse than one built from
 *    stage defaults, because it carries false precision. Callers can still
 *    override per deal when they genuinely know better.
 *
 * 2. Moving a deal to WON or LOST closes it, and closing is a one-way door.
 *    Reopening a closed deal would silently corrupt every historical
 *    win-rate and cycle-time figure; the right move is a new deal.
 */

const { pool } = require('../config/database');

// Default probability per stage. Advancing a deal without giving a probability
// moves the forecast in the right direction automatically.
const STAGE_PROBABILITY = {
  NEW: 10,
  QUALIFIED: 25,
  PROPOSAL: 50,
  NEGOTIATION: 75,
  WON: 100,
  LOST: 0,
};

const OPEN_STAGES = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION'];

// ===========================================================================
// Contacts
// ===========================================================================

const Contacts = {
  async create({ first_name, last_name, email, phone, job_title, customer_id, owner_id, notes }, userId) {
    if (!first_name || !String(first_name).trim()) throw new Error('A contact needs at least a first name.');

    const { rows } = await pool.query(
      `INSERT INTO contacts (first_name, last_name, email, phone, job_title, customer_id, owner_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [String(first_name).trim(), last_name || null, email || null, phone || null,
       job_title || null, customer_id || null, owner_id || userId, notes || null, userId]
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT c.*, cu.customer_name
         FROM contacts c
         LEFT JOIN customers cu ON cu.id = c.customer_id
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return null;

    // A contact is only useful with their history attached.
    const [deals, activities] = await Promise.all([
      pool.query(
        `SELECT id, deal_number, title, value, currency, stage, expected_close_date
           FROM deals WHERE contact_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT id, activity_type, subject, due_date, completed_at, created_at
           FROM activities WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id]
      ),
    ]);

    return { ...rows[0], deals: deals.rows, activities: activities.rows };
  },

  async findAll({ search, customer_id, owner_id, limit = 100 } = {}) {
    const params = [];
    let where = 'WHERE c.deleted_at IS NULL';

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length}
                      OR c.email ILIKE $${params.length})`;
    }
    if (customer_id) { params.push(customer_id); where += ` AND c.customer_id = $${params.length}`; }
    if (owner_id) { params.push(owner_id); where += ` AND c.owner_id = $${params.length}`; }

    params.push(Math.min(Number(limit) || 100, 500));
    const { rows } = await pool.query(
      `SELECT c.*, cu.customer_name
         FROM contacts c
         LEFT JOIN customers cu ON cu.id = c.customer_id
         ${where}
         ORDER BY c.created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  },

  async update(id, fields) {
    const allowed = ['first_name', 'last_name', 'email', 'phone', 'job_title', 'customer_id', 'owner_id', 'notes', 'status'];
    const sets = [];
    const params = [id];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) throw new Error('Nothing to update.');
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const { rows } = await pool.query(
      `UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows.length) throw new Error('Contact not found.');
    return rows[0];
  },

  async remove(id) {
    const { rows } = await pool.query(
      `UPDATE contacts SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id]
    );
    if (!rows.length) throw new Error('Contact not found.');
    return { deleted: true };
  },

  /**
   * Find contacts that look like the same person, so a duplicate can be caught
   * as it is typed rather than found months later.
   */
  async findPossibleDuplicates({ email, first_name, last_name }) {
    if (!email && !last_name) return [];
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, customer_id
         FROM contacts
        WHERE deleted_at IS NULL
          AND ( ($1::text IS NOT NULL AND LOWER(email) = LOWER($1))
             OR ($2::text IS NOT NULL AND $3::text IS NOT NULL
                 AND LOWER(first_name) = LOWER($2) AND LOWER(last_name) = LOWER($3)) )
        LIMIT 10`,
      [email || null, first_name || null, last_name || null]
    );
    return rows;
  },
};

// ===========================================================================
// Deals
// ===========================================================================

const Deals = {
  STAGE_PROBABILITY,
  OPEN_STAGES,

  async create({ title, customer_id, contact_id, value, currency, stage, probability, expected_close_date, owner_id, source, notes }, userId) {
    if (!title || !String(title).trim()) throw new Error('A deal needs a title.');
    const dealStage = stage || 'NEW';
    if (!(dealStage in STAGE_PROBABILITY)) throw new Error(`Unknown deal stage "${dealStage}".`);

    const numResult = await pool.query('SELECT generate_deal_number() AS n');
    const { rows } = await pool.query(
      `INSERT INTO deals
         (deal_number, title, customer_id, contact_id, value, currency, stage, probability,
          expected_close_date, owner_id, source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [numResult.rows[0].n, String(title).trim(), customer_id || null, contact_id || null,
       Number(value) || 0, currency || 'USD', dealStage,
       probability !== undefined ? probability : STAGE_PROBABILITY[dealStage],
       expected_close_date || null, owner_id || userId, source || null, notes || null, userId]
    );

    await pool.query(
      `INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by, reason)
       VALUES ($1, NULL, $2, $3, 'Deal created')`,
      [rows[0].id, dealStage, userId]
    );

    return rows[0];
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT d.*, cu.customer_name,
              co.first_name AS contact_first_name, co.last_name AS contact_last_name, co.email AS contact_email
         FROM deals d
         LEFT JOIN customers cu ON cu.id = d.customer_id
         LEFT JOIN contacts co  ON co.id = d.contact_id
        WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return null;

    const [activities, stageHistory] = await Promise.all([
      pool.query(
        `SELECT id, activity_type, subject, notes, due_date, completed_at, created_at
           FROM activities WHERE deal_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT h.*, u.first_name AS changed_by_first_name, u.last_name AS changed_by_last_name
           FROM deal_stage_history h
           LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.deal_id = $1
          ORDER BY h.changed_at ASC`,
        [id]
      ),
    ]);
    return { ...rows[0], activities: activities.rows, stage_history: stageHistory.rows };
  },

  async findAll({ stage, owner_id, customer_id, open_only, limit = 200 } = {}) {
    const params = [];
    let where = 'WHERE d.deleted_at IS NULL';

    if (stage) { params.push(stage); where += ` AND d.stage = $${params.length}`; }
    if (open_only) where += ` AND d.stage NOT IN ('WON','LOST')`;
    if (owner_id) { params.push(owner_id); where += ` AND d.owner_id = $${params.length}`; }
    if (customer_id) { params.push(customer_id); where += ` AND d.customer_id = $${params.length}`; }

    params.push(Math.min(Number(limit) || 200, 500));
    const { rows } = await pool.query(
      `SELECT d.*, cu.customer_name,
              co.first_name AS contact_first_name, co.last_name AS contact_last_name,
              (SELECT MAX(created_at) FROM activities a WHERE a.deal_id = d.id) AS last_activity_at
         FROM deals d
         LEFT JOIN customers cu ON cu.id = d.customer_id
         LEFT JOIN contacts co  ON co.id = d.contact_id
         ${where}
         ORDER BY d.expected_close_date NULLS LAST, d.value DESC
         LIMIT $${params.length}`,
      params
    );
    return rows;
  },

  /**
   * Move a deal along the pipeline.
   *
   * Reaching WON or LOST closes the deal permanently. Reopening would corrupt
   * every historical win-rate and sales-cycle figure derived from closed_at.
   */
  async moveStage(id, stage, { probability, lost_reason } = {}, userId) {
    if (!(stage in STAGE_PROBABILITY)) throw new Error(`Unknown deal stage "${stage}".`);

    const current = await pool.query(
      'SELECT stage FROM deals WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!current.rows.length) throw new Error('Deal not found.');
    if (['WON', 'LOST'].includes(current.rows[0].stage)) {
      throw new Error(
        `This deal is already ${current.rows[0].stage} and cannot be reopened — create a new deal instead, so win-rate and cycle-time history stay accurate.`
      );
    }

    if (stage === 'LOST' && !lost_reason) {
      // A lost deal with no reason is a lost lesson.
      throw new Error('Please give a reason when marking a deal as lost.');
    }

    const isClosing = ['WON', 'LOST'].includes(stage);
    const { rows } = await pool.query(
      `UPDATE deals
          SET stage = $2,
              probability = $3,
              lost_reason = COALESCE($4, lost_reason),
              closed_at = CASE WHEN $5 THEN CURRENT_TIMESTAMP ELSE closed_at END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, stage, probability !== undefined ? probability : STAGE_PROBABILITY[stage],
       lost_reason || null, isClosing]
    );

    await pool.query(
      `INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, current.rows[0].stage, stage, userId || null, stage === 'LOST' ? lost_reason : null]
    );

    return rows[0];
  },

  /**
   * Full stage history for one deal, oldest first — the "how long did this
   * sit in PROPOSAL, and who moved it" answer nothing else in this module
   * could give before.
   */
  async stageHistory(dealId) {
    const { rows } = await pool.query(
      `SELECT h.*, u.first_name AS changed_by_first_name, u.last_name AS changed_by_last_name
         FROM deal_stage_history h
         LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.deal_id = $1
        ORDER BY h.changed_at ASC`,
      [dealId]
    );
    return rows;
  },

  async update(id, fields) {
    const allowed = ['title', 'customer_id', 'contact_id', 'value', 'currency',
                     'expected_close_date', 'owner_id', 'source', 'notes', 'probability'];
    const sets = [];
    const params = [id];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) throw new Error('Nothing to update.');
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const { rows } = await pool.query(
      `UPDATE deals SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows.length) throw new Error('Deal not found.');
    return rows[0];
  },

  /**
   * Pipeline summary — the view a sales manager actually opens.
   * Weighted value uses each deal's probability, so the total is a forecast
   * rather than a wish list.
   */
  async pipeline({ owner_id } = {}) {
    const params = [];
    let filter = '';
    if (owner_id) { params.push(owner_id); filter = ` AND owner_id = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT stage,
              COUNT(*)::int AS deal_count,
              COALESCE(SUM(value), 0)::float AS total_value,
              COALESCE(SUM(value * probability / 100.0), 0)::float AS weighted_value
         FROM deals
        WHERE deleted_at IS NULL AND stage NOT IN ('WON','LOST') ${filter}
        GROUP BY stage`,
      params
    );

    const byStage = new Map(rows.map((r) => [r.stage, r]));
    const stages = OPEN_STAGES.map((s) => ({
      stage: s,
      deal_count: byStage.get(s)?.deal_count || 0,
      total_value: Number((byStage.get(s)?.total_value || 0).toFixed(2)),
      weighted_value: Number((byStage.get(s)?.weighted_value || 0).toFixed(2)),
    }));

    // Win rate over the last 90 days of closed deals.
    const closed = await pool.query(
      `SELECT stage, COUNT(*)::int AS n, COALESCE(SUM(value),0)::float AS v
         FROM deals
        WHERE deleted_at IS NULL AND stage IN ('WON','LOST')
          AND closed_at >= CURRENT_DATE - INTERVAL '90 days' ${filter}
        GROUP BY stage`,
      params
    );
    const won = closed.rows.find((r) => r.stage === 'WON') || { n: 0, v: 0 };
    const lost = closed.rows.find((r) => r.stage === 'LOST') || { n: 0, v: 0 };
    const decided = won.n + lost.n;

    return {
      stages,
      open_total: Number(stages.reduce((s, x) => s + x.total_value, 0).toFixed(2)),
      weighted_total: Number(stages.reduce((s, x) => s + x.weighted_value, 0).toFixed(2)),
      last_90_days: {
        won_count: won.n,
        won_value: Number(won.v.toFixed(2)),
        lost_count: lost.n,
        win_rate: decided ? Number(((won.n / decided) * 100).toFixed(1)) : null,
        note: decided === 0 ? 'No deals have been closed in the last 90 days, so there is no win rate to report yet.' : null,
      },
    };
  },
};

// ===========================================================================
// Activities
// ===========================================================================

const Activities = {
  async create({ activity_type, subject, notes, due_date, contact_id, deal_id, customer_id, lead_id, owner_id, completed }, userId) {
    if (!subject || !String(subject).trim()) throw new Error('An activity needs a subject.');

    const { rows } = await pool.query(
      `INSERT INTO activities
         (activity_type, subject, notes, due_date, contact_id, deal_id, customer_id, lead_id, owner_id, completed_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [activity_type || 'TASK', String(subject).trim(), notes || null, due_date || null,
       contact_id || null, deal_id || null, customer_id || null, lead_id || null, owner_id || userId,
       // A NOTE records something that already happened, so it is complete on
       // arrival — leaving notes "open" would clutter every follow-up list.
       completed || activity_type === 'NOTE' ? new Date() : null,
       userId]
    );
    return rows[0];
  },

  async complete(id) {
    const { rows } = await pool.query(
      `UPDATE activities SET completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND completed_at IS NULL RETURNING *`,
      [id]
    );
    if (!rows.length) throw new Error('Activity not found, or it is already complete.');
    return rows[0];
  },

  async findAll({ owner_id, deal_id, contact_id, lead_id, overdue_only, open_only, limit = 100 } = {}) {
    const params = [];
    let where = 'WHERE 1=1';

    if (owner_id) { params.push(owner_id); where += ` AND a.owner_id = $${params.length}`; }
    if (deal_id) { params.push(deal_id); where += ` AND a.deal_id = $${params.length}`; }
    if (contact_id) { params.push(contact_id); where += ` AND a.contact_id = $${params.length}`; }
    if (lead_id) { params.push(lead_id); where += ` AND a.lead_id = $${params.length}`; }
    if (open_only || overdue_only) where += ' AND a.completed_at IS NULL';
    if (overdue_only) where += ' AND a.due_date < CURRENT_DATE';

    params.push(Math.min(Number(limit) || 100, 500));
    const { rows } = await pool.query(
      `SELECT a.*, d.title AS deal_title, d.deal_number,
              c.first_name AS contact_first_name, c.last_name AS contact_last_name
         FROM activities a
         LEFT JOIN deals d    ON d.id = a.deal_id
         LEFT JOIN contacts c ON c.id = a.contact_id
         ${where}
         ORDER BY a.completed_at IS NOT NULL, a.due_date NULLS LAST, a.created_at DESC
         LIMIT $${params.length}`,
      params
    );
    return rows;
  },
};

module.exports = { Contacts, Deals, Activities, STAGE_PROBABILITY, OPEN_STAGES };
