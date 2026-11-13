/**
 * Files a person brings into a conversation.
 *
 * WHY THESE ARE NOT KNOWLEDGE-BASE DOCUMENTS
 * ---------------------------------------------------------------------------
 * The knowledge base is the company's standing reference: policies, manuals,
 * contracts. Uploading there is an administrative act, it is embedded, and it
 * changes what the assistant knows for everybody, permanently.
 *
 * An attachment is the opposite. It belongs to one conversation, it is usually
 * a one-off ("here's the supplier's quote, does it match our PO?"), and it
 * should not silently become company knowledge because someone dropped it into
 * a chat. So attachments live beside the conversation and are readable by
 * tools for as long as that conversation exists.
 *
 * WHY THEY LIVE IN POSTGRES
 * ---------------------------------------------------------------------------
 * They used to live in a process-local Map: extracted text keyed by session,
 * LRU-capped, wiped on any restart. A restart is exactly what a deploy is on
 * this stack, so a file attached before one was gone when the person asked
 * about it afterwards — the model truthfully said "the file is not available
 * to me" for a file the person had just attached. The conversation itself was
 * made durable the same way (migration 136 replaced an in-process Map with
 * the conversations table), and attachments are per-conversation data with
 * the same lifetime as the conversation. Migration 202608310100 gives them a
 * table (conversation_attachments); this module reads and writes it.
 *
 * WHAT IS STORED AND WHERE
 * ---------------------------------------------------------------------------
 * Text is extracted at upload rather than at read time. A PDF that cannot be
 * parsed fails while the person is still looking at the upload, which is the
 * only moment they can do anything about it. The extracted text is capped at
 * MAX_CHARS so a row is bounded; `characters` records the true length and
 * `truncated` says whether the cap bit, so the model knows it has not seen
 * the whole file.
 */

const { pool } = require('../../config/database');
const ConversationService = require('../conversationService');
const knowledgeBase = require('./knowledgeBase');
const { decodeText } = require('./textEncoding');

// The table arrives with migration 202608310100. Code reaches production
// before a migration does — that is the normal order of a deploy — so until
// the migration lands, attachments should behave as "nothing attached" rather
// than fail the whole chat with "relation does not exist". Mirrors the
// workspace-memory probe in conversationService.js: a positive is cached for
// the life of the process, a negative re-checked at most once a minute so
// running the migration takes effect without a restart.
let tableReady = null;
let lastProbe = 0;
const RECHECK_MS = 60_000;

async function hasTable() {
  if (tableReady) return true;
  if (tableReady === false && Date.now() - lastProbe < RECHECK_MS) return false;
  lastProbe = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables
                       WHERE table_schema = 'public'
                         AND table_name = 'conversation_attachments')`
    );
    tableReady = rows[0]?.exists === true;
  } catch {
    tableReady = false;
  }
  return tableReady;
}

const EXT_TO_FORMAT = {
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html',
  txt: 'text', log: 'text', csv: 'text', tsv: 'text', json: 'text',
  xml: 'text', yml: 'text', yaml: 'text', sql: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', bmp: 'image',
};

const EXT_TO_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp',
};

/** How much original image data may be kept as a preview. Bigger → icon only. */
const PREVIEW_MAX_SIZE = 3 * 1024 * 1024;

/** How much of one file the model may be shown. */
const MAX_CHARS = 40000;
/** How many files one conversation may hold; the oldest are dropped first. */
const MAX_PER_SESSION = 6;

function formatOf(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  return EXT_TO_FORMAT[ext] || null;
}

/**
 * The owning conversation for a session, resolved through the user.
 *
 * session_id is client-supplied and only unique per user (UNIQUE (user_id,
 * session_id) on conversations), so reads are scoped by both — the same gate
 * the chat routes use, which is what keeps one user's files out of another's
 * tools even if a session id were ever guessed.
 */
async function conversationId(sessionId, userId) {
  if (!sessionId || !userId) return null;
  const { rows } = await pool.query(
    'SELECT id FROM conversations WHERE user_id = $1 AND session_id = $2',
    [userId, sessionId]
  );
  return rows[0]?.id || null;
}

/** Drop the oldest rows once a conversation passes MAX_PER_SESSION. */
async function capSession(conversationId) {
  await pool.query(
    `DELETE FROM conversation_attachments a
      WHERE a.conversation_id = $1
        AND a.id NOT IN (
          SELECT id FROM conversation_attachments
           WHERE conversation_id = $1
           ORDER BY created_at DESC
           LIMIT ${MAX_PER_SESSION}
        )`,
    [conversationId]
  );
}

/**
 * A cover image for the chat UI, captured at upload while the bytes are here.
 * Images keep their own bytes (bounded); scanned PDFs contribute their first
 * embedded page image (the same extraction OCR uses). Anything else, or any
 * failure, yields null — a missing preview must never fail the upload.
 */
async function makePreview(file, format) {
  try {
    if (format === 'image' && file.size <= PREVIEW_MAX_SIZE) {
      const ext = String(file.originalname).split('.').pop()?.toLowerCase();
      return { buffer: file.buffer, mime: EXT_TO_MIME[ext] || 'image/png' };
    }
    if (format === 'pdf') {
      const { extractPageImages } = require('./visionOcr');
      const pages = await extractPageImages(file.buffer, [1]);
      const first = pages[0];
      if (first && first.buffer && first.buffer.length <= PREVIEW_MAX_SIZE) {
        const { sniffMime } = require('./visionOcr');
        return { buffer: first.buffer, mime: sniffMime(first.buffer) };
      }
    }
  } catch (err) {
    console.error('Could not build attachment preview:', err.message);
  }
  return null;
}

/**
 * Take a file into a conversation.
 *
 * @returns {{id, name, format, bytes, characters, truncated, at, has_preview}}
 * @throws when the type is unsupported or the content cannot be read — both
 *         while the person is still at the upload, not later in an answer.
 */
async function add({ sessionId, userId, companyId, file }) {
  if (!(await hasTable())) {
    throw new Error(
      'Attachments need a database migration that has not been applied yet. '
      + 'Run `node scripts/db-migrate.js` on the server; the conversation itself is unaffected.',
    );
  }

  const format = formatOf(file.originalname);
  if (!format) {
    throw new Error(
      `Simeli cannot read "${file.originalname}". Supported: PDF, text, Markdown, HTML, CSV, JSON, XML, YAML, SQL.`,
    );
  }

  let text;
  try {
    text = await knowledgeBase.extractText({
      format,
      // PDFs and images are binary — the buffer goes through, never a text
      // reinterpretation. For genuine text, decodeText tries UTF-8 first and
      // only falls back to Windows-1250 when the bytes are not valid UTF-8 —
      // a plain .toString('utf8') would instead silently turn every
      // non-UTF-8 byte into U+FFFD, mangling any accented text.
      content: format === 'pdf' || format === 'image' ? undefined : decodeText(file.buffer),
      buffer: format === 'pdf' || format === 'image' ? file.buffer : undefined,
    });
  } catch (err) {
    throw new Error(`Could not read "${file.originalname}": ${err.message}`);
  }

  if (!text || !text.trim()) {
    throw new Error(
      `"${file.originalname}" has no readable text. For a scanned PDF or photo, OCR was attempted and could not read it — `
      + 'check that the scan is in focus, legible, and not upside down.',
    );
  }

  const truncated = text.length > MAX_CHARS;
  const preview = await makePreview(file, format);
  const conv = await ConversationService.findOrCreate({ userId, sessionId, companyId });
  const { rows: [row] } = await pool.query(
    `INSERT INTO conversation_attachments
       (conversation_id, name, format, bytes, characters, truncated, text, preview, preview_mime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, name, format, bytes, characters, truncated, created_at, preview, preview_mime`,
    [conv.id, file.originalname, format, file.size, text.length, truncated,
     truncated ? text.slice(0, MAX_CHARS) : text,
     preview ? preview.buffer : null, preview ? preview.mime : null]
  );

  // Keep the conversation's own cap; a failed cleanup should not fail the
  // upload — the file is already stored, and the next attach retries.
  capSession(conv.id).catch((err) => {
    console.error(`Could not cap attachments for conversation ${conv.id}:`, err.message);
  });

  return summarise(row);
}

const summarise = (r) => ({
  id: r.id, name: r.name, format: r.format, bytes: r.bytes,
  characters: r.characters, truncated: r.truncated,
  has_preview: !!(r.preview && r.preview_mime),
  at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
});

/** The stored cover image for one attachment, or null. */
async function preview({ sessionId, userId, id }) {
  if (!(await hasTable())) return null;
  const convId = await conversationId(sessionId, userId);
  if (!convId) return null;
  const { rows: [row] } = await pool.query(
    'SELECT preview, preview_mime FROM conversation_attachments WHERE id = $1 AND conversation_id = $2',
    [id, convId]
  );
  if (!row || !row.preview || !row.preview_mime) return null;
  return { buffer: row.preview, mime: row.preview_mime };
}

async function list({ sessionId, userId }) {
  if (!(await hasTable())) return [];
  const id = await conversationId(sessionId, userId);
  if (!id) return [];
  const { rows } = await pool.query(
    `SELECT id, name, format, bytes, characters, truncated, created_at
       FROM conversation_attachments
      WHERE conversation_id = $1
      ORDER BY created_at ASC`,
    [id]
  );
  return rows.map(summarise);
}

/**
 * The full record (including extracted text) for the model's read_attachment.
 * Returns the most recent file when no name is given, else by id, exact name,
 * or name substring — in that order of specificity.
 */
async function read({ sessionId, userId, idOrName }) {
  if (!(await hasTable())) return null;
  const id = await conversationId(sessionId, userId);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT id, name, format, bytes, characters, truncated, text, created_at
       FROM conversation_attachments
      WHERE conversation_id = $1
      ORDER BY created_at DESC`,
    [id]
  );
  if (!rows.length) return null;
  if (!idOrName) return rows[0];
  const needle = String(idOrName).toLowerCase();
  return rows.find((r) => r.id === idOrName)
    || rows.find((r) => r.name.toLowerCase() === needle)
    || rows.find((r) => r.name.toLowerCase().includes(needle))
    || null;
}

async function remove({ sessionId, userId, id }) {
  if (!(await hasTable())) return false;
  const convId = await conversationId(sessionId, userId);
  if (!convId) return false;
  const { rowCount } = await pool.query(
    'DELETE FROM conversation_attachments WHERE id = $1 AND conversation_id = $2',
    [id, convId]
  );
  return rowCount > 0;
}

/**
 * The line put in front of the model when a conversation has files.
 *
 * Names them and says how to read them rather than pasting the contents into
 * every turn — a 40,000-character file re-sent on each message would eat the
 * context window and cost real money per turn for a file nobody asked about.
 */
async function contextLine({ sessionId, userId }) {
  const files = await list({ sessionId, userId });
  if (!files.length) return '';
  return `The person has attached ${files.length} file${files.length === 1 ? '' : 's'} to this conversation: `
    + files.map((f) => `"${f.name}" (${f.format}, ${f.characters.toLocaleString()} characters`
      + `${f.truncated ? ', truncated' : ''})`).join(', ')
    + '. Call read_attachment to see the contents. Do not answer questions about a file you have not read.';
}

const attachmentTools = [
  {
    name: 'read_attachment',
    description:
      'Read a file the person attached to this conversation. Omit "name" for the most recent one, or give a file '
      + 'name to pick a specific one.\n\n'
      + 'You are told which files exist but never their contents until you call this — so read before you answer '
      + 'anything about a file. A long file comes back truncated and says so; say so too rather than implying you '
      + 'have seen all of it.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name or id. Omit for the most recently attached.' },
      },
    },
    handler: async (args, ctx) => {
      const found = await read({ sessionId: ctx.sessionId, userId: ctx.userId, idOrName: args.name });
      if (!found) {
        const have = await list({ sessionId: ctx.sessionId, userId: ctx.userId });
        return {
          error: have.length
            ? `No attachment matches "${args.name}". Attached: ${have.map((f) => f.name).join(', ')}.`
            : 'Nothing is attached to this conversation yet. Ask the person to attach the file '
              + 'before asking about its contents.',
        };
      }
      return {
        name: found.name,
        format: found.format,
        characters: found.characters,
        truncated: found.truncated,
        content: found.text,
      };
    },
  },
];

module.exports = { add, list, read, remove, preview, contextLine, attachmentTools, formatOf, MAX_CHARS };
