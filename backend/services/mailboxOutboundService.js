/**
 * Outbound mail for company/user @embmis.com addresses, via Resend.
 *
 * Cloudflare (Email Routing) only receives mail — it has no outbound sending
 * product — so delivery goes through Resend instead: a single API key, no
 * IAM/sandbox-approval step, and verifying embmis.com once there lets any
 * local-part under it send, which is what lets every auto-provisioned
 * mailbox actually work without a manual per-address verification step.
 *
 * The raw MIME actually delivered isn't what Resend hands back (their API
 * takes structured fields, not raw bytes, and doesn't return the composed
 * message) — so `MailComposer` builds an equivalent raw .eml locally, purely
 * for storage/quota purposes, independent of what Resend does internally.
 * This keeps "what's in the Sent folder" byte-identical in shape to what an
 * inbound message looks like, so both go through the same storeMessage path.
 */

const { Resend } = require('resend');
// Documented Nodemailer pattern for composing a raw MIME message without
// sending it through a transport — see nodemailer.com/extras/mailcomposer.
const MailComposer = require('nodemailer/lib/mail-composer');

const mailboxMessageStore = require('./mailboxMessageStore');
const mailBrandingService = require('./mailBrandingService');

let resendClient = null;
function resend() {
  if (resendClient) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured — outbound mail is unavailable.');
  resendClient = new Resend(apiKey);
  return resendClient;
}

function buildRaw(mailOptions) {
  return new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message); // Buffer
    });
  });
}

/**
 * Send a message from `mailbox` and store a copy of it in that mailbox's own
 * SENT folder, counted against the same quota real inbound mail uses.
 *
 * @param {object} mailbox  row from `mailboxes`
 * @param {{to, cc, bcc, subject, text, html, attachments, inReplyTo}} message
 *   `attachments`: [{ filename, content: Buffer, contentType }]
 *   `inReplyTo`: the mailbox_messages row this is a Reply/Reply All/Forward
 *     to, if any — carries its id (thread linkage, stored on the new row)
 *     and message_id_header (the RFC 5322 In-Reply-To/References headers,
 *     which is what lets a real mail client thread the conversation even
 *     though this app has no threading concept of its own on the wire).
 */
async function sendFromMailbox(mailbox, { to, cc, bcc, subject, text, html, attachments = [], inReplyTo = null }) {
  if (!to) throw new Error('An email needs at least one recipient.');

  // If this company has a design (Admin > Mail Design, or the AI chat's
  // generate_mail_branding tool), every outbound message goes out wrapped in
  // it — the logo is a hosted https:// image the template references (see
  // mailBrandingService.render()), not an inline attachment. A branding
  // render failure (bad template, R2 hiccup) degrades to sending the plain
  // message rather than blocking the send.
  let brandedHtml = html;
  try {
    const rendered = await mailBrandingService.render(mailbox.company_id, { subject, bodyHtml: html, bodyText: text });
    if (rendered) brandedHtml = rendered.html;
  } catch (err) {
    console.error('Mail branding render failed, sending unbranded:', err.message);
  }

  const from = mailbox.display_name ? `"${mailbox.display_name}" <${mailbox.address}>` : mailbox.address;
  const toList = Array.isArray(to) ? to : [to];
  const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const bccList = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [];
  const attachmentsToSend = attachments;
  const composerAttachments = attachmentsToSend.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.contentId }));

  // Resend does not carry In-Reply-To/References through as an option on
  // .emails.send — set them via raw headers so a real mail client (Gmail,
  // Outlook…) on the other end still threads the reply, even though nothing
  // in this app reads that header back.
  const replyHeaders = inReplyTo?.message_id_header
    ? { 'In-Reply-To': inReplyTo.message_id_header, References: inReplyTo.message_id_header }
    : undefined;

  const mailOptions = {
    from, to: toList,
    cc: ccList.length ? ccList : undefined,
    bcc: bccList.length ? bccList : undefined,
    subject, text, html: brandedHtml,
    attachments: composerAttachments,
    headers: replyHeaders,
  };

  const sendResult = await resend().emails.send({
    from,
    to: toList,
    cc: ccList.length ? ccList : undefined,
    bcc: bccList.length ? bccList : undefined,
    subject: subject || '(no subject)',
    text,
    html: brandedHtml,
    attachments: attachmentsToSend.map((a) => ({ filename: a.filename, content: a.content, content_id: a.contentId })),
    headers: replyHeaders,
  });
  if (sendResult.error) {
    throw new Error(`Resend rejected the message: ${sendResult.error.message || JSON.stringify(sendResult.error)}`);
  }

  const rawBuffer = await buildRaw(mailOptions);

  return mailboxMessageStore.storeMessage({
    mailbox,
    direction: 'OUTBOUND',
    folder: 'SENT',
    messageIdHeader: sendResult.data?.id || null,
    fromAddress: mailbox.address,
    toAddresses: toList,
    ccAddresses: ccList,
    bccAddresses: bccList,
    inReplyToId: inReplyTo?.id || null,
    subject,
    bodyText: text,
    bodyHtml: brandedHtml,
    rawBuffer,
    attachments: attachmentsToSend.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content, contentId: a.contentId })),
  });
}

/**
 * Save a draft — same shape as sendFromMailbox, minus the actual Resend
 * call. Nothing is delivered and no message_id_header exists yet (there is
 * no real outbound mail to have gotten one), so the draft row exists purely
 * so Drafts can list it and Compose can reopen it later.
 */
async function saveDraft(mailbox, { to, cc, bcc, subject, text, html, attachments = [], inReplyTo = null }) {
  const toList = to ? (Array.isArray(to) ? to : [to]) : [];
  const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const bccList = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [];

  const rawBuffer = await buildRaw({
    from: mailbox.display_name ? `"${mailbox.display_name}" <${mailbox.address}>` : mailbox.address,
    to: toList.length ? toList : undefined,
    cc: ccList.length ? ccList : undefined,
    bcc: bccList.length ? bccList : undefined,
    subject, text, html,
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });

  return mailboxMessageStore.storeMessage({
    mailbox,
    direction: 'OUTBOUND',
    folder: 'DRAFTS',
    messageIdHeader: null,
    fromAddress: mailbox.address,
    toAddresses: toList,
    ccAddresses: ccList,
    bccAddresses: bccList,
    inReplyToId: inReplyTo?.id || null,
    subject,
    bodyText: text,
    bodyHtml: html,
    rawBuffer,
    attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
  });
}

module.exports = { sendFromMailbox, saveDraft };
