const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { simpleParser } = require('mailparser');
const { auth, requireAdmin } = require('../middleware/auth');
const { scopedMulter } = require('../middleware/scopedMulter');
const { pool } = require('../config/database');
const Company = require('../models/Company');
const mailboxService = require('../services/mailboxService');
const mailboxMessageStore = require('../services/mailboxMessageStore');
const mailboxOutboundService = require('../services/mailboxOutboundService');
const mailboxQuota = require('../services/mailboxQuota');
const mailStorage = require('../services/mailStorage');

const router = express.Router();

// Same per-file cap as the AI chat's attachment upload (routes/ai-chat.js);
// up to 10 files, matching what a real mail client lets you drag onto a
// compose window before it starts complaining.
const uploadOutboundAttachments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

const FOLDER_VALUES = ['INBOX', 'SENT', 'TRASH', 'DRAFTS', 'ARCHIVE'];

// "a@b.com, c@d.com" or "a@b.com; c@d.com" -> ['a@b.com', 'c@d.com']. The
// compose UI sends recipients as one delimited string per field (To/Cc/Bcc),
// same as every real mail client's address box.
function splitAddresses(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[,;]/).map((v) => v.trim()).filter(Boolean);
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ===========================================================================
// POST /api/mailboxes/webhook/inbound — legacy/secondary inbound path (the
// live MX for embmis.com is Resend's inbound SMTP, handled by
// resendInboundWebhook.js; this one exists for direct POSTs and older
// routing). Not a logged-in user: authenticated by a shared secret header.
//
// Response codes are a contract with the Worker: 200 = stored, tell the
// sender's server the message was accepted; 404 = no such mailbox, reject;
// 413 = mailbox full, reject; anything else = the Worker may retry once.
// ===========================================================================
router.post('/webhook/inbound', express.raw({ type: '*/*', limit: '60mb' }), async (req, res) => {
  try {
    const secret = req.header('X-Mailbox-Webhook-Secret');
    if (!process.env.MAILBOX_WEBHOOK_SECRET || !timingSafeEqualStr(secret, process.env.MAILBOX_WEBHOOK_SECRET)) {
      return res.status(401).json({ success: false, error: 'Invalid webhook secret.' });
    }

    const envelopeTo = (req.header('X-Envelope-To') || '').trim().toLowerCase();
    if (!envelopeTo) {
      return res.status(400).json({ success: false, error: 'X-Envelope-To header is required.' });
    }

    // Redirect takes precedence over a direct match when one is configured
    // (mailbox_redirects): the source mailbox row still exists — its history
    // stays intact — but new inbound mail to a deprecated address belongs in
    // the target's inbox. Same resolution as the Resend webhook.
    const mailbox = await mailboxService.resolveInboundMailbox(envelopeTo);
    if (!mailbox) {
      return res.status(404).json({ success: false, error: `No mailbox for ${envelopeTo}.` });
    }

    const rawBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!rawBuffer.length) {
      return res.status(400).json({ success: false, error: 'Empty message body.' });
    }

    const parsed = await simpleParser(rawBuffer);
    const attachments = (parsed.attachments || []).map((a) => ({
      filename: a.filename || 'attachment',
      contentType: a.contentType,
      content: a.content,
      contentId: a.cid || null, // mailparser exposes this bare (no <>) for an inline image
    }));

    const message = await mailboxMessageStore.storeMessage({
      mailbox,
      direction: 'INBOUND',
      folder: 'INBOX',
      messageIdHeader: parsed.messageId || null,
      fromAddress: parsed.from?.text || req.header('X-Envelope-From') || 'unknown',
      toAddresses: (parsed.to?.value || []).map((v) => v.address).filter(Boolean),
      ccAddresses: (parsed.cc?.value || []).map((v) => v.address).filter(Boolean),
      subject: parsed.subject || null,
      bodyText: parsed.text || null,
      bodyHtml: parsed.html || null,
      rawBuffer,
      attachments,
    });

    return res.json({ success: true, data: { id: message.id } });
  } catch (error) {
    if (error instanceof mailboxQuota.QuotaExceededError) {
      return res.status(413).json({ success: false, error: 'Mailbox is full.' });
    }
    console.error('Inbound mail webhook error:', error);
    return res.status(500).json({ success: false, error: 'Failed to store inbound message.' });
  }
});

// Resend's inbound webhook (event email.received) is NOT here — it needs the
// exact raw request bytes for Svix signature verification, which requires
// being mounted before the global express.json() parser in server.js. See
// routes/resendInboundWebhook.js.

// ===========================================================================
// Everything below requires a logged-in user, scoped to their own company —
// same shape as routes/users.js. Admin-only endpoints add `requireAdmin`
// explicitly; the rest are gated per-mailbox by `ownsOrAdmin` below, so a
// user can reach their OWN mailbox without being an admin of the company.
// ===========================================================================
router.use(auth);

// A mailbox is reachable by an admin of its company, or by the one user it
// belongs to. The company-membership boundary (req.companyId) is already
// enforced by every lookup below via mailboxService.findById/findByUser —
// this only decides whether THIS caller may act on a mailbox that IS in
// their company.
function ownsOrAdmin(mailbox, req) {
  return req.user.role === 'ADMIN' || mailbox.user_id === req.user.id;
}

// GET /api/mailboxes — list this company's mailboxes. Admin only: this is
// every mailbox in the company, not just the caller's own.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const mailboxes = await mailboxService.listForCompany(req.companyId);
    res.json({ success: true, data: mailboxes });
  } catch (error) {
    console.error('List mailboxes error:', error);
    res.status(500).json({ success: false, error: 'Failed to list mailboxes' });
  }
});

// GET /api/mailboxes/mine — the caller's own mailbox in their current
// company, if they have one. What the inbox UI loads first to find out
// which mailbox to open — no mailbox id needed, and no admin role required.
router.get('/mine', async (req, res) => {
  try {
    const mailbox = await mailboxService.findByUser(req.user.id, req.companyId);
    if (!mailbox) return res.json({ success: true, data: null });
    res.json({ success: true, data: mailbox });
  } catch (error) {
    console.error('Get own mailbox error:', error);
    res.status(500).json({ success: false, error: 'Failed to load your mailbox' });
  }
});

// POST /api/mailboxes/users/:userId — provision a mailbox for a user in the
// caller's own company. userId must already be a member of req.companyId —
// same membership check User.js's deactivate/activate/updateRole use.
router.post('/users/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const member = await pool.query(
      'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND deleted_at IS NULL AND id IN (SELECT user_id FROM user_companies WHERE company_id = $2)',
      [userId, req.companyId]
    );
    if (!member.rows.length) {
      return res.status(404).json({ success: false, error: 'User not found in your company.' });
    }

    const existing = await pool.query(
      'SELECT id FROM mailboxes WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL',
      [userId, req.companyId]
    );
    if (existing.rows.length) {
      return res.status(409).json({ success: false, error: 'This user already has a mailbox.' });
    }

    const company = await Company.Companies.findById(req.companyId);
    const mailbox = await mailboxService.createUserMailbox(member.rows[0], req.companyId, company.name, req.user.id);
    res.status(201).json({ success: true, data: mailbox });
  } catch (error) {
    console.error('Create user mailbox error:', error);
    res.status(500).json({ success: false, error: 'Failed to create mailbox' });
  }
});

// GET /api/mailboxes/:id/messages — list messages in a mailbox this company owns.
router.get('/:id/messages', async (req, res) => {
  try {
    const mailbox = await mailboxService.findById(req.params.id, req.companyId);
    if (!mailbox) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!ownsOrAdmin(mailbox, req)) return res.status(403).json({ success: false, error: 'This is not your mailbox.' });

    const folder = FOLDER_VALUES.includes(req.query.folder) ? req.query.folder : 'INBOX';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    // starred=1 filters to flagged messages within the chosen folder, same
    // idea as Outlook's "Flagged" being a filter on a folder rather than a
    // folder of its own.
    const starredOnly = req.query.starred === '1' || req.query.starred === 'true';
    const q = String(req.query.q || '').trim();

    const params = [mailbox.id, req.companyId, folder];
    let where = 'mailbox_id = $1 AND company_id = $2 AND folder = $3';
    if (starredOnly) where += ' AND is_starred = true';
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (subject ILIKE $${params.length} OR from_address ILIKE $${params.length} OR body_text ILIKE $${params.length})`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT id, direction, folder, from_address, to_addresses, cc_addresses, bcc_addresses,
              subject, size_bytes, is_read, is_starred, in_reply_to_id, created_at
         FROM mailbox_messages
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, data: rows, mailbox: { id: mailbox.id, address: mailbox.address, used_bytes: mailbox.used_bytes, quota_bytes: mailbox.quota_bytes } });
  } catch (error) {
    console.error('List mailbox messages error:', error);
    res.status(500).json({ success: false, error: 'Failed to list messages' });
  }
});

// GET /api/mailboxes/:id/messages/:messageId — full message body + attachment list.
router.get('/:id/messages/:messageId', async (req, res) => {
  try {
    const mailbox = await mailboxService.findById(req.params.id, req.companyId);
    if (!mailbox) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!ownsOrAdmin(mailbox, req)) return res.status(403).json({ success: false, error: 'This is not your mailbox.' });

    const { rows } = await pool.query(
      `SELECT * FROM mailbox_messages WHERE id = $1 AND mailbox_id = $2 AND company_id = $3`,
      [req.params.messageId, mailbox.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Message not found' });

    const attachments = await pool.query(
      `SELECT id, filename, content_type, size_bytes, content_id FROM mailbox_attachments WHERE message_id = $1 AND company_id = $2`,
      [req.params.messageId, req.companyId]
    );

    if (!rows[0].is_read) {
      await pool.query('UPDATE mailbox_messages SET is_read = true WHERE id = $1', [req.params.messageId]);
    }

    res.json({ success: true, data: { ...rows[0], attachments: attachments.rows } });
  } catch (error) {
    console.error('Get mailbox message error:', error);
    res.status(500).json({ success: false, error: 'Failed to load message' });
  }
});

// GET /api/mailboxes/:id/messages/:messageId/attachments/:attachmentId — download.
router.get('/:id/messages/:messageId/attachments/:attachmentId', async (req, res) => {
  try {
    const mailbox = await mailboxService.findById(req.params.id, req.companyId);
    if (!mailbox) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!ownsOrAdmin(mailbox, req)) return res.status(403).json({ success: false, error: 'This is not your mailbox.' });

    const { rows } = await pool.query(
      `SELECT a.* FROM mailbox_attachments a
         JOIN mailbox_messages m ON m.id = a.message_id
        WHERE a.id = $1 AND a.message_id = $2 AND m.mailbox_id = $3 AND a.company_id = $4`,
      [req.params.attachmentId, req.params.messageId, mailbox.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Attachment not found' });

    const { buffer, contentType } = await mailStorage.getObject(rows[0].r2_object_key);
    res.setHeader('Content-Type', contentType || rows[0].content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].filename.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Download attachment error:', error);
    res.status(500).json({ success: false, error: 'Failed to download attachment' });
  }
});

// POST /api/mailboxes/:id/messages — send a message from this mailbox.
// multipart/form-data so Compose can attach files in the same request;
// text fields (to/cc/bcc/subject/text/html/inReplyTo) arrive as ordinary
// form fields either way. scopedMulter re-enters the company AsyncLocalStorage
// scope multer's streaming otherwise drops — see middleware/scopedMulter.js.
router.post('/:id/messages', scopedMulter(uploadOutboundAttachments.array('attachments', 10)), async (req, res) => {
  try {
    const mailbox = await mailboxService.findById(req.params.id, req.companyId);
    if (!mailbox) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!ownsOrAdmin(mailbox, req)) return res.status(403).json({ success: false, error: 'This is not your mailbox.' });

    const { subject, text, html, inReplyTo } = req.body;
    const to = splitAddresses(req.body.to);
    const cc = splitAddresses(req.body.cc);
    const bcc = splitAddresses(req.body.bcc);
    if (!to.length) return res.status(400).json({ success: false, error: '"to" is required.' });

    // Reply/Reply All/Forward carry the id of the message they're answering —
    // load it (scoped to this mailbox's company, so one company can't thread
    // off another's message id) so the outbound service can set proper
    // In-Reply-To/References headers and store the thread link.
    let inReplyToMessage = null;
    if (inReplyTo) {
      const { rows } = await pool.query(
        `SELECT id, message_id_header FROM mailbox_messages WHERE id = $1 AND company_id = $2`,
        [inReplyTo, req.companyId]
      );
      inReplyToMessage = rows[0] || null;
    }

    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname, content: f.buffer, contentType: f.mimetype,
    }));

    const message = await mailboxOutboundService.sendFromMailbox(mailbox, {
      to, cc, bcc, subject, text, html, attachments, inReplyTo: inReplyToMessage,
    });
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    if (error instanceof mailboxQuota.QuotaExceededError) {
      return res.status(413).json({ success: false, error: 'This mailbox is full — free up space before sending.' });
    }
    console.error('Send mailbox message error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to send message' });
  }
});

// POST /api/mailboxes/:id/drafts — save a draft, no send. Same body shape as
// POST /:id/messages (to/cc/bcc/subject/text/attachments/inReplyTo), but "to"
// is optional here — a draft can exist with no recipient yet.
router.post('/:id/drafts', scopedMulter(uploadOutboundAttachments.array('attachments', 10)), async (req, res) => {
  try {
    const mailbox = await mailboxService.findById(req.params.id, req.companyId);
    if (!mailbox) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!ownsOrAdmin(mailbox, req)) return res.status(403).json({ success: false, error: 'This is not your mailbox.' });

    const { subject, text, html, inReplyTo } = req.body;
    const to = splitAddresses(req.body.to);
    const cc = splitAddresses(req.body.cc);
    const bcc = splitAddresses(req.body.bcc);

    let inReplyToMessage = null;
    if (inReplyTo) {
      const { rows } = await pool.query(
        `SELECT id, message_id_header FROM mailbox_messages WHERE id = $1 AND company_id = $2`,
        [inReplyTo, req.companyId]
      );
      inReplyToMessage = rows[0] || null;
    }

    const attachments = (req.files || []).map((f) => ({
      filename: f.originalname, content: f.buffer, contentType: f.mimetype,
    }));

    const message = await mailboxOutboundService.saveDraft(mailbox, {
      to, cc, bcc, subject, text, html, attachments, inReplyTo: inReplyToMessage,
    });
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    if (error instanceof mailboxQuota.QuotaExceededError) {
      return res.status(413).json({ success: false, error: 'This mailbox is full — free up space before saving a draft.' });
    }
    console.error('Save draft error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to save draft' });
  }
});

// PATCH /api/mailboxes/:id/messages/:messageId — read/star/folder state.
// Three independent switches an inbox view needs, none of which is "edit the
// message" (mail is immutable once delivered/sent) — so this only ever
// touches is_read, is_starred, and folder, each optional and independent.
router.patch('/:id/messages/:messageId', async (req, res) => {
  try {
    const mailbox = await mailboxService.findById(req.params.id, req.companyId);
    if (!mailbox) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!ownsOrAdmin(mailbox, req)) return res.status(403).json({ success: false, error: 'This is not your mailbox.' });

    const sets = [];
    const params = [req.params.messageId, mailbox.id, req.companyId];
    if (typeof req.body.is_read === 'boolean') { sets.push(`is_read = $${params.length + 1}`); params.push(req.body.is_read); }
    if (typeof req.body.is_starred === 'boolean') { sets.push(`is_starred = $${params.length + 1}`); params.push(req.body.is_starred); }
    if (req.body.folder) {
      if (!FOLDER_VALUES.includes(req.body.folder)) {
        return res.status(400).json({ success: false, error: `folder must be one of: ${FOLDER_VALUES.join(', ')}.` });
      }
      sets.push(`folder = $${params.length + 1}`); params.push(req.body.folder);
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update.' });

    const { rows } = await pool.query(
      `UPDATE mailbox_messages SET ${sets.join(', ')}
        WHERE id = $1 AND mailbox_id = $2 AND company_id = $3
      RETURNING id, is_read, is_starred, folder`,
      params
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Message not found' });
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Update mailbox message error:', error);
    res.status(500).json({ success: false, error: 'Failed to update message' });
  }
});

// DELETE /api/mailboxes/:id/messages/:messageId — move to Trash; a second
// delete from Trash is permanent. Same two-step every mail client uses, so
// an accidental delete is recoverable and a deliberate one still frees quota.
router.delete('/:id/messages/:messageId', async (req, res) => {
  try {
    const mailbox = await mailboxService.findById(req.params.id, req.companyId);
    if (!mailbox) return res.status(404).json({ success: false, error: 'Mailbox not found' });
    if (!ownsOrAdmin(mailbox, req)) return res.status(403).json({ success: false, error: 'This is not your mailbox.' });

    const { rows } = await pool.query(
      `SELECT id, folder, size_bytes FROM mailbox_messages WHERE id = $1 AND mailbox_id = $2 AND company_id = $3`,
      [req.params.messageId, mailbox.id, req.companyId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Message not found' });

    if (rows[0].folder !== 'TRASH') {
      await pool.query(`UPDATE mailbox_messages SET folder = 'TRASH' WHERE id = $1`, [rows[0].id]);
      return res.json({ success: true, data: { permanentlyDeleted: false } });
    }

    const attachments = await pool.query(
      `SELECT r2_object_key FROM mailbox_attachments WHERE message_id = $1 AND company_id = $2`,
      [rows[0].id, req.companyId]
    );
    const raw = await pool.query(`SELECT r2_object_key FROM mailbox_messages WHERE id = $1`, [rows[0].id]);

    // A real transaction needs one held connection throughout — pool.query()
    // each acquires and releases its own, so a sequence of them would BEGIN
    // on one connection and DELETE/UPDATE on others, none of it atomic.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM mailbox_messages WHERE id = $1 AND mailbox_id = $2 AND company_id = $3`,
        [rows[0].id, mailbox.id, req.companyId]);
      await mailboxQuota.release(client, mailbox.id, rows[0].size_bytes);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Best-effort: the row is already gone and the quota already released —
    // an orphaned R2 object costs storage, not correctness, so a failure
    // here is logged rather than surfaced as a failed delete.
    for (const a of attachments.rows) {
      mailStorage.deleteObject(a.r2_object_key).catch((err) => console.error('R2 attachment cleanup failed:', err.message));
    }
    if (raw.rows[0]?.r2_object_key) {
      mailStorage.deleteObject(raw.rows[0].r2_object_key).catch((err) => console.error('R2 message cleanup failed:', err.message));
    }

    res.json({ success: true, data: { permanentlyDeleted: true } });
  } catch (error) {
    console.error('Delete mailbox message error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete message' });
  }
});

module.exports = router;
