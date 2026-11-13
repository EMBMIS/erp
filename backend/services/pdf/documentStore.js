/**
 * Storage and provenance for generated documents.
 *
 * A PDF the AI produced has to be fetchable later — from a chat transcript, an
 * agent run, an email that was sent last Monday. The bytes go to disk; the row
 * in `generated_documents` is the permission check and the record of what
 * produced it.
 *
 * Two decisions worth keeping:
 *
 *   • No unguessable-URL tokens. Downloads go through the authenticated API and
 *     are checked against the caller, so a link pasted into a ticket or an email
 *     thread does not silently become a bearer credential for a document that
 *     may contain the AR ledger.
 *   • Paths are derived, never taken from input. The stored path is built from
 *     the row's own UUID, and reads re-derive it rather than trusting the column,
 *     so a bad or tampered value cannot walk out of the documents directory.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../../config/database');
const { currentCompanyId, getDefaultCompanyId } = require('../companyContext');

const DOCUMENTS_DIR = process.env.AI_DOCUMENTS_DIR
  ? path.resolve(process.env.AI_DOCUMENTS_DIR)
  : path.join(__dirname, '../../exports/ai-documents');

function ensureDir() {
  if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
}

// Language name -> file extension, for 'code' artifacts. Falls back to '.txt'
// for anything not listed rather than guessing — an unrecognised extension
// would be more misleading than a plain text file.
const CODE_EXTENSIONS = {
  javascript: 'js', typescript: 'ts', python: 'py', java: 'java', go: 'go',
  rust: 'rs', ruby: 'rb', php: 'php', c: 'c', cpp: 'cpp', csharp: 'cs',
  sql: 'sql', bash: 'sh', shell: 'sh', json: 'json', yaml: 'yml', html: 'html', css: 'css',
};

/** The file extension a stored artifact should carry, from its content_type. */
function extensionFor(contentType, language) {
  switch (contentType) {
    case 'html': return 'html';
    case 'svg': return 'svg';
    case 'markdown': return 'md';
    case 'code': return CODE_EXTENSIONS[String(language || '').toLowerCase()] || 'txt';
    case 'pdf':
    default: return 'pdf';
  }
}

/**
 * A file name safe on every platform, that still resembles the document title.
 *
 * Only characters that are genuinely illegal in a file name are removed —
 * NOT everything outside ASCII. Stripping non-Latin scripts turned every
 * Russian or Vietnamese title into the empty string, so a document called
 * "Отчёт" downloaded as the anonymous "document.pdf". The bytes on disk are
 * named by uuid (see saveDocument), so this value is only ever a display and
 * download name and does not have to survive a file system round trip.
 */
function safeFileName(title, extension = 'pdf') {
  const base = String(title || 'document')
    // Windows-reserved characters, path separators, and control codes.
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    // A leading dot would make the file hidden, or read as an extension.
    .replace(/^\.+/, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '') || 'document';
  return `${base}.${extension}`;
}

/**
 * Persist a rendered artifact — a PDF (the original and still most common
 * case) or, since migration 128, an HTML/SVG/Markdown/code artifact.
 *
 * @param {Buffer} buffer
 * @param {object} meta { title, kind, templateKey, userId, agentRunId, companyId, metadata, expiresInDays, contentType, language }
 * @returns {object} the generated_documents row plus a relative download path
 */
async function saveDocument(buffer, meta = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Refusing to store an empty document.');
  ensureDir();

  // company_id is NOT NULL since migration 141, and a row belonging to no
  // company is invisible to every tenant under RLS. Resolve it the same way
  // withCompany() does, in the same order:
  //   1. explicit (the tool handler's ctx — chat/agent runs pass it down),
  //   2. the ambient AsyncLocalStorage company (scheduled agent runs are
  //      wrapped per-company by forEachCompany/runWithCompany),
  //   3. the default company (migration 141's own backfill semantics for a
  //      single-company install; multi-tenant paths must supply 1 or 2).
  const companyId = meta.companyId || currentCompanyId() || (await getDefaultCompanyId());

  const contentType = meta.contentType || 'pdf';
  const extension = extensionFor(contentType, meta.language);
  const id = crypto.randomUUID();
  const storagePath = path.join(DOCUMENTS_DIR, `${id}.${extension}`);
  fs.writeFileSync(storagePath, buffer);

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const expiresAt = meta.expiresInDays
    ? new Date(Date.now() + Number(meta.expiresInDays) * 86400000)
    : null;

  const { rows } = await pool.query(
    `INSERT INTO generated_documents
       (id, title, kind, template_key, file_name, storage_path, byte_size, sha256,
        created_by, agent_run_id, company_id, metadata, expires_at, content_type, language)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      id,
      String(meta.title || 'Document').slice(0, 200),
      meta.kind || 'report',
      meta.templateKey || null,
      safeFileName(meta.title, extension),
      storagePath,
      buffer.length,
      sha256,
      meta.userId || null,
      meta.agentRunId || null,
      companyId,
      JSON.stringify(meta.metadata || {}),
      expiresAt,
      contentType,
      meta.language || null,
    ]
  );

  // Fire-and-forget: an embeddings call is seconds and AI may not even be
  // configured, and neither should turn a successful document save into a
  // failed request. Mirrors the text shape indexGeneratedDocuments already
  // uses for the batch/manual path, so live writes and a manual reindex agree.
  const indexableText = String(meta.metadata?.indexable_text || '').trim();
  if (indexableText) {
    const { indexDocument } = require('../ai/documentSearch');
    indexDocument({
      source_type: 'generated_document',
      source_id: id,
      text: `${rows[0].title || ''}\n\n${indexableText}`.trim(),
    }).catch((err) => {
      console.error(`documentStore: failed to auto-index document ${id}:`, err.message);
    });
  }

  return { ...rows[0], download_path: `/api/ai-documents/${id}/download` };
}

async function getDocument(id) {
  const { rows } = await pool.query('SELECT * FROM generated_documents WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Read a stored document's bytes.
 *
 * The path is rebuilt from the id rather than read from the row: a stored path
 * is data, and data that is used as a filesystem path is a traversal waiting to
 * happen. The row still has to exist, so this is not a way to read arbitrary ids.
 */
function readDocumentBytes(row) {
  const resolved = path.join(DOCUMENTS_DIR, `${row.id}.${extensionFor(row.content_type, row.language)}`);
  if (!fs.existsSync(resolved)) {
    throw new Error('The document record exists but its file is missing from storage.');
  }
  return fs.readFileSync(resolved);
}

async function listDocuments({ userId, agentRunId, limit = 50 } = {}) {
  const params = [];
  const where = [];
  if (userId) { params.push(userId); where.push(`created_by = $${params.length}`); }
  if (agentRunId) { params.push(agentRunId); where.push(`agent_run_id = $${params.length}`); }
  params.push(Math.min(Number(limit) || 50, 200));
  const { rows } = await pool.query(
    `SELECT id, title, kind, template_key, file_name, byte_size, created_by, agent_run_id,
            metadata, expires_at, created_at
       FROM generated_documents
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({ ...r, download_path: `/api/ai-documents/${r.id}/download` }));
}

/**
 * Who may download this. Documents can contain the whole AR ledger, so the
 * default is the creator plus management — not "any authenticated user".
 */
function canAccess(row, user) {
  if (!row || !user) return false;
  if (user.role === 'ADMIN' || user.role === 'MANAGER') return true;
  return String(row.created_by) === String(user.id);
}

/**
 * Delete expired documents. Called opportunistically rather than on a timer:
 * one more background loop for something this cheap is not worth the failure
 * mode of a loop nobody remembers exists.
 */
async function purgeExpired() {
  const { rows } = await pool.query(
    'DELETE FROM generated_documents WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP RETURNING id'
  );
  let removed = 0;
  for (const row of rows) {
    try {
      fs.unlinkSync(path.join(DOCUMENTS_DIR, `${row.id}.pdf`));
      removed += 1;
    } catch { /* the row is gone either way; a missing file is not an error here */ }
  }
  return { rows_deleted: rows.length, files_removed: removed };
}

module.exports = {
  saveDocument,
  getDocument,
  readDocumentBytes,
  listDocuments,
  canAccess,
  purgeExpired,
  safeFileName,
  DOCUMENTS_DIR,
};
