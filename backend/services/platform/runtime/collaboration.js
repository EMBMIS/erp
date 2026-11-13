/**
 * Comments and attachments on application records.
 *
 * The interesting part is `visibility`. A quality finding has two conversations
 * happening on it: the company's internal assessment, and the exchange with the
 * supplier. They must live on the same record — that is the point of a
 * collaboration portal — and they must never be the same conversation.
 *
 * So each comment carries `internal` or `shared`, an external principal can
 * neither read nor write an internal one, and the read query filters on it in
 * SQL rather than in the renderer. The validator separately refuses to place a
 * comments block on an external page unless it declares `visibility: shared`,
 * so the two checks would both have to fail for an internal note to reach a
 * portal.
 */

const companyContext = require('../../companyContext');
const resolver = require('./resolver');
const authz = require('./authorization');
const data = require('./data');

class CollaborationError extends Error {
  constructor(message, code = 'COLLABORATION_ERROR', status = 400) {
    super(message);
    this.name = 'CollaborationError';
    this.code = code;
    this.status = status;
  }
}

/** Which visibilities this principal may see. */
function visibleTo(principal) {
  return principal.kind === 'external' ? ['shared'] : ['internal', 'shared'];
}

async function listComments(context, principal, entityKey, recordId) {
  // Reading the record is the authorization check. A comment is exactly as
  // visible as the record it hangs off, and no more.
  await data.get(context, principal, entityKey, recordId);

  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT c.id, c.body, c.visibility, c.author_kind, c.author_label, c.created_at,
              u.first_name, u.last_name, e.display_name AS external_name, e.email AS external_email
         FROM app_record_comments c
         LEFT JOIN users u ON u.id = c.author_user_id
         LEFT JOIN app_external_identities e ON e.id = c.author_external_id
        WHERE c.app_instance_id = $1 AND c.entity_key = $2 AND c.record_id = $3
          AND c.visibility = ANY($4)
        ORDER BY c.created_at ASC`,
      [context.instance.id, entityKey, recordId, visibleTo(principal)]
    );
    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      visibility: r.visibility,
      at: r.created_at,
      author: {
        kind: r.author_kind,
        name: r.author_kind === 'external'
          ? (r.external_name || r.external_email || 'Portal user')
          : ([r.first_name, r.last_name].filter(Boolean).join(' ') || r.author_label || 'System'),
      },
    }));
  });
}

async function addComment(context, principal, entityKey, recordId, { body, visibility = null }) {
  const text = String(body || '').trim();
  if (!text) throw new CollaborationError('A comment needs some text.', 'EMPTY_COMMENT');
  if (text.length > 10000) throw new CollaborationError('That comment is too long.', 'COMMENT_TOO_LONG');

  await data.get(context, principal, entityKey, recordId);
  resolver.entityDefinition(context.spec, entityKey);

  // An external principal writes shared comments and nothing else. Not because
  // the UI only offers that, but because this is the only value the insert can
  // take for them.
  const effective = principal.kind === 'external'
    ? 'shared'
    : (visibility === 'shared' ? 'shared' : 'internal');

  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO app_record_comments
         (company_id, app_instance_id, entity_key, record_id, body, visibility,
          author_kind, author_user_id, author_external_id, author_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at`,
      [context.instance.companyId, context.instance.id, entityKey, recordId, text, effective,
        principal.kind === 'external' ? 'external' : 'user',
        principal.kind === 'external' ? null : principal.userId,
        principal.kind === 'external' ? principal.externalIdentityId : null,
        principal.label]
    );
    return { id: rows[0].id, body: text, visibility: effective, at: rows[0].created_at };
  });
}

async function listAttachments(context, principal, entityKey, recordId) {
  await data.get(context, principal, entityKey, recordId);
  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, file_name, content_type, byte_size, visibility, uploaded_by_kind, created_at
         FROM app_record_attachments
        WHERE app_instance_id = $1 AND entity_key = $2 AND record_id = $3
          AND visibility = ANY($4)
        ORDER BY created_at DESC`,
      [context.instance.id, entityKey, recordId, visibleTo(principal)]
    );
    return rows;
  });
}

/**
 * Register a stored file against a record.
 *
 * The bytes are handled by the existing file upload service; this records the
 * association and the visibility. Keeping the two apart means a change to
 * storage does not become a change to who can see what.
 */
async function addAttachment(context, principal, entityKey, recordId, {
  fileName, contentType, byteSize, storageKey, visibility = null,
}) {
  if (!storageKey) throw new CollaborationError('An attachment needs a stored file.', 'NO_FILE');
  await data.get(context, principal, entityKey, recordId);
  authz.assertCan(principal, entityKey, 'update');

  const effective = principal.kind === 'external'
    ? 'shared'
    : (visibility === 'shared' ? 'shared' : 'internal');

  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO app_record_attachments
         (company_id, app_instance_id, entity_key, record_id, file_name, content_type,
          byte_size, storage_key, visibility, uploaded_by_kind, uploaded_by_user_id, uploaded_by_external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, file_name, visibility, created_at`,
      [context.instance.companyId, context.instance.id, entityKey, recordId,
        String(fileName || 'file').slice(0, 255), contentType || null, byteSize || null, storageKey, effective,
        principal.kind === 'external' ? 'external' : 'user',
        principal.kind === 'external' ? null : principal.userId,
        principal.kind === 'external' ? principal.externalIdentityId : null]
    );
    return rows[0];
  });
}

/**
 * The activity feed: workflow transitions and comments, interleaved.
 *
 * Both filtered by the principal's visibility, so a portal user's feed is a
 * true account of what they can see rather than a redacted version of the
 * company's.
 */
async function activity(context, principal, entityKey, recordId) {
  const workflowRuntime = require('./workflow');
  const [transitions, comments] = await Promise.all([
    workflowRuntime.history(context, principal, entityKey, recordId),
    listComments(context, principal, entityKey, recordId),
  ]);

  const events = [
    ...transitions.map((t) => ({
      kind: 'transition', at: t.at, actor: t.actor,
      summary: `${t.from ? `${t.from} → ` : ''}${t.to}`,
      detail: t.reason || null,
    })),
    ...comments.map((c) => ({
      kind: 'comment', at: c.at, actor: c.author,
      summary: c.body, detail: null, visibility: c.visibility,
    })),
  ];
  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return events;
}

/**
 * Where an attachment's bytes are, given its id.
 *
 * Deliberately separate from listAttachments, and deliberately does NOT decide
 * anything: the caller has already established that this principal can see the
 * attachment. Returning the storage key from the listing itself would put a
 * filesystem path in every payload, including a portal's.
 */
async function storagePathFor(context, attachmentId) {
  return companyContext.withCompany(context.instance.companyId, async (client) => {
    const { rows } = await client.query(
      'SELECT storage_key FROM app_record_attachments WHERE id = $1 AND app_instance_id = $2',
      [attachmentId, context.instance.id]
    );
    return rows[0]?.storage_key || null;
  });
}

module.exports = {
  CollaborationError,
  storagePathFor,
  listComments, addComment,
  listAttachments, addAttachment,
  activity,
};
