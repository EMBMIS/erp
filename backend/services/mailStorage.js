/**
 * Cloudflare R2 (S3-compatible) storage for mail bodies and attachments.
 *
 * Message metadata (subject, from/to, size) lives in Postgres; the bytes
 * that can actually get large — the raw .eml and attachment content — live
 * here instead, because this VM's own disk has only a few GB free and R2
 * gives 10GB free forever with zero egress fees.
 *
 * Object key convention:
 *   mailboxes/<mailbox_id>/<message_id>/raw.eml
 *   mailboxes/<mailbox_id>/<message_id>/attachments/<attachment_id>-<filename>
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

let client = null;
function r2() {
  if (client) return client;
  const { R2_ACCOUNT_ID, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not configured — mail storage is unavailable.');
  }
  client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return client;
}

function bucket() {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error('R2_BUCKET is not configured.');
  return b;
}

function rawKey(mailboxId, messageId) {
  return `mailboxes/${mailboxId}/${messageId}/raw.eml`;
}

function attachmentKey(mailboxId, messageId, attachmentId, filename) {
  const safeName = String(filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
  return `mailboxes/${mailboxId}/${messageId}/attachments/${attachmentId}-${safeName}`;
}

async function putObject(key, buffer, contentType) {
  await r2().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

async function getObject(key) {
  const result = await r2().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: result.ContentType };
}

async function deleteObject(key) {
  await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

module.exports = { rawKey, attachmentKey, putObject, getObject, deleteObject };
