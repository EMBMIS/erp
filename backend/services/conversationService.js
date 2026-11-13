/**
 * Conversation persistence — replaces the in-memory Map in ai-chat.js.
 *
 * Conversations are scoped by user_id. Messages store full records: role,
 * content, tool_calls, tool_results, artifacts, token counts.
 *
 * Token-budgeted context: when history exceeds the budget, older turns
 * are rolled into an LLM-written summary pinned at the top.
 */

const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { indexDocument } = require('./ai/documentSearch');

/**
 * Fire-and-forget embed of one message into document_embeddings, so any past
 * turn (from any conversation) becomes findable via search_documents /
 * ragRetrieval.js — not just the structured conversation history. Not
 * awaited: embedding is local but still real work, and a chat turn saving
 * successfully must never depend on it. Only user/assistant turns with real
 * text; tool-call-only turns and raw tool-result rows are not prose worth
 * embedding.
 */
function indexMessage(msg) {
  if (!msg.content || !['user', 'assistant'].includes(msg.role)) return;
  indexDocument({ source_type: 'chat_message', source_id: msg.id, text: msg.content }).catch((err) => {
    console.error(`ConversationService: failed to auto-index message ${msg.id}:`, err.message);
  });
}

// Rough token estimator: ~4 chars per token for English text.
function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text === 'object') text = JSON.stringify(text);
  return Math.ceil(String(text).length / 4);
}

// Default context budget (env-overridable).
const CONTEXT_TOKEN_BUDGET = parseInt(process.env.AI_CONTEXT_TOKENS) || 16000;

/**
 * Is the workspace-memory migration in?
 *
 * `objective`, `modules`, `entities`, `actions`, `pinned` and `last_stage` came
 * with 202608230100_simeli_workspace_memory.sql. Code reaches production before
 * a migration does — that is the normal order of a deploy, not a mistake — and
 * until now the gap took the whole conversation list down with it: one
 * `ORDER BY c.pinned` against a table without the column and the sidebar was
 * empty with no way to tell why.
 *
 * So ask the catalogue once, cheaply, and shape the queries around the answer.
 * A positive is cached for the life of the process because columns do not
 * disappear; a negative is re-checked at most once a minute, so running the
 * migration takes effect without a restart.
 */
const WORKSPACE_COLUMNS = ['objective', 'modules', 'entities', 'actions', 'pinned', 'last_stage'];
const RECHECK_MS = 60_000;
let workspaceReady = null;
let lastProbe = 0;

async function hasWorkspaceMemory() {
  if (workspaceReady) return true;
  if (workspaceReady === false && Date.now() - lastProbe < RECHECK_MS) return false;
  lastProbe = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'conversations' AND column_name = ANY($1::text[])`,
      [WORKSPACE_COLUMNS]
    );
    workspaceReady = rows.length === WORKSPACE_COLUMNS.length;
  } catch {
    // Cannot see the catalogue: assume the narrower schema rather than issuing
    // a query that would fail outright.
    workspaceReady = false;
  }
  if (!workspaceReady) {
    console.warn(
      'ConversationService: workspace-memory columns are missing — run '
      + '`node scripts/db-migrate.js`. Conversations still work; objectives, '
      + 'pinning and the investigation trail are off until then.'
    );
  }
  return workspaceReady;
}

class ConversationService {
  // -------------------------------------------------------------------
  // Conversation CRUD
  // -------------------------------------------------------------------

  static async findOrCreate({ userId, sessionId, companyId }) {
    const { rows } = await pool.query(
      'SELECT * FROM conversations WHERE user_id = $1 AND session_id = $2',
      [userId, sessionId]
    );
    if (rows.length) return rows[0];

    const id = uuidv4();
    const { rows: [conv] } = await pool.query(
      `INSERT INTO conversations (id, user_id, company_id, session_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, userId, companyId || null, sessionId]
    );
    return conv;
  }

  static async listForUser(userId) {
    const ordering = await hasWorkspaceMemory()
      ? 'c.pinned DESC, c.updated_at DESC'
      : 'c.updated_at DESC';
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(cm.id)::int AS message_count
         FROM conversations c
         LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id
        WHERE c.user_id = $1
        GROUP BY c.id
        ORDER BY ${ordering}
        LIMIT 50`,
      [userId]
    );
    return rows;
  }

  /** Whether pinning, objectives and the investigation trail are available. */
  static workspaceMemoryReady() {
    return hasWorkspaceMemory();
  }

  // -------------------------------------------------------------------
  // Workspace memory
  //
  // A conversation is an investigation, not a chat log: which modules it
  // touched, which records it looked at, what it actually did. All three are
  // accumulated from the tool stream (see services/ai/agentNarration.js), so
  // the workspace panel is a record of what happened rather than a claim about
  // it. Nothing here is written by the model.
  // -------------------------------------------------------------------

  /**
   * Fold one turn's tool activity into the conversation's memory.
   *
   * @param turn.modules  module names whose tools executed this turn
   * @param turn.entities [{type, label, id, module}] records the tools returned
   * @param turn.actions  [{name, verb, module, state}] write tools that ran
   * @param turn.stage    furthest stage the loop reached
   *
   * Best-effort by design: this runs after the answer has already been sent,
   * and a failure to record the trail must never turn a completed turn into a
   * failed one.
   */
  static async recordTurn(conversationId, turn = {}) {
    const modules = [...new Set((turn.modules || []).filter(Boolean))];
    const entities = (turn.entities || []).filter((e) => e && e.label);
    const actions = (turn.actions || []).filter((a) => a && a.name);
    if (!modules.length && !entities.length && !actions.length && !turn.stage) return;
    if (!await hasWorkspaceMemory()) return;

    try {
      // Merged in SQL rather than read-modify-write: two turns of the same
      // conversation can finish out of order (one paused for approval, one
      // did not), and last-write-wins would drop whichever landed first.
      //
      // Entities and actions are capped. A conversation that reads two
      // thousand invoices should show the most recent handful and a count,
      // not carry two thousand rows in a JSONB column forever.
      await pool.query(
        `UPDATE conversations SET
           modules = ARRAY(SELECT DISTINCT unnest(modules || $2::text[])),
           entities = (
             SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (
               SELECT DISTINCT ON (e->>'label', e->>'type') e
                 FROM jsonb_array_elements($3::jsonb || entities) AS e
                LIMIT 60
             ) AS deduped
           ),
           actions = (
             SELECT COALESCE(jsonb_agg(a), '[]'::jsonb) FROM (
               SELECT a FROM jsonb_array_elements(actions || $4::jsonb) AS a LIMIT 40
             ) AS capped
           ),
           last_stage = COALESCE($5, last_stage),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [conversationId, modules, JSON.stringify(entities), JSON.stringify(actions), turn.stage || null]
      );
    } catch (err) {
      console.error(`ConversationService: could not record turn for ${conversationId}:`, err.message);
    }
  }

  /** The conversation plus its accumulated investigation record. */
  static async getWorkspace(userId, sessionId) {
    const { rows: [conv] } = await pool.query(
      `SELECT c.*, COUNT(cm.id)::int AS message_count
         FROM conversations c
         LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id
        WHERE c.user_id = $1 AND c.session_id = $2
        GROUP BY c.id`,
      [userId, sessionId]
    );
    if (!conv) return null;

    // Artifacts are stored per message; the workspace wants them as one list.
    const { rows: artifactRows } = await pool.query(
      `SELECT artifacts, created_at FROM conversation_messages
        WHERE conversation_id = $1 AND artifacts IS NOT NULL
        ORDER BY created_at DESC LIMIT 20`,
      [conv.id]
    );
    const artifacts = artifactRows.flatMap((r) => (Array.isArray(r.artifacts) ? r.artifacts : []));

    return { ...conv, artifacts };
  }

  static async updateObjective(conversationId, objective, userId) {
    const { rows: [c] } = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]
    );
    if (!c) throw new Error('Conversation not found');
    if (!await hasWorkspaceMemory()) throw new Error('WORKSPACE_MEMORY_PENDING');
    const text = objective === null || objective === undefined ? null : String(objective).slice(0, 500);
    await pool.query(
      'UPDATE conversations SET objective = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [text, conversationId]
    );
  }

  static async setPinned(conversationId, pinned, userId) {
    const { rows: [c] } = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]
    );
    if (!c) throw new Error('Conversation not found');
    if (!await hasWorkspaceMemory()) throw new Error('WORKSPACE_MEMORY_PENDING');
    await pool.query('UPDATE conversations SET pinned = $1 WHERE id = $2', [!!pinned, conversationId]);
  }

  static async updateTitle(conversationId, title, userId) {
    // Verify ownership
    const { rows: [c] } = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]
    );
    if (!c) throw new Error('Conversation not found');
    await pool.query('UPDATE conversations SET title = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [title, conversationId]);
  }

  static async deleteConversation(conversationId, userId) {
    const { rows: [c] } = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]
    );
    if (!c) throw new Error('Conversation not found');
    await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
  }

  // -------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------

  static async addMessage(conversationId, { role, content, tool_calls, tool_results, artifacts, token_count, model, attachment_info }) {
    const { rows: [msg] } = await pool.query(
      `INSERT INTO conversation_messages (conversation_id, role, content, tool_calls, tool_results, artifacts, token_count, model, attachment_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [conversationId, role, content || null, tool_calls ? JSON.stringify(tool_calls) : null,
       tool_results ? JSON.stringify(tool_results) : null, artifacts ? JSON.stringify(artifacts) : null,
       token_count || null, model || null, attachment_info ? JSON.stringify(attachment_info) : null]
    );
    await pool.query('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [conversationId]);
    indexMessage(msg);
    return msg;
  }

  /**
   * Get messages for the agent, respecting the token budget.
   *
   * Strategy:
   * 1. System prompt always stays (caller prepends it).
   * 2. If all messages fit within the budget, return them all.
   * 3. If they don't fit, roll the oldest turns into a summary,
   *    pinned as the first user message after the system prompt.
   *
   * Tool calls and results are kept with their parent assistant/user
   * messages as atomic units — a turn is never split.
   */
  static async getMessagesForAgent(conversationId, tokenBudget = CONTEXT_TOKEN_BUDGET) {
    const { rows } = await pool.query(
      'SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId]
    );
    if (rows.length === 0) return { messages: [], summary: null, totalTokens: 0 };

    // Count tokens for the full history.
    let totalTokens = 0;
    for (const m of rows) {
      totalTokens += estimateTokens(m.content);
      if (m.tool_calls) totalTokens += estimateTokens(m.tool_calls);
      if (m.tool_results) totalTokens += estimateTokens(m.tool_results);
    }

    // If everything fits within 70% of budget (leaving room for the response),
    // return the full clean history without tool internals on old messages.
    if (totalTokens < tokenBudget * 0.7) {
      const clean = cleanMessages(rows);
      return { messages: clean, summary: null, totalTokens: Math.round(totalTokens) };
    }

    // Overflow: roll oldest messages into a summary.
    // Find the split point where budget allows the most recent turns.
    let runningTokens = 0;
    let splitIdx = rows.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i];
      const turnTokens = estimateTokens(m.content) + estimateTokens(m.tool_calls) + estimateTokens(m.tool_results);
      if (runningTokens + turnTokens > tokenBudget * 0.6) { splitIdx = i + 1; break; }
      runningTokens += turnTokens;
    }

    const recentMessages = cleanMessages(rows.slice(splitIdx));
    const summary = await this.generateSummary(rows.slice(0, splitIdx));

    return { messages: recentMessages, summary, totalTokens: Math.round(runningTokens + estimateTokens(summary)) };
  }

  /**
   * Ask the model to summarise old turns into a compact paragraph.
   * Called when context overflows. Result is cached for this conversation.
   */
  static async generateSummary(oldMessages) {
    if (oldMessages.length === 0) return null;
    const text = oldMessages
      .map(m => `${m.role}: ${(m.content || '').slice(0, 300)}${m.tool_calls ? ' [used tools: ' + m.tool_calls.map(t => t.name || t.function?.name).filter(Boolean).join(', ') + ']' : ''}`)
      .join('\n');

    try {
      const { getAIClient, AI_MODEL_FAST } = require('../config/aiConfig');
      const client = getAIClient();
      const response = await client.chat.completions.create({
        model: AI_MODEL_FAST,
        messages: [
          { role: 'system', content: 'Summarise this conversation history into 2-4 sentences. Keep specific numbers, names, and decisions. The summary replaces the full history in context, so be precise.' },
          { role: 'user', content: text.slice(0, 3000) },
        ],
        temperature: 0.2,
        max_tokens: 250,
      });
      return response.choices?.[0]?.message?.content || null;
    } catch {
      return null; // summary generation failure is non-fatal
    }
  }

  // -------------------------------------------------------------------
  // Auto-title from first turn
  // -------------------------------------------------------------------

  static async autoTitle(conversationId, firstMessage) {
    const title = String(firstMessage || '').slice(0, 80).replace(/\n/g, ' ') || 'New conversation';
    await pool.query('UPDATE conversations SET title = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND title IS NULL', [title, conversationId]);
  }
}

/**
 * Clean a message for the agent, producing the exact format the OpenAI
 * chat completions API expects for conversation history.
 *
 * - User messages: { role: 'user', content }
 * - Assistant messages: { role: 'assistant', content?, tool_calls? }
 * - Tool results: separate { role: 'tool', tool_call_id, content } messages
 *
 * Returns an ARRAY — a message with tool_results expands into multiple
 * OpenAI-format messages (one per tool result).
 */
function cleanMessages(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content || '' });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant' };
      if (m.content) msg.content = m.content;
      let validTcs = [];
      if (m.tool_calls) {
        const tcs = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls;
        if (Array.isArray(tcs) && tcs.length) {
          validTcs = tcs.map((tc, idx) => ({
            id: tc.id || tc.tool_call_id || `call_legacy_${m.id || Date.now()}_${idx}`,
            type: 'function',
            function: {
              name: tc.name || tc.function?.name || '',
              arguments: typeof (tc.arguments || tc.function?.arguments) === 'string'
                ? (tc.arguments || tc.function?.arguments)
                : JSON.stringify((tc.arguments || tc.function?.arguments) || {}),
            },
          })).filter(tc => tc.function.name);
          if (validTcs.length) {
            msg.tool_calls = validTcs;
          }
        }
      }
      out.push(msg);

      // OpenAI API requirement: Every tool_call in an assistant message MUST be
      // followed by a role:'tool' message with matching tool_call_id.
      // If historical assistant messages stored tool_calls without separate tool rows,
      // emit matching tool response messages for each tool_call_id.
      if (validTcs.length) {
        const nextRows = rows.slice(i + 1);
        const existingToolCallIds = new Set(
          nextRows.filter(r => r.role === 'tool').map(r => r.tool_call_id || r.id)
        );
        for (const tc of validTcs) {
          if (!existingToolCallIds.has(tc.id)) {
            out.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: true, note: `Executed ${tc.function.name}` }),
            });
          }
        }
      }
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.tool_call_id || m.id || `call_${i}`,
        content: typeof m.content === 'object' ? JSON.stringify(m.content) : String(m.content || ''),
      });
    }
  }
  return out;
}

/**
 * Keep tool results informative but bounded.
 * - Scalar/string results under 500 chars: return as-is.
 * - Large strings: first 500 chars + truncation note.
 * - Objects with rows > 5: keep first 3 rows + count.
 * - Objects with rows <= 5: return as-is.
 */
function truncateToolResult(result) {
  if (result === null || result === undefined) return result;
  if (typeof result === 'string') {
    return result.length > 500 ? result.slice(0, 500) + '…' : result;
  }
  if (typeof result === 'object' && result.rows && Array.isArray(result.rows)) {
    if (result.rows.length > 5) {
      return { ...result, rows: result.rows.slice(0, 3), _truncated: `${result.rows.length} total rows, showing first 3` };
    }
    return result;
  }
  if (typeof result === 'object') {
    const s = JSON.stringify(result);
    if (s.length > 500) return JSON.parse(s.slice(0, 500) + '…"}');
  }
  return result;
}

module.exports = ConversationService;
