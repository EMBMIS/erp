const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
router.use(auth);
require('dotenv').config();
const { isAIEnabled } = require('../config/aiConfig');
const ConversationService = require('../services/conversationService');
const attachments = require('../services/ai/attachments');

/**
 * AI Chat — persistent conversation memory backed by Postgres.
 *
 * Each conversation is scoped by user_id + session_id. Messages store full
 * records: role, content, tool_calls, tool_results, artifacts, and token
 * counts. When context exceeds the token budget, older turns are rolled
 * into an LLM-written summary.
 */

/**
 * Runs in flight, by conversation.
 *
 * Two jobs. It lets POST /stop reach the AbortController for a run whose HTTP
 * request belongs to a connection the stopper may no longer hold — after a
 * reload, the browser that wants to stop is not the one that started it. And
 * it lets a reconnecting client ask whether their turn is still going, so a
 * refresh mid-answer shows "still working" instead of an empty conversation.
 */
const ACTIVE_RUNS = new Map();

function registerRun(sessionId, controller) {
  // A second run in the same conversation supersedes the first. That can only
  // happen if a client sent again without waiting, and the older answer is of
  // no use to anyone.
  ACTIVE_RUNS.get(sessionId)?.controller.abort();
  ACTIVE_RUNS.set(sessionId, { controller, startedAt: Date.now() });
}

function finishRun(sessionId) {
  ACTIVE_RUNS.delete(sessionId);
}

/**
 * Per-conversation tool results, so a chart can reference what an earlier turn
 * found. Bounded twice — how many conversations, and how many tools each keeps
 * — because this holds real query output and would otherwise grow without end.
 */
const SESSION_RESULTS = new Map();
const MAX_SESSIONS = 50;
const MAX_TOOLS_PER_SESSION = 40;

function sessionResults(sessionId) {
  let bag = SESSION_RESULTS.get(sessionId);
  if (bag) {
    // Re-inserted so the most recently used conversation is last, which is
    // what makes the eviction below least-recently-used rather than arbitrary.
    SESSION_RESULTS.delete(sessionId);
    SESSION_RESULTS.set(sessionId, bag);
    return bag;
  }
  bag = {};
  SESSION_RESULTS.set(sessionId, bag);
  while (SESSION_RESULTS.size > MAX_SESSIONS) {
    SESSION_RESULTS.delete(SESSION_RESULTS.keys().next().value);
  }
  return bag;
}

/** Keep a conversation's bag from growing without limit within one session. */
function trimResults(bag) {
  const names = Object.keys(bag);
  for (let i = 0; i < names.length - MAX_TOOLS_PER_SESSION; i += 1) delete bag[names[i]];
}

// ---------------------------------------------------------------------------
// POST /ai-chat/message/stream — main streaming endpoint
// ---------------------------------------------------------------------------
router.post('/message/stream', async (req, res) => {
  const { message, sessionId, mode } = req.body;
  if (!message || !sessionId) {
    return res.status(400).json({ success: false, error: 'message and sessionId are required.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // The investigation record for this turn, accumulated from the events the
  // agent actually emits. Nothing here is asked of the model: a module appears
  // because one of its tools ran, an entity appears because a tool returned it,
  // an action appears because a write tool executed. See
  // services/ai/agentNarration.js for why the narration is derived.
  const narration = require('../services/ai/agentNarration');
  const turn = { modules: [], entities: [], actions: [], stage: 'understand' };

  /**
   * What tools returned, kept for the whole conversation rather than one turn.
   *
   * render_chart and show_data take { from_tool: "get_ar_aging" } instead of
   * the model retyping rows — the difference between charting the ledger and
   * charting the model's memory of it. Scoped to a single turn, that broke the
   * obvious follow-up: "now chart that" one message later found nothing and
   * the model either re-ran the query or, worse, filled the gap itself.
   *
   * Held in memory per session, capped, and evicted with an LRU. It is a
   * convenience for a live conversation, not a store: a restart loses it and
   * the model simply re-runs the tool, which is correct behaviour rather than
   * a failure.
   */
  const results = sessionResults(sessionId);
  // The visible trace, in order, so reopening this conversation restores what
  // Simeli did rather than only what it said.
  const trace = [];

  const observe = (event) => {
    turn.stage = narration.stageFor(turn.stage, event);

    if (event.type === 'tool_call' && event.meta) {
      turn.modules.push(event.meta.module);
      trace.push({ name: event.name, meta: event.meta, step: event.step, status: 'running' });
      if (['draft', 'act', 'build'].includes(event.meta.kind)) {
        turn.actions.push({
          name: event.name,
          verb: event.meta.verb,
          module: event.meta.module,
          // A tool that reached tool_call has passed whatever gate its mode
          // required: either it never needed approval, or a person granted it.
          state: event.approved ? 'approved' : 'executed',
          at: new Date().toISOString(),
        });
      }
    }

    if (event.type === 'tool_result') {
      trimResults(results);
      const entry = [...trace].reverse().find((x) => x.name === event.name && x.status === 'running');
      if (entry) {
        entry.status = event.ok ? 'done' : 'error';
        entry.error = event.error;
        entry.digest = event.digest;
        entry.chart = event.chart;
        entry.document = event.document;
        // Without this, a table the model deliberately put in front of the
        // reader with show_data was gone the moment they reopened the
        // conversation — the one block it chose to lead with, lost.
        entry.surfaced = event.surfaced;
      }
    }

    if (event.type === 'tool_result' && event.digest) {
      for (const record of event.digest.records || []) {
        turn.entities.push({
          type: event.digest.area,
          module: event.digest.module,
          label: record.label,
          id: record.id,
        });
      }
    }

    if (event.type === 'awaiting_confirmation') {
      for (const pending of event.pending || []) {
        turn.actions.push({
          name: pending.name,
          verb: pending.meta?.verb || pending.name,
          module: pending.meta?.module || 'Data',
          state: 'proposed',
          at: new Date().toISOString(),
        });
      }
    }

    if (event.type === 'tool_denied') {
      turn.actions.push({
        name: event.name,
        verb: event.meta?.verb || event.name,
        module: event.meta?.module || 'Data',
        state: 'denied',
        at: new Date().toISOString(),
      });
    }
  };

  // Stopping and losing the connection are different things.
  //
  // Pressing Stop means "do not do this" — the run should end and no tokens
  // should be spent finishing it. Closing the tab, reloading, or dropping to a
  // tunnel means "I am not watching right now", and the only sane thing is to
  // finish the work and have the answer waiting when they come back.
  //
  // Conflating the two cost the answer entirely: an abort on 'close' killed
  // the run on every refresh, and because the assistant message is only saved
  // at the end, the turn vanished. Reopening the conversation showed the
  // question and no reply, forever.
  //
  // So the connection closing only stops the WRITING. An explicit stop comes
  // through POST /ai-chat/stop, which aborts the registered run.
  const control = new AbortController();
  let clientGone = false;
  registerRun(sessionId, control);

  req.on('close', () => {
    if (res.writableEnded) return;      // normal completion, not an abandonment
    clientGone = true;                  // stop writing; the run carries on
  });

  const sendEvent = (event) => {
    // Nothing to write to once they have gone.
    if (clientGone) return;
    // Observed before it is written: if serialising an event ever throws, the
    // record of what happened should still be right.
    try { observe(event); } catch (err) { console.error('Turn observation failed:', err.message); }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (!isAIEnabled()) {
    sendEvent({ type: 'done', success: false, response: 'The AI assistant is not configured on this server (no API key set).' });
    res.end();
    return;
  }

  try {
    // Find or create the conversation.
    const conv = await ConversationService.findOrCreate({
      userId: req.user.id,
      sessionId,
      companyId: req.companyId || null,
    });

    // Auto-title on first message.
    if (!conv.title) {
      await ConversationService.autoTitle(conv.id, message);
    }

    // The files this message was sent with — the conversation's current
    // attachments, snapshotted so the bubble keeps them even if a file is
    // removed from the conversation later. The files themselves stay attached
    // to the conversation (still in the composer, still readable by later
    // turns); this column is only what the message bubble renders.
    const attached = (await attachments.list({ sessionId, userId: req.user.id })).map((a) => ({
      id: a.id, name: a.name, format: a.format, has_preview: !!a.has_preview,
    }));

    // Save the user message.
    await ConversationService.addMessage(conv.id, {
      role: 'user',
      content: message,
      attachment_info: attached.length ? attached : null,
    });

    // Get messages for the agent (respects token budget, includes summary).
    const { messages, summary } = await ConversationService.getMessagesForAgent(conv.id);

    // Build agent history with summary if present.
    // Names the attached files without pasting them in. A 40,000-character
    // file re-sent every turn would eat the context window and cost real money
    // per message for a file nobody asked about — the model calls
    // read_attachment when it actually needs the contents.
    const attachmentNote = await attachments.contextLine({ sessionId, userId: req.user.id });

    const historyForAgent = [];
    if (attachmentNote) historyForAgent.push({ role: 'user', content: `[${attachmentNote}]` });
    if (summary) {
      historyForAgent.push({ role: 'user', content: `[Previous conversation summary: ${summary}]` });
    }
    historyForAgent.push(...messages);

    // Run the agent.
    const { runAgent } = require('../services/ai/agent');
    const result = await runAgent(
      message,
      {
        userId: req.user.id, actor: 'ai-agent', role: req.user.role || 'USER',
        companyId: req.companyId, signal: control.signal,
        // read_attachment resolves against the conversation it was called in.
        sessionId,
      },
      historyForAgent,
      mode || 'accept_edits',
      sendEvent,
      results,
    );

    if (result.status === 'cancelled') {
      // Recorded, not saved as an answer. What ran is still worth keeping —
      // it is the record of what was touched before the person stopped — but
      // an assistant message with no response is not a turn.
      await ConversationService.recordTurn(conv.id, { ...turn, stage: 'stopped' });
      finishRun(sessionId);
      res.end();
      return;
    }

    if (result.status === 'done') {
      // Save the assistant response. tool_calls stored as the agent returns them.
      await ConversationService.addMessage(conv.id, {
        role: 'assistant',
        content: result.response,
        tool_calls: result.tools_used?.length ? result.tools_used : null,
        // Digests, not raw results: the full payloads are already in the
        // agent's own message history, and a copy of every row a tool returned
        // would make the transcript unbounded.
        tool_results: trace.length ? trace : null,
        token_count: result.steps || null,
        model: result.model || null,
      });

      sendEvent({
        type: 'done', success: true, response: result.response, toolsUsed: result.tools_used,
        conversationId: sessionId, stage: 'report',
        // Present only when the turn stopped on its step ceiling. The client
        // turns it into a "keep going" button, which resumes the saved run
        // rather than starting the investigation over.
        continueId: result.continueId,
        truncated: result.truncated || undefined,
      });
    } else {
      sendEvent({
        type: 'done', success: true, response: null, status: 'awaiting_confirmation',
        pauseId: result.pauseId, pending: result.pending, conversationId: sessionId,
        stage: 'await_approval',
      });
    }

    // Awaited so the workspace is current before the client asks for it — the
    // panel refreshes the moment the stream closes, and a fire-and-forget write
    // loses that race often enough to look like the record is not being kept.
    await ConversationService.recordTurn(conv.id, turn);
  } catch (error) {
    console.error('Streaming chat error:', error);
    sendEvent({ type: 'done', success: false, response: error.message || 'AI request failed', error: 'AI_ERROR' });
  } finally {
    // However the turn ended — answered, stopped, or thrown — it is no longer
    // in flight. A stale entry here would make a reconnecting client wait for
    // something that is never coming.
    finishRun(sessionId);
  }

  res.end();
});

// ---------------------------------------------------------------------------
// POST /ai-chat/stop/:sessionId — the user meant it
//
// Separate from the connection closing on purpose. Reloading the page is not
// a decision to abandon the work; pressing Stop is. This is also why it is a
// request in its own right: after a refresh the browser that wants to stop is
// not the one that opened the stream, and it still needs a way to say so.
// ---------------------------------------------------------------------------
router.post('/stop/:sessionId', (req, res) => {
  const run = ACTIVE_RUNS.get(req.params.sessionId);
  if (!run) return res.json({ success: true, stopped: false, reason: 'Nothing is running.' });
  run.controller.abort();
  ACTIVE_RUNS.delete(req.params.sessionId);
  res.json({ success: true, stopped: true });
});

// ---------------------------------------------------------------------------
// GET /ai-chat/state/:sessionId — is a turn still going?
//
// What a page asks after a reload. Without it a refresh mid-answer shows an
// empty conversation and no indication that anything is happening, so the
// natural thing to do is ask again — which starts a second run and wastes the
// first.
// ---------------------------------------------------------------------------
router.get('/state/:sessionId', (req, res) => {
  const run = ACTIVE_RUNS.get(req.params.sessionId);
  res.json({
    success: true,
    data: run
      ? { running: true, startedAt: new Date(run.startedAt).toISOString(), seconds: Math.round((Date.now() - run.startedAt) / 1000) }
      : { running: false },
  });
});

// ---------------------------------------------------------------------------
// GET /ai-chat/history/:sessionId — get conversation messages
// ---------------------------------------------------------------------------
router.get('/history/:sessionId', async (req, res) => {
  try {
    const conv = await ConversationService.findOrCreate({
      userId: req.user.id,
      sessionId: req.params.sessionId,
      // Without this the INSERT that creates a brand-new conversation carries
      // company_id NULL, and the conversations RLS policy (company_id =
      // current_company_id()) rejects exactly that — so opening a fresh chat
      // returned 500 "new row violates row-level security policy" before a
      // single message was sent.
      companyId: req.companyId || null,
    });
    const { rows } = await require('../config/database').pool.query(
      'SELECT role, content, tool_calls, tool_results, artifacts, attachment_info, created_at FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conv.id]
    );
    res.json({ success: true, history: rows, sessionId: req.params.sessionId, conversationId: conv.id });
  } catch (error) {
    console.error('History endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /ai-chat/history/:sessionId — delete conversation
// ---------------------------------------------------------------------------
router.delete('/history/:sessionId', async (req, res) => {
  try {
    const conv = await ConversationService.findOrCreate({
      userId: req.user.id,
      sessionId: req.params.sessionId,
      companyId: req.companyId || null,
    });
    await ConversationService.deleteConversation(conv.id, req.user.id);
    res.json({ success: true, message: 'Conversation deleted' });
  } catch (error) {
    console.error('Delete history error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /ai-chat/conversations — list user's conversations
// ---------------------------------------------------------------------------
router.get('/conversations', async (req, res) => {
  try {
    const list = await ConversationService.listForUser(req.user.id);
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /ai-chat/conversations/:id — rename conversation
// ---------------------------------------------------------------------------
router.patch('/conversations/:id', async (req, res) => {
  try {
    await ConversationService.updateTitle(req.params.id, req.body.title, req.user.id);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /ai-chat/workspace/:sessionId — the investigation record
//
// What the conversation has touched: modules whose tools ran, records those
// tools returned, actions taken and their approval state, artifacts produced.
// All derived from the tool stream — see the `observe` function above.
// ---------------------------------------------------------------------------
router.get('/workspace/:sessionId', async (req, res) => {
  try {
    const workspace = await ConversationService.getWorkspace(req.user.id, req.params.sessionId);
    if (!workspace) {
      // Not an error: a conversation the user has not sent anything in yet has
      // no record, and an empty workspace is the correct answer.
      return res.json({ success: true, data: null });
    }
    res.json({
      success: true,
      data: {
        id: workspace.id,
        sessionId: workspace.session_id,
        title: workspace.title,
        objective: workspace.objective,
        modules: workspace.modules || [],
        entities: workspace.entities || [],
        actions: workspace.actions || [],
        artifacts: workspace.artifacts || [],
        lastStage: workspace.last_stage,
        pinned: workspace.pinned,
        messageCount: workspace.message_count,
        createdAt: workspace.created_at,
        updatedAt: workspace.updated_at,
      },
    });
  } catch (error) {
    console.error('Workspace endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /ai-chat/workspace/:sessionId — the parts a person owns
//
// `objective` is the user's own framing of what the investigation is for, and
// `pinned` keeps it at the top of their list. Neither is derived, because
// neither is something the system can observe.
// ---------------------------------------------------------------------------
router.patch('/workspace/:sessionId', async (req, res) => {
  try {
    const conv = await ConversationService.findOrCreate({
      userId: req.user.id,
      sessionId: req.params.sessionId,
      companyId: req.companyId || null,
    });
    if ('objective' in req.body) {
      await ConversationService.updateObjective(conv.id, req.body.objective, req.user.id);
    }
    if ('pinned' in req.body) {
      await ConversationService.setPinned(conv.id, req.body.pinned, req.user.id);
    }
    if ('title' in req.body && req.body.title) {
      await ConversationService.updateTitle(conv.id, String(req.body.title).slice(0, 200), req.user.id);
    }
    res.json({ success: true });
  } catch (error) {
    if (error.message === 'WORKSPACE_MEMORY_PENDING') {
      return res.status(503).json({
        success: false,
        error: 'Objectives and pinning need a database migration that has not been applied yet. '
          + 'Run `node scripts/db-migrate.js` on the server; the conversation itself is unaffected.',
      });
    }
    res.status(400).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /ai-chat/stages — the agent loop, for the client to render
//
// Served rather than duplicated in the frontend so the two cannot drift: the
// stage a run reports is classified on this side, and a client with a stale
// list of stage keys would silently show nothing for a stage it did not know.
// ---------------------------------------------------------------------------
router.get('/stages', (req, res) => {
  res.json({ success: true, data: require('../services/ai/agentNarration').STAGES });
});

// ---------------------------------------------------------------------------
// POST /ai-chat/feedback — tell Simeli it got something wrong
//
// preferenceLearningService has existed the whole time and nothing in the chat
// fed it, so the assistant could be corrected fifty times and give the same
// answer on the fifty-first. A thumbs-down with a note becomes a company-level
// preference that goes into every later system prompt.
//
// A bare thumbs-up records nothing. "Good answer" is not a preference, and
// writing one per approval would drown the signal that matters.
// ---------------------------------------------------------------------------
router.post('/feedback', async (req, res) => {
  const { sessionId, helpful, note, about } = req.body || {};
  try {
    if (helpful === false && String(note || '').trim()) {
      await require('../services/ai/preferenceLearningService').recordOverride({
        // Scoped by what the correction was about when the client says, so two
        // corrections on different subjects do not overwrite each other.
        fieldName: String(about || 'chat_answer').slice(0, 80),
        correctedValue: String(note).slice(0, 1000),
        notes: sessionId ? `From conversation ${sessionId}` : null,
        userId: req.user.id,
      }, req.companyId || null);
      return res.json({ success: true, learned: true });
    }
    // Recorded as a signal but nothing is learned from it.
    return res.json({ success: true, learned: false });
  } catch (error) {
    console.error('Feedback error:', error.message);
    // Never fail the chat over feedback.
    return res.json({ success: true, learned: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /ai-chat/conversations/search?q= — find a past investigation
//
// The list is fine at ten and useless at two hundred. Searches titles and
// message text, newest first.
// ---------------------------------------------------------------------------
router.get('/conversations/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ success: true, data: [] });
  try {
    // Objectives and the module trail arrive with the workspace-memory
    // migration. Where it has not been applied yet, search the columns that do
    // exist rather than failing the whole query — see conversationService.js.
    const memory = await ConversationService.workspaceMemoryReady();
    const { rows } = await require('../config/database').pool.query(
      `SELECT DISTINCT ON (c.id) c.id, c.session_id, c.title, c.updated_at
              ${memory ? ', c.modules' : ''}
         FROM conversations c
         LEFT JOIN conversation_messages m ON m.conversation_id = c.id
        WHERE c.user_id = $1
          AND (c.title ILIKE $2 ${memory ? 'OR c.objective ILIKE $2' : ''} OR m.content ILIKE $2)
        ORDER BY c.id, c.updated_at DESC
        LIMIT 30`,
      [req.user.id, `%${q}%`],
    );
    rows.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Conversation search error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Attachments — files brought into one conversation
//
// Deliberately not the knowledge base: that is the company's standing
// reference and uploading there changes what Simeli knows for everyone,
// permanently. A file dropped into a chat should not do that. See
// services/ai/attachments.js.
// ---------------------------------------------------------------------------
const multer = require('multer');
const { scopedMulter } = require('../middleware/scopedMulter');
const uploadAttachment = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// scopedMulter: multer's stream completion breaks out of the auth
// middleware's company AsyncLocalStorage scope for multi-chunk bodies, which
// silently dropped the tenant context and made every large upload fail RLS.
router.post('/attachments/:sessionId', scopedMulter(uploadAttachment.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file was uploaded.' });
  try {
    const data = await attachments.add({
      sessionId: req.params.sessionId,
      userId: req.user.id,
      companyId: req.companyId || null,
      file: req.file,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    // 400, not 500: an unreadable file is the person's to fix, and the message
    // says which file and why.
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/attachments/:sessionId', async (req, res) => {
  res.json({ success: true, data: await attachments.list({ sessionId: req.params.sessionId, userId: req.user.id }) });
});

// Cover image for the chat UI (image uploads and scanned-PDF first pages).
// The raw bytes are served with the auth the request already carried; the
// route resolves the row through the user's own conversation, so one user's
// previews are not another's.
router.get('/attachments/:sessionId/:id/preview', async (req, res) => {
  try {
    const found = await attachments.preview({
      sessionId: req.params.sessionId,
      userId: req.user.id,
      id: req.params.id,
    });
    if (!found) {
      return res.status(404).json({ success: false, error: 'No preview for this attachment.' });
    }
    res.setHeader('Content-Type', found.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(found.buffer);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.delete('/attachments/:sessionId/:id', async (req, res) => {
  res.json({ success: true, removed: await attachments.remove({ sessionId: req.params.sessionId, userId: req.user.id, id: req.params.id }) });
});

module.exports = router;
