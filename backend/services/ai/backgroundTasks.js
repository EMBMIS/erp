/**
 * Ad-hoc background tasks — one-time, throwaway agent sub-runs.
 *
 * See migration 127 for the full design rationale. In short: the chat agent
 * calls propose_background_task (services/ai/metaTools.js) when it judges a
 * sub-task separable from the current reply. That tool is markedAlwaysConfirm
 * in the registry, so it never runs without a person approving it first —
 * once approved, THIS module actually executes it, unattended, capped so it
 * cannot escalate itself past what was approved.
 */

const { pool } = require('../../config/database');

const BACKGROUND_MODE = 'accept_edits';

/**
 * Tool handler for propose_background_task. Creates the task row and kicks
 * off execution without waiting for it — the chat turn that approved this
 * must return immediately, not block on however long the sub-task takes.
 */
async function proposeTask({ title, description }, ctx = {}) {
  if (!title || !description) throw new Error('A background task needs both a title and a description of what to do.');

  const { rows } = await pool.query(
    `INSERT INTO background_tasks (title, description, created_by, mode)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [String(title).slice(0, 200), String(description), ctx.userId || null, BACKGROUND_MODE]
  );
  const taskId = rows[0].id;

  // Fire-and-forget. Errors inside runBackgroundTask are already caught and
  // written to the row; this catch is only for a failure to even start it.
  runBackgroundTask(taskId, ctx).catch((err) => {
    console.error(`Background task ${taskId} could not start:`, err.message);
    pool.query(
      `UPDATE background_tasks SET status = 'failed', error = $2, finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [taskId, err.message]
    ).catch(() => {});
  });

  return {
    task_id: taskId,
    title,
    status: 'queued',
    note: 'Running in the background now. Check "Background tasks" for progress, or ask me about it later.',
  };
}

async function appendLog(taskId, entry) {
  try {
    await pool.query(
      `UPDATE background_tasks SET steps_log = steps_log || $2::jsonb WHERE id = $1`,
      [taskId, JSON.stringify([{ ...entry, at: new Date().toISOString() }])]
    );
  } catch (err) {
    console.error(`Could not append background task log for ${taskId}:`, err.message);
  }
}

/**
 * Runs the sub-task as a fresh, history-less agent turn. Deliberately capped
 * at BACKGROUND_MODE ('accept_edits') regardless of what mode the parent
 * conversation was in: nobody is watching this run, so if it hits a
 * highImpact tool that would need a live confirmation, the right behaviour is
 * to stop and say so — not to wait forever for a confirmation that will never
 * arrive, and not to silently escalate to auto-approving it either.
 */
async function runBackgroundTask(taskId, ctx = {}) {
  await pool.query(`UPDATE background_tasks SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = $1`, [taskId]);

  const { rows } = await pool.query('SELECT * FROM background_tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) return;

  const toolsUsed = [];
  const onEvent = (event) => {
    // Only high-level events are persisted — raw token deltas are noise once
    // nobody is reading them live, and step_end carries no information a
    // human checking back later would act on.
    if (event.type === 'tool_call') {
      toolsUsed.push({ name: event.name, args: event.args });
      appendLog(taskId, { type: 'tool_call', name: event.name, args: event.args });
    } else if (event.type === 'tool_result') {
      appendLog(taskId, { type: 'tool_result', name: event.name, ok: event.ok, error: event.error });
    } else if (event.type === 'tool_denied') {
      appendLog(taskId, { type: 'tool_denied', name: event.name });
    }
  };

  try {
    const { runAgent } = require('./agent');
    const result = await runAgent(
      task.description,
      { userId: task.created_by, actor: 'background-task', role: ctx.role || 'USER', companyId: task.company_id || ctx.companyId },
      [],
      BACKGROUND_MODE,
      onEvent
    );

    if (result.status === 'awaiting_confirmation') {
      await pool.query(
        `UPDATE background_tasks
            SET status = 'blocked', pending_tools = $2::jsonb, tools_used = $3::jsonb, finished_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [taskId, JSON.stringify(result.pending), JSON.stringify(toolsUsed)]
      );
      return;
    }

    await pool.query(
      `UPDATE background_tasks
          SET status = 'done', result_summary = $2, tools_used = $3::jsonb, finished_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [taskId, result.response, JSON.stringify(toolsUsed)]
    );
  } catch (err) {
    await pool.query(
      `UPDATE background_tasks
          SET status = 'failed', error = $2, tools_used = $3::jsonb, finished_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [taskId, err.message, JSON.stringify(toolsUsed)]
    );
  }
}

/** Tasks a user has proposed, most recent first — the "what did I ask the AI to run" view. */
async function listTasksForUser(userId, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, title, status, result_summary, error, pending_tools, tools_used, created_at, started_at, finished_at
       FROM background_tasks WHERE created_by = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(Number(limit) || 20, 1), 100)]
  );
  return rows;
}

module.exports = { proposeTask, listTasksForUser };
