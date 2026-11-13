/**
 * Where an application attachment's bytes live.
 *
 * ===========================================================================
 * WHY THIS IS NOT JUST A DIRECTORY
 * ===========================================================================
 * Local disk is the obvious answer and it is wrong for the shape this product
 * actually deploys in. The migration runner takes an advisory lock precisely
 * because several replicas boot at once (see scripts/db-migrate.js); with more
 * than one replica behind a load balancer, an upload lands on the disk of the
 * replica that served it and a download from any other replica is a 404. That
 * failure is intermittent, looks like corruption, and would be found by a
 * customer rather than by us.
 *
 * EMBMIS already made this decision once, for mail: bytes that can get large
 * go to R2 (S3-compatible), metadata stays in Postgres — services/mailStorage.js.
 * This reuses that, so there is one answer to "where are the bytes" rather than
 * two.
 *
 * ===========================================================================
 * THE FALLBACK, AND WHY IT IS EXPLICIT IN THE KEY
 * ===========================================================================
 * With no R2 configured — a laptop, a single-container deployment — files go to
 * local disk, and the storage key records WHICH: `r2:...` or `disk:...`. A key
 * that did not say would have to be guessed at after a deployment moved, and a
 * guess about where a document is stored is how a document goes missing. An
 * existing file keeps working after R2 is turned on, because its key still says
 * `disk:`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const LOCAL_ROOT = process.env.PLATFORM_ATTACHMENT_DIR
  ? path.resolve(process.env.PLATFORM_ATTACHMENT_DIR)
  : path.join(__dirname, '../../../uploads/applications');

/** Is object storage configured? Asked per call, so turning it on needs no restart. */
function remoteConfigured() {
  return !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

/**
 * The object key for one attachment.
 *
 * Keyed by instance so one company's application is one prefix. The filename is
 * generated, never the client's: a client-supplied name reaching a path is how
 * `../../.env` gets written.
 */
function keyFor(instanceId, entityKey, originalName) {
  const extension = path.extname(String(originalName || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  return `applications/${instanceId}/${entityKey}/${crypto.randomUUID()}${extension}`;
}

/**
 * Store the bytes.
 *
 * @returns {Promise<string>} the storage key to record, prefixed with its backend.
 */
async function put({ instanceId, entityKey, originalName, buffer, contentType }) {
  const key = keyFor(instanceId, entityKey, originalName);

  if (remoteConfigured()) {
    const mailStorage = require('../../mailStorage');
    await mailStorage.putObject(key, buffer, contentType || 'application/octet-stream');
    return `r2:${key}`;
  }

  const absolute = path.join(LOCAL_ROOT, key);
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  await fs.promises.writeFile(absolute, buffer);
  return `disk:${key}`;
}

/**
 * A readable stream of the bytes, or null when they are no longer there.
 *
 * Never throws for a missing file: an attachment whose bytes have gone is a
 * 404, not a 500, and the caller has already established that the requester is
 * entitled to it.
 */
async function open(storageKey) {
  if (!storageKey) return null;
  const [backend, ...rest] = String(storageKey).split(':');
  const key = rest.join(':');

  if (backend === 'r2') {
    try {
      const mailStorage = require('../../mailStorage');
      const body = await mailStorage.getObject(key);
      // getObject returns a Buffer or a stream depending on the SDK path; both
      // are streamable, and normalising here keeps the route from caring.
      return Buffer.isBuffer(body) ? Readable.from(body) : body;
    } catch {
      return null;
    }
  }

  // Legacy and local: a key with no prefix predates this module and is a path
  // relative to the local root.
  const relative = backend === 'disk' ? key : storageKey;
  const absolute = path.resolve(LOCAL_ROOT, relative);
  // A key that escapes its root is refused rather than followed.
  if (!absolute.startsWith(path.resolve(LOCAL_ROOT) + path.sep)) return null;
  if (!fs.existsSync(absolute)) return null;
  return fs.createReadStream(absolute);
}

/** Best-effort removal, for the case where the database row was refused. */
async function remove(storageKey) {
  if (!storageKey) return;
  const [backend, ...rest] = String(storageKey).split(':');
  const key = rest.join(':');
  try {
    if (backend === 'r2') {
      const mailStorage = require('../../mailStorage');
      await mailStorage.deleteObject(key);
      return;
    }
    const relative = backend === 'disk' ? key : storageKey;
    const absolute = path.resolve(LOCAL_ROOT, relative);
    if (absolute.startsWith(path.resolve(LOCAL_ROOT) + path.sep)) {
      await fs.promises.unlink(absolute).catch(() => {});
    }
  } catch {
    // A file that could not be removed is litter, not a failure the caller
    // needs to hear about — the row it belonged to is already gone.
  }
}

module.exports = { put, open, remove, keyFor, remoteConfigured, LOCAL_ROOT };
