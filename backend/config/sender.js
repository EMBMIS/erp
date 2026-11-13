/**
 * Outbound mail: the transport that can legally carry the From-address
 * policy, and the policy itself.
 *
 * Policy:
 *   - Account mail (signup, email verification, password reset, invites):
 *     noreply@embmis.com — never a person, never a shared mailbox.
 *   - Business mail to external parties (suppliers, customers, RFQs, POs,
 *     quotations, contracts, deliveries): auto-generated per company,
 *     <info|sales>.<company-slug>@embmis.com, so replies land in a
 *     company-named mailbox instead of a global address.
 *
 * Transport: embmis.com is a verified sending domain on the Resend account
 * (RESEND_API_KEY), and Resend allows any address @verified-domain as From.
 * The old Gmail SMTP (SMTP_USER/SMTP_PASS) cannot carry @embmis.com From
 * headers — Gmail silently rewrites them to the account address — so when
 * RESEND_API_KEY is present we send through Resend and only fall back to
 * SMTP for local development without a key.
 */

const nodemailer = require('nodemailer');

let resendClient = null;
function resend() {
  if (resendClient) return resendClient;
  const { Resend } = require('resend');
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured — outbound mail is unavailable.');
  resendClient = new Resend(apiKey);
  return resendClient;
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/** Company name → slug used in the auto-generated per-company addresses. */
function companySlug(companyName) {
  return slugify(companyName || process.env.COMPANY_NAME || '');
}

/** Account/security mail. */
function authFrom() {
  const domain = process.env.MAIL_DOMAIN || 'example.com';
  return process.env.AUTH_FROM_ADDRESS || `noreply@${domain}`;
}

/**
 * Business mail From. kind is 'sales' (quotations, orders, contracts, RFQs,
 * POs, deliveries) or 'info' (general notifications, partnership invites).
 * Falls back to the old SMTP_FROM when no company name is known anywhere —
 * better a generic address than a broken one.
 */
function businessFrom(kind = 'info', companyName) {
  const prefix = kind === 'sales' ? 'sales' : 'info';
  const slug = companySlug(companyName);
  const domain = process.env.MAIL_DOMAIN || 'example.com';
  if (!slug) return process.env.SMTP_FROM || process.env.SMTP_USER;
  return `${prefix}.${slug}@${domain}`;
}

/** Display-name form for From headers: `"Simeli ERP" <sales.simeli.erp@…>`. */
function businessLabel(kind, displayName, companyName) {
  const label = displayName || process.env.COMPANY_NAME || 'Simeli ERP';
  return `"${label}" <${businessFrom(kind, companyName)}>`;
}

/** Resend wants content, not paths — read path-style attachments upfront. */
function normalizeAttachments(attachments) {
  if (!attachments) return undefined;
  const fs = require('fs');
  return attachments.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: a.content !== undefined ? a.content : fs.readFileSync(a.path),
  }));
}

/**
 * Send one message. Returns { messageId, provider }.
 * Resend when a key is configured (the only transport that can use
 * @embmis.com From), SMTP otherwise (local dev without Resend).
 */
async function sendMail({ from, to, cc, subject, html, text, attachments }) {
  if (!to) throw new Error('An email needs a recipient.');
  const normalized = normalizeAttachments(attachments);

  if (process.env.RESEND_API_KEY) {
    const res = await resend().emails.send({
      from,
      to,
      cc,
      subject: subject || '(no subject)',
      text,
      html,
      attachments: normalized,
    });
    if (res.error) {
      throw new Error(`Resend rejected the message: ${res.error.message || JSON.stringify(res.error)}`);
    }
    const id = res.data && res.data.id;
    console.log(`[mail] sent via resend: ${id || '?'} to=${to} from=${from} subject=${(subject || '').slice(0, 80)}`);
    return { messageId: id, provider: 'resend' };
  }

  const smtpPort = parseInt(process.env.SMTP_PORT) || 587;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  const info = await transporter.sendMail({
    from: from || process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    cc,
    subject: subject || '(no subject)',
    html,
    text,
    attachments: normalized,
  });
  return { messageId: info.messageId, provider: 'smtp' };
}

module.exports = { sendMail, authFrom, businessFrom, businessLabel, companySlug };
