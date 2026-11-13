/**
 * The shadow ledger — where a branch is actually run.
 *
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 * Opens ONE connection, begins ONE transaction, and never commits it. Inside
 * that transaction each branch gets a SAVEPOINT: its effects are applied, the
 * state vector is measured on the same connection (so it sees them), and then
 * the savepoint is rolled back so the next branch starts from the same baseline
 * rather than from its predecessor's world. At the end the whole transaction
 * rolls back, and the database is byte-for-byte where it started.
 *
 * WHY NOT COMMIT / WHY NOT A COPY OF THE DATABASE
 * ---------------------------------------------------------------------------
 * A copy is a different answer to a different question. The point of measuring
 * on the live rows is that the constraints, the triggers, the generated columns
 * (customer_invoices.outstanding_amount is one) and the row-level security are
 * all the real ones. If a branch would be rejected by a CHECK constraint in
 * production, it is rejected here, now, in front of the person deciding —
 * instead of at 4pm on the day they act on it. That fidelity is the product.
 *
 * THE FOUR GUARANTEES, AND HOW EACH IS ENFORCED
 * ---------------------------------------------------------------------------
 *  1. Nothing commits. There is no COMMIT statement in this file, and the
 *     rollback is in a `finally`. A thrown error, a timeout, a caller that
 *     forgets — all end the same way.
 *  2. Nothing runs long. `SET LOCAL statement_timeout` bounds any single
 *     statement, and a wall clock bounds the whole run: a simulation holding a
 *     transaction open is holding locks on live rows, so it must be short by
 *     construction rather than by good behaviour.
 *  3. Nothing leaks between branches. Each branch is wrapped in its own
 *     savepoint, released only by ROLLBACK TO. A branch that throws rolls back
 *     to the same point as one that succeeds.
 *  4. Nothing escapes to another connection. Effects receive `client` and the
 *     effects module never imports the pool (see effects.js).
 *
 * WHAT IT COSTS
 * ---------------------------------------------------------------------------
 * Row locks on whatever the branches touch, for the duration. That is real: a
 * long simulation over the payment run can block a genuine payment. Hence the
 * deadline, the statement timeout, and the branch cap in engine.js. This is a
 * decision-support path and it yields to production work, never the reverse.
 */

const { pool } = require('../../../config/database');
const observables = require('./observables');
const { applyEffect } = require('./effects');

// A single statement inside the shadow transaction. Deliberately tighter than
// the pool's own timeout: a simulation is not worth a lock held for a minute.
const STATEMENT_TIMEOUT_MS = 8000;
// The whole run, all branches included.
const DEFAULT_DEADLINE_MS = 25000;
// Locks are taken, never waited on for long: a branch that cannot get a row
// immediately is reported as infeasible rather than queueing behind real work.
const LOCK_TIMEOUT_MS = 2000;

/**
 * Run `fn(session)` inside a guaranteed-rollback transaction.
 *
 * `session` exposes exactly two operations — measure the world, and run a
 * branch — because those are the only two things a caller has any business
 * doing with a connection that is going to be thrown away.
 */
async function withShadow({ companyId, userId, deadlineMs = DEFAULT_DEADLINE_MS }, fn) {
  const client = await pool.connect();
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt > deadlineMs;

  try {
    // The pool's connect wrapper attaches SET LOCAL app.current_company_id to
    // this BEGIN when company isolation is on, so the shadow transaction is
    // scoped to the same tenant as the request that asked for it.
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    // Belt and braces against a future effect that tries to persist something
    // out-of-band: nothing in this transaction may outlive it.
    await client.query('SET LOCAL idle_in_transaction_session_timeout = 30000');

    const session = {
      client,
      expired,
      elapsed: () => Date.now() - startedAt,

      /** The state vector as it stands right now on this connection. */
      measure: () => observables.measure(client, companyId),

      /**
       * Apply one branch's effects, measure, and unwind.
       *
       * Returns { measured, applied, apply_error } — never throws for a branch
       * that failed to apply. A branch rejected by a constraint is a genuine
       * answer about that course of action ("the database will not let you do
       * this"), and losing it to an exception would throw away the most useful
       * result the engine can produce.
       */
      async runBranch(branch) {
        const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
        await client.query(`SAVEPOINT ${name}`);
        const applied = [];
        let applyError = null;

        try {
          for (const step of branch.effects || []) {
            if (expired()) throw new Error('Simulation deadline reached before this step ran');
            applied.push(await applyEffect(client, companyId, step, { userId }));
          }
          const measured = await observables.measure(client, companyId);
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          return { measured, applied, apply_error: null };
        } catch (err) {
          applyError = err?.message || String(err);
          // The savepoint survives a failed statement — that is what savepoints
          // are for — so this unwinds cleanly even from an aborted subtxn.
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
          return { measured: null, applied, apply_error: applyError };
        } finally {
          await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
        }
      },
    };

    return await fn(session);
  } finally {
    // The only transaction-ending statement in this module.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

module.exports = { withShadow, STATEMENT_TIMEOUT_MS, DEFAULT_DEADLINE_MS };
