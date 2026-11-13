/**
 * Shared "store one message into a mailbox" path — used by both the inbound
 * webhook (routes/mailboxes.js) and the outbound sender (mailboxOutboundService.js),
 * so quota accounting and R2 layout have exactly one implementation.
 *
 * Quota check, message insert, and attachment inserts all happen inside one
 * `companyContext.withCompany` transaction: if the mailbox is full, nothing
 * is written — not the message, not any attachment.
 */

const { v4: uuidv4 } = require('uuid');
const companyContext = require('./companyContext');
const mailboxQuota = require('./mailboxQuota');
const mailStorage = require('./mailStorage');

/**
 * @param {object} mailbox        row from `mailboxes` (needs id, company_id)
 * @param {'INBOUND'|'OUTBOUND'} direction
 * @param {'INBOX'|'SENT'} folder
 * @param {Buffer} rawBuffer      the full raw .eml — what counts against quota
 * @param {Array<{filename,contentType,content:Buffer}>} attachments
 */
async function storeMessage({
  mailbox, direction, folder, messageIdHeader, fromAddress,
  toAddresses = [], ccAddresses = [], bccAddresses = [], inReplyToId = null,
  subject, bodyText, bodyHtml,
  rawBuffer, attachments = [],
}) {
  const totalBytes = rawBuffer.length;
  const messageId = uuidv4();

  return companyContext.withCompany(mailbox.company_id, async (client) => {
    // Locks mailboxes.used_bytes and throws mailboxQuota.QuotaExceededError
    // (writing nothing) if this message would push the mailbox over quota.
    await mailboxQuota.reserve(client, mailbox.id, totalBytes);

    const rawKey = mailStorage.rawKey(mailbox.id, messageId);
    await mailStorage.putObject(rawKey, rawBuffer, 'message/rfc822');

    const { rows } = await client.query(
      `INSERT INTO mailbox_messages
         (id, company_id, mailbox_id, direction, folder, message_id_header,
          from_address, to_addresses, cc_addresses, bcc_addresses, in_reply_to_id,
          subject, body_text, body_html, size_bytes, r2_object_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [messageId, mailbox.company_id, mailbox.id, direction, folder, messageIdHeader || null,
       fromAddress, JSON.stringify(toAddresses), JSON.stringify(ccAddresses), JSON.stringify(bccAddresses),
       inReplyToId || null, subject || null, bodyText || null, bodyHtml || null, totalBytes, rawKey]
    );
    const message = rows[0];

    for (const att of attachments) {
      const attachmentId = uuidv4();
      const key = mailStorage.attachmentKey(mailbox.id, messageId, attachmentId, att.filename);
      await mailStorage.putObject(key, att.content, att.contentType);
      // contentId (RFC 2392, no angle brackets): set when this attachment is
      // an inline image the HTML body references as cid:<contentId>, rather
      // than an ordinary attachment. Stripped of <> here so callers can pass
      // either form straight from mailparser (.cid, already bare) or a raw
      // Content-ID header (which does carry the brackets).
      const contentId = att.contentId ? String(att.contentId).replace(/^<|>$/g, '') : null;
      await client.query(
        `INSERT INTO mailbox_attachments
           (id, company_id, message_id, filename, content_type, size_bytes, r2_object_key, content_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [attachmentId, mailbox.company_id, messageId, att.filename || 'attachment',
         att.contentType || null, att.content.length, key, contentId]
      );
    }

    return message;
  });
}

module.exports = { storeMessage };
