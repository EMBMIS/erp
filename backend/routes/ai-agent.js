const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const { isAIEnabled } = require('../config/aiConfig');
const { runAgent, resumeAgent, MODES, DEFAULT_MODE } = require('../services/ai/agent');
const { pool } = require('../config/database');
const { classifyAiError } = require('../services/ai/errorClassifier');

// Every route in this file requires auth — the agent acts with the caller's
// identity (ctx.userId) and its writes are attributed to them in ai_audit_log.
router.use(auth);

function safeMode(mode) {
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

function safeHistoryOf(history) {
  return Array.isArray(history)
    ? history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-10)
    : [];
}

/**
 * POST /api/ai-agent/message
 * body: { message: string, history?: Array<{role, content}>, mode?: 'manual'|'accept_edits'|'auto'|'bypass' }
 * Returns either { status: 'done', response, tools_used, steps } or
 * { status: 'awaiting_confirmation', pauseId, pending, tools_used, steps }.
 */
router.post('/message', async (req, res) => {
  try {
    const { message, history, mode } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, error: 'message is required' });
    }
    await require('../services/ai/providerKey').fresh().catch(() => undefined)
    if (!isAIEnabled()) {
      return res.json({ success: false, response: 'The AI agent is not configured on this server (no API key set).' });
    }

    const result = await runAgent(message.trim(), { userId: req.user.id, actor: 'ai-agent', role: req.user.role, companyId: req.companyId }, safeHistoryOf(history), safeMode(mode));
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('AI agent error:', error);
    // A problem with the AI provider (key, quota, model, connection) is said as such, so the person in the chat
    // (424, not 502: Cloudflare in front of the site replaces 502 answers with its own error page)
    // knows it is not their question and an administrator knows what to fix. Anything else stays masked.
    const c = classifyAiError(error);
    if (c.code !== 'UNKNOWN') return res.status(c.retryable ? 503 : 424).json({ success: false, error: c.userMessage, code: c.code, expose: true });
    res.status(500).json({ success: false, error: error.message || 'Agent failed' });
  }
});

/**
 * POST /api/ai-agent/confirm
 * body: { pauseId: string, decisions: Array<{tool_call_id, approve}> }
 * Resumes a paused (awaiting_confirmation) run.
 */
router.post('/confirm', async (req, res) => {
  try {
    const { pauseId, decisions } = req.body;
    if (!pauseId || typeof pauseId !== 'string') {
      return res.status(400).json({ success: false, error: 'pauseId is required' });
    }
    // req.user.id is passed so a pause can only be answered by the person it was
    // put to. The decision being recorded is "may this tool run" — it has to be
    // attributable to whoever actually made it.
    const result = await resumeAgent(pauseId, Array.isArray(decisions) ? decisions : [], undefined, req.user.id);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('AI agent confirm error:', error);
    res.status(400).json({ success: false, error: error.message || 'Failed to resume' });
  }
});

/**
 * POST /api/ai-agent/message/stream (SSE)
 * Same contract as /message but streams live progress:
 *   delta | tool_call | tool_result | tool_denied | awaiting_confirmation | done
 */
router.post('/message/stream', async (req, res) => {
  const { message, history, mode } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const sendEvent = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    if (!isAIEnabled()) {
      sendEvent({ type: 'done', status: 'done', response: 'The AI agent is not configured on this server (no API key set).' });
    } else {
      const result = await runAgent(
        message.trim(),
        { userId: req.user.id, actor: 'ai-agent', role: req.user.role, companyId: req.companyId },
        safeHistoryOf(history),
        safeMode(mode),
        sendEvent
      );
      sendEvent({ type: 'done', ...result });
    }
  } catch (error) {
    console.error('AI agent stream error:', error);
    sendEvent({ type: 'done', status: 'done', success: false, response: error.message || 'Agent failed' });
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

/**
 * POST /api/ai-agent/confirm/stream (SSE) — streaming variant of /confirm.
 */
router.post('/confirm/stream', async (req, res) => {
  const { pauseId, decisions } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const sendEvent = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    if (!pauseId || typeof pauseId !== 'string') {
      sendEvent({ type: 'done', status: 'done', success: false, response: 'pauseId is required' });
    } else {
      // A fresh, never-aborted signal: the approved write must COMPLETE even
      // if the browser tab closes mid-stream (see the same reasoning in
      // ai-chat.js — a disconnect stops the writing, not the work).
      const result = await resumeAgent(pauseId, Array.isArray(decisions) ? decisions : [], sendEvent, req.user.id, new AbortController().signal);
      sendEvent({ type: 'done', ...result });
    }
  } catch (error) {
    console.error('AI agent confirm stream error:', error);
    sendEvent({ type: 'done', status: 'done', success: false, response: error.message || 'Failed to resume' });
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

/**
 * GET /api/ai-agent/audit-log
 * Lets a human see exactly what the AI has done. Manager/Admin-adjacent data,
 * but any authenticated user can see actions taken on their own behalf.
 */
router.get('/audit-log', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const mine = req.query.mine !== 'false'; // default: only the caller's own actions
    const params = [];
    let where = '';
    if (mine) { params.push(req.user.id); where = `WHERE user_id = $${params.length}`; }
    params.push(limit);
    const r = await pool.query(
      `SELECT id, actor, user_id, tool_name, arguments, read_only, success, result_summary, error, created_at
       FROM ai_audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, count: r.rows.length, entries: r.rows });
  } catch (error) {
    console.error('AI audit log error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch audit log' });
  }
});

/**
 * GET /api/ai-agent/background-tasks
 * The current user's ad-hoc background tasks (services/ai/backgroundTasks.js),
 * most recent first — the "what did I ask the AI to run" view.
 */
router.get('/background-tasks', async (req, res) => {
  try {
    const { listTasksForUser } = require('../services/ai/backgroundTasks');
    const tasks = await listTasksForUser(req.user.id, { limit: req.query.limit });
    res.json({ success: true, count: tasks.length, tasks });
  } catch (error) {
    console.error('Background tasks list error:', error);
    res.status(500).json({ success: false, error: 'Failed to list background tasks' });
  }
});

/**
 * GET /api/ai-agent/usage
 * Real token usage and estimated USD cost for the AI agent (migration 129 —
 * ai_usage_log), aggregated by day or by user. Manager/Admin only: this can
 * show spend across every user, which is not something an ordinary user
 * should see about others (unlike /audit-log, which is scoped to the caller's
 * own actions by default).
 * query: days (default 30), group_by ('day'|'user', default 'day'), user_id
 * (optional — scope to one user; otherwise covers everyone).
 */
router.get('/usage', requireManagerOrAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { getUsageSummary } = require('../services/ai/usageTracking');
    const summary = await getUsageSummary({
      userId: req.query.user_id || undefined,
      since,
      groupBy: req.query.group_by,
    });
    res.json({ success: true, days, ...summary });
  } catch (error) {
    console.error('AI usage summary error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch AI usage summary' });
  }
});

// ---------------------------------------------------------------------------
// POST /ai-agent/feedback — capture user feedback on AI suggestions.
// Body: { source, source_id, feedback_type, field_name, original_value, corrected_value, notes, rating }
// ---------------------------------------------------------------------------
router.post('/feedback', auth, async (req, res) => {
  try {
    const { source, source_id, feedback_type, field_name, original_value, corrected_value, notes, rating } = req.body;
    if (!source || !feedback_type) {
      return res.status(400).json({ success: false, error: 'source and feedback_type are required.' });
    }
    const validTypes = ['REJECTION', 'CORRECTION', 'OVERRIDE', 'RATING'];
    if (!validTypes.includes(feedback_type)) {
      return res.status(400).json({ success: false, error: `feedback_type must be one of: ${validTypes.join(', ')}` });
    }

    const { rows: [fb] } = await pool.query(
      `INSERT INTO ai_feedback (user_id, feedback_type, source, source_id, field_name, original_value, corrected_value, notes, rating)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [req.user.id, feedback_type, source, source_id || null, field_name || null, original_value || null, corrected_value || null, notes || null, rating || null]
    );
    res.status(201).json({ success: true, data: fb });
  } catch (error) {
    console.error('AI feedback capture error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /ai-agent/feedback — reportable feedback summary (manager/admin)
router.get('/feedback', requireManagerOrAdmin, async (req, res) => {
  try {
    const source = req.query.source;
    const type = req.query.feedback_type;
    let query = 'SELECT * FROM ai_feedback WHERE 1=1';
    const params = [];
    if (source) { params.push(source); query += ` AND source = $${params.length}`; }
    if (type) { params.push(type); query += ` AND feedback_type = $${params.length}`; }
    query += ' ORDER BY created_at DESC LIMIT 200';
    const { rows } = await pool.query(query, params);

    const { rows: [summary] } = await pool.query(
      `SELECT feedback_type, COUNT(*)::int FROM ai_feedback GROUP BY feedback_type ORDER BY count DESC`
    );

    res.json({ success: true, data: rows, total: rows.length, summary: summary ? [summary] : [] });
  } catch (error) {
    console.error('AI feedback fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Intelligent chat routing endpoint
router.post('/route', async (req, res) => {
  try {
    const { routePrompt } = require('../services/intelligentChatRouter');
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: 'prompt is required' });
    const decision = await routePrompt(prompt);
    res.json({ success: true, decision });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/ai-agent/evals-summary - Customer-visible AI evaluation metrics (computed dynamically)
router.get('/evals-summary', async (req, res) => {
  try {
    const { rows: fbRows } = await pool.query(
      `SELECT source, feedback_type, COUNT(*)::int as count
         FROM ai_feedback
        GROUP BY source, feedback_type`
    );

    const { rows: auditRows } = await pool.query(
      `SELECT
          COUNT(*)::int as total,
          SUM(CASE WHEN success = true THEN 1 ELSE 0 END)::int as successful
         FROM ai_audit_log`
    );

    const totalAudit = auditRows[0]?.total || 0;
    const successfulAudit = auditRows[0]?.successful || 0;

    const computeSourceAccuracy = (src) => {
      const srcFeedback = fbRows.filter((r) => r.source === src);
      const total = srcFeedback.reduce((sum, r) => sum + r.count, 0);
      const rejections = srcFeedback.find((r) => r.feedback_type === 'REJECTION')?.count || 0;
      if (total === 0) return totalAudit > 0 ? Number(((successfulAudit / totalAudit) * 100).toFixed(1)) : 100.0;
      return Number((((total - rejections) / total) * 100).toFixed(1));
    };

    const overallAccuracy = totalAudit > 0 ? Number(((successfulAudit / totalAudit) * 100).toFixed(1)) : 100.0;

    res.json({
      success: true,
      data: {
        accuracy_percentage: overallAccuracy,
        invoice_matching_accuracy: `${computeSourceAccuracy('INVOICE_MATCHING')}%`,
        nl_query_accuracy: `${computeSourceAccuracy('NATURAL_LANGUAGE')}%`,
        document_intake_accuracy: `${computeSourceAccuracy('DOCUMENT_INTAKE')}%`,
        total_evaluations: totalAudit + fbRows.reduce((sum, r) => sum + r.count, 0),
        last_eval_run: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// Anomaly detection, Continuous close agent & Preference learning helpers
const AnomalyDetectionService = require('../services/ai/anomalyDetectionService');
const ContinuousCloseAgent = require('../services/ai/continuousCloseAgent');
const PreferenceLearningService = require('../services/ai/preferenceLearningService');

router.get('/anomalies/benford', async (req, res) => {
  try {
    const result = await AnomalyDetectionService.analyzeBenfordLaw();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/continuous-close/sweep', requireManagerOrAdmin, async (req, res) => {
  try {
    const result = await ContinuousCloseAgent.runSweep();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/preferences', async (req, res) => {
  try {
    const prefs = await PreferenceLearningService.getLearnedPreferences();
    res.json({ success: true, data: prefs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Record a correction the user made to something the assistant suggested.
// This is the entry point of the learning loop — the recorded preference is
// injected into the agent's system prompt on every subsequent turn
// (services/ai/agent.js), so the same correction should not be needed twice.
router.post('/preferences', async (req, res) => {
  try {
    const { field_name, original_value, corrected_value, notes } = req.body || {};
    const saved = await PreferenceLearningService.recordOverride({
      fieldName: field_name,
      originalValue: original_value,
      correctedValue: corrected_value,
      notes,
      userId: req.user?.id && !req.user.isApiKey ? req.user.id : null,
    });
    res.json({ success: true, data: saved });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;



