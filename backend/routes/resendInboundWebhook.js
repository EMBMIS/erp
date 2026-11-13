/**
 * Resend's inbound-mail webhook (event email.received).
 *
 * Mounted in server.js BEFORE the global express.json() parser, same reason
 * : Svix signature verification
 * needs the EXACT raw request bytes Resend signed. This one specifically
 * cannot share a router with the rest of routes/mailboxes.js and rely on a
 * route-local express.raw() middleware — Resend sends Content-Type:
 * application/json, which is exactly what the global express.json() parser
 * also matches, so by the time a route-local raw() ran the body stream had
 * already been consumed and re-parsed into an object, and re-stringifying
 * that never reproduces the exact bytes Resend hashed. Every signature check
 * failed for this reason until the route moved here, ahead of that parser.
 */

const express = require('express');
const crypto = require('crypto');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');
const mailboxService = require('../services/mailboxService');
const mailboxMessageStore = require('../services/mailboxMessageStore');
const mailboxQuota = require('../services/mailboxQuota');

const router = express.Router();

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256'd
 * with the base64 portion of the whsec_... secret, base64-encoded. The
 * signature header carries one or more space-separated `v1,<sig>` values —
 * Svix rotates secrets by sending multiple, any match is valid.
 */
function verifySvixSignature(secret, svixId, svixTimestamp, svixSignatureHeader, rawBody) {
  if (!secret || !svixId || !svixTimestamp || !svixSignatureHeader) return false;
  const secretBytes = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return svixSignatureHeader.split(' ').some((part) => {
    const sig = part.split(',')[1];
    return sig && timingSafeEqualStr(sig, expected);
  });
}

function buildRawFromStructured(mailOptions) {
  return new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

router.post('/', express.raw({ type: 'application/json', limit: '60mb' }), async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const valid = verifySvixSignature(
      process.env.RESEND_WEBHOOK_SECRET,
      req.header('svix-id'),
      req.header('svix-timestamp'),
      req.header('svix-signature'),
      rawBody
    );
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid webhook signature.' });
    }

    const payload = JSON.parse(rawBody);

    if (payload.type !== 'email.received') {
      return res.json({ success: true, ignored: payload.type });
    }

    const data = payload.data || {};
    console.log(`[resend-inbound] keys=${Object.keys(data).join(',')} text=${(data.text || '').length} html=${(data.html || '').length} raw=${(data.raw || '').length}`);
    const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    const toAddresses = asList(data.to).map((v) => (typeof v === 'string' ? v : v?.email || v?.address)).filter(Boolean);
    const fromAddress = typeof data.from === 'string' ? data.from : (data.from?.email || data.from?.address || 'unknown');
    const recipient = (toAddresses[0] || data.envelope_to || '').toLowerCase().trim();

    if (!recipient) {
      return res.status(400).json({ success: false, error: 'No recipient address in payload.' });
    }

    const mailbox = await mailboxService.resolveInboundMailbox(recipient);
    if (!mailbox) {
      return res.status(404).json({ success: false, error: `No mailbox for ${recipient}.` });
    }

    const attachments = asList(data.attachments).map((a) => ({
      filename: a.filename || a.name || 'attachment',
      contentType: a.content_type || a.contentType || a.type,
      content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || '', 'base64'),
      contentId: a.content_id || a.contentId || a.cid || null,
    }));

    // Prefer a raw MIME field if Resend provides one (full fidelity); build
    // an equivalent one from structured fields otherwise, same technique the
    // outbound sender uses to get a consistent raw.eml either way.
    const rawBuffer = data.raw
      ? Buffer.from(data.raw, typeof data.raw === 'string' && /^[A-Za-z0-9+/=]+$/.test(data.raw.slice(0, 100)) ? 'base64' : 'utf8')
      : await buildRawFromStructured({
          from: fromAddress,
          to: toAddresses,
          subject: data.subject,
          text: data.text,
          html: data.html,
          attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
        });

    // Resend's payload does not always carry the message text/html — derive
    // the body from the raw message so the UI is never left with an empty
    // body when the structured fields are missing.
    let parsedBody = { text: null, html: null };
    try {
      parsedBody = await simpleParser(rawBuffer);
    } catch (parseError) {
      console.error('Failed to parse inbound raw message:', parseError.message);
    }

    // Resend's webhook payload carries only metadata by design — body,
    // headers and attachments are fetched via the Receiving API afterwards
    // (see https://resend.com/docs/inbound-email/receiving). Without this
    // fetch every inbound message would store an empty body.
    // mailparser reliably exposes an inline image's Content-ID (.cid) from
    // the actual raw MIME it just parsed above — a fallback for when the
    // Receiving API's own attachment metadata doesn't carry one, keyed by
    // filename since that's the one field both representations share.
    const cidByFilename = new Map(
      (parsedBody.attachments || []).filter((a) => a.cid && a.filename).map((a) => [a.filename, a.cid])
    );

    let receivedEmail = null;
    let receivedAttachments = [];
    if (data.email_id) {
      try {
        const { Resend } = require('resend');
        const resendClient = new Resend(process.env.RESEND_API_KEY);
        receivedEmail = (await resendClient.emails.receiving.get(data.email_id)).data || null;
        const attList = (await resendClient.emails.receiving.attachments.list(data.email_id)).data?.data || [];
        for (const att of attList) {
          const attData = (await resendClient.emails.receiving.attachments.get(data.email_id, att.id)).data || {};
          const filename = attData.filename || att.filename || 'attachment';
          receivedAttachments.push({
            filename,
            contentType: attData.content_type || attData.contentType,
            content: Buffer.from(String(attData.content || ''), 'base64'),
            contentId: attData.content_id || attData.contentId || att.content_id || cidByFilename.get(filename) || null,
          });
        }
      } catch (fetchError) {
        console.error('Failed to fetch received email body/attachments:', fetchError.message);
      }
    }

    const message = await mailboxMessageStore.storeMessage({
      mailbox,
      direction: 'INBOUND',
      folder: 'INBOX',
      messageIdHeader: data.email_id || data.message_id || payload.id || null,
      fromAddress,
      toAddresses,
      ccAddresses: asList(data.cc).map((v) => (typeof v === 'string' ? v : v?.email)).filter(Boolean),
      subject: data.subject || null,
      bodyText: receivedEmail?.text || parsedBody.text || data.text || null,
      bodyHtml: receivedEmail?.html || parsedBody.html || data.html || null,
      rawBuffer,
      attachments: receivedAttachments.length ? receivedAttachments : attachments,
    });

    return res.json({ success: true, data: { id: message.id } });
  } catch (error) {
    if (error instanceof mailboxQuota.QuotaExceededError) {
      return res.status(200).json({ success: false, error: 'Mailbox is full.' }); // 200: Resend doesn't retry on our failures
    }
    console.error('Resend inbound webhook error:', error);
    return res.status(500).json({ success: false, error: 'Failed to store inbound message.' });
  }
});

module.exports = router;
