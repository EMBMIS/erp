/**
 * AI-generated mail branding — one email design per company, built from a
 * photo of the company's logo by a vision model.
 *
 * generateFromLogo() is the one function both call sites (the admin "Mail
 * Design" settings page and the AI chat tool — see toolRegistry.js's
 * generate_mail_branding) actually run; each just gets the logo bytes to it
 * a different way (a file upload vs. an attachment already in the
 * conversation). render() is the other half: what mailboxOutboundService
 * calls on every outbound send to wrap the plain message in that design.
 *
 * The logo goes out as a hosted https:// image (routes/mailBranding.js'
 * public GET /logo/:companyId, backed by getLogoBytes below), not a cid:
 * inline attachment — see render()'s own comment for why the inline
 * approach didn't actually work in real inboxes.
 */

const { pool } = require('../config/database');
const { getAIClient, AI_VISION_MODEL } = require('../config/aiConfig');
const { safeJsonParse } = require('./aiJson');
const mailStorage = require('./mailStorage');
const modelRouter = require('./ai/modelRouter');
const companyContext = require('./companyContext');

const LOGO_CONTENT_ID = 'company-logo';

function sniffMime(buffer) {
  if (!buffer || buffer.length < 4) return 'image/png';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/png';
}

function logoKey(companyId) {
  return `mail-branding/${companyId}/logo`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// <br>, <br/>, <br />, any case.
const BR_TAG = /<br\s*\/?>/gi;

/**
 * Turn a plain-text message body into the HTML the branded template slots in.
 *
 * THE ORDER OF THESE TWO OPERATIONS IS THE WHOLE FUNCTION
 * ---------------------------------------------------------------------------
 * This used to read `p.replace(/\n/g, '<br>').replace(/</g, '&lt;')` — break
 * tags inserted first, escaping applied second. The escape pass then ate the
 * very tags the line before had introduced, so every newline in every branded
 * plain-text email arrived as the visible characters `<br>` instead of a line
 * break. Recipients saw "Hi there, <br> <br>I was looking at…" — the mark of
 * software that does not proofread its own output, on the one surface where
 * that judgement is made by strangers.
 *
 * Escaping comes first here, and the breaks are added to text that is already
 * safe. That ordering is not a style preference; reversing it reintroduces the
 * bug in a form no type checker will catch.
 *
 * A plain-text body that ALREADY carries <br> markup gets it honoured as a
 * line break rather than escaped into visible text. Text bodies written by a
 * model routinely contain them, and nobody has ever meant those five
 * characters literally in an email. Only that one tag is treated this way —
 * every other angle bracket in the text is still escaped, so a body
 * containing `<script>` is still inert.
 */
function textToHtml(bodyText) {
  return String(bodyText || '')
    .replace(BR_TAG, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

const DEFAULT_HTML_TEMPLATE = (palette) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:${palette.primary || '#1f2937'};padding:20px 28px;">
<img src="cid:${LOGO_CONTENT_ID}" alt="" height="36" style="display:block;">
</td></tr>
<tr><td style="padding:28px;color:#1f2937;font-size:14px;line-height:1.6;">
<h2 style="margin:0 0 14px;color:${palette.primary || '#1f2937'};font-size:18px;">{{SUBJECT}}</h2>
{{BODY}}
</td></tr>
<tr><td style="background:${palette.secondary || '#f4f4f5'};padding:16px 28px;color:#6b7280;font-size:11px;">
Sent via EMBMIS
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

/**
 * Ask the vision model to read the logo's brand colors and hand back a full
 * HTML email template built around them. Falls back to a plain template
 * using just the extracted palette (or gray, if even that fails) rather than
 * ever throwing — a broken vision call should degrade the design, not block
 * whatever screen is waiting on this.
 */
async function designFromLogo(buffer, contentType) {
  const fallback = { palette: {}, html: DEFAULT_HTML_TEMPLATE({}) };
  try {
    const client = getAIClient();
    // withFallback: on OpenRouter, falls through the ranked free vision
    // models if AI_VISION_MODEL is rate-limited or unavailable.
    const { value: response } = await modelRouter.withFallback('vision', (model, clientOverride) =>
      (clientOverride || client).chat.completions.create({
        model,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a company logo. Read its dominant colors and design a clean, professional HTML email '
                + 'template around them — a header band, a body area, a footer. Reply with ONLY a JSON object, no '
                + 'markdown fences, shaped exactly like: '
                + '{"palette": {"primary": "#hex", "secondary": "#hex", "text": "#hex"}, "html": "<!doctype html>...'
                + '"}. The html field is a COMPLETE HTML document (inline CSS only — table-based layout, no <style> '
                + 'block, no external assets, email-client-safe) that MUST contain, verbatim: '
                + 'the string <img src="cid:company-logo" ...> somewhere in the header to show the logo, '
                + 'the literal placeholder {{SUBJECT}} where the email subject goes, and '
                + 'the literal placeholder {{BODY}} where the message content goes. '
                + 'Design it to feel like it belongs to this specific company — do not default to generic blue.',
            },
            { type: 'image_url', image_url: { url: `data:${contentType || sniffMime(buffer)};base64,${buffer.toString('base64')}` } },
          ],
        }],
        max_tokens: 2000,
      }),
    AI_VISION_MODEL);
    const parsed = safeJsonParse(response.choices?.[0]?.message?.content, null);
    if (!parsed?.html || !parsed.html.includes('{{BODY}}') || !parsed.html.includes('cid:company-logo')) {
      return { palette: parsed?.palette || {}, html: DEFAULT_HTML_TEMPLATE(parsed?.palette || {}) };
    }
    return { palette: parsed.palette || {}, html: parsed.html };
  } catch (err) {
    console.error('Mail branding: vision design generation failed, using fallback template:', err.message);
    return fallback;
  }
}

/**
 * Generate (or replace) a company's mail design from a logo image.
 * @param {{companyId, buffer: Buffer, contentType, userId}} args
 */
async function generateFromLogo({ companyId, buffer, contentType, userId }) {
  if (!buffer?.length) throw new Error('A logo image is required.');
  const mime = contentType || sniffMime(buffer);
  const { palette, html } = await designFromLogo(buffer, mime);

  const key = logoKey(companyId);
  await mailStorage.putObject(key, buffer, mime);

  const { rows } = await pool.query(
    `INSERT INTO mail_branding (company_id, logo_r2_key, logo_content_type, palette, html_template, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id) DO UPDATE
       SET logo_r2_key = $2, logo_content_type = $3, palette = $4, html_template = $5,
           generated_by = $6, updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [companyId, key, mime, JSON.stringify(palette), html, userId || null]
  );
  return rows[0];
}

async function getForCompany(companyId) {
  const { rows } = await pool.query('SELECT * FROM mail_branding WHERE company_id = $1', [companyId]);
  return rows[0] || null;
}

/**
 * The logo's bytes, for the public (unauthenticated) hosted-image endpoint
 * an email's <img> tag actually loads. Deliberately routed through
 * companyContext.withCompany rather than the plain pool getForCompany()
 * uses: mail_branding is in company_scoped_tables (row-level security), and
 * every OTHER call in this file runs inside a request that already has an
 * ambient company context from the `auth` middleware — this one doesn't
 * (it's reached with no login at all, by a recipient's mail client), so it
 * has to establish that context itself from the company id in the URL,
 * the same bootstrapping shape mailboxService.resolveInboundMailbox uses
 * for the inbound mail webhook.
 */
async function getLogoBytes(companyId) {
  const branding = await companyContext.withCompany(companyId, (client) =>
    client.query('SELECT logo_r2_key, logo_content_type FROM mail_branding WHERE company_id = $1', [companyId])
      .then((r) => r.rows[0] || null)
  );
  if (!branding) return null;
  const { buffer } = await mailStorage.getObject(branding.logo_r2_key);
  return { buffer, contentType: branding.logo_content_type };
}

/**
 * Hand-edit the template directly — the AI draft is a starting point, not
 * the only option: an admin who doesn't like what came back can fix it
 * themselves without generating a new logo photo through the vision model
 * again. Requires an existing design (there is nothing to edit otherwise —
 * generate one from a logo first) and that the two placeholders survive the
 * edit, since render() has nothing else to slot the actual message into.
 */
async function updateTemplate(companyId, htmlTemplate, userId) {
  if (!htmlTemplate?.trim()) throw new Error('The template cannot be empty.');
  if (!htmlTemplate.includes('{{BODY}}')) throw new Error('The template must still contain the {{BODY}} placeholder.');
  if (!htmlTemplate.includes('{{SUBJECT}}')) throw new Error('The template must still contain the {{SUBJECT}} placeholder.');

  const { rows } = await pool.query(
    `UPDATE mail_branding SET html_template = $2, generated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1
    RETURNING *`,
    [companyId, htmlTemplate, userId || null]
  );
  if (!rows.length) throw new Error('No design exists yet for this company — generate one from a logo first.');
  return rows[0];
}

/**
 * Redesign the existing template from a plain-language instruction —
 * "make it more minimal", "use warmer colors", "put the logo on the right",
 * "I don't like this, try something completely different" — the primary way
 * to change a design that didn't come out right, rather than hand-editing
 * HTML. The model sees the CURRENT template and palette as context and is
 * asked to revise them, not start from nothing, so "make the header darker"
 * actually means the header, not a random new layout.
 *
 * A text model, not the vision one — this only ever reasons about existing
 * HTML/CSS and a written instruction, never looks at the logo image again.
 */
async function redesignFromInstruction(companyId, instruction, userId) {
  if (!instruction?.trim()) throw new Error('Describe what you want changed.');
  const branding = await getForCompany(companyId);
  if (!branding) throw new Error('No design exists yet for this company — generate one from a logo first.');

  const client = getAIClient();
  const { value: response } = await modelRouter.withFallback('text', (model, clientOverride) =>
    (clientOverride || client).chat.completions.create({
      model,
      messages: [{
        role: 'user',
        content: 'You previously designed this company\'s HTML email template. The person reviewing it wants a '
          + 'change. Revise the template to match their request — keep everything they did not ask you to change.\n\n'
          + `CURRENT PALETTE: ${JSON.stringify(branding.palette || {})}\n\n`
          + `CURRENT TEMPLATE:\n${branding.html_template}\n\n`
          + `REQUESTED CHANGE: ${instruction.trim()}\n\n`
          + 'Reply with ONLY a JSON object, no markdown fences, shaped exactly like: '
          + '{"palette": {"primary": "#hex", "secondary": "#hex", "text": "#hex"}, "html": "<!doctype html>..."}. '
          + 'The html field is a COMPLETE HTML document (inline CSS only — table-based layout, no <style> block, '
          + 'no external assets, email-client-safe) that MUST still contain, verbatim, the literal placeholders '
          + '{{SUBJECT}} and {{BODY}} — unless the request explicitly asks to remove the logo, also keep '
          + '<img src="cid:company-logo" ...> somewhere in it.',
      }],
      max_tokens: 2000,
    }),
  undefined);

  const parsed = safeJsonParse(response.choices?.[0]?.message?.content, null);
  if (!parsed?.html || !parsed.html.includes('{{BODY}}') || !parsed.html.includes('{{SUBJECT}}')) {
    throw new Error('Simeli could not apply that change cleanly — try rephrasing the request, or edit the HTML directly.');
  }

  const { rows } = await pool.query(
    `UPDATE mail_branding SET palette = $2, html_template = $3, generated_by = $4, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1
    RETURNING *`,
    [companyId, JSON.stringify(parsed.palette || branding.palette || {}), parsed.html, userId || null]
  );
  return rows[0];
}

async function remove(companyId) {
  const branding = await getForCompany(companyId);
  if (!branding) return false;
  await pool.query('DELETE FROM mail_branding WHERE company_id = $1', [companyId]);
  mailStorage.deleteObject(branding.logo_r2_key).catch((err) => console.error('R2 branding logo cleanup failed:', err.message));
  return true;
}

/**
 * Wrap one message's subject/body in the company's design. `bodyHtml` is
 * used as given if present; otherwise plain text is turned into <p>
 * paragraphs so the template always has real HTML to slot in, not raw
 * newlines a browser would collapse.
 *
 * The logo goes out as a hosted https:// image (GET /api/mail-branding/logo/
 * :companyId, public/unauthenticated — see routes/mailBranding.js), not a
 * cid: inline attachment. It used to be inline, which depends on the
 * sending API round-tripping an attachment's Content-ID into the actual
 * MIME correctly — Resend's emails.send does not do this reliably, so real
 * recipients (Gmail, Outlook) got the logo as a plain downloadable
 * attachment named "logo" with an empty header where the image should have
 * been. Our own mailbox reading pane never caught this: it fetches every
 * attachment separately and rewrites cid: references itself
 * (resolveInlineImages in Mailbox.jsx), which made the inline reference
 * LOOK like it worked there and nowhere else it actually mattered. Existing
 * templates already say cid:company-logo (that phrase came from the AI
 * generation prompt, unchanged) — swapping what it resolves to here needs
 * no regeneration.
 *
 * @returns {Promise<{html: string}|null>} null when the company has no
 *   design — callers send the plain, unbranded message.
 */
async function render(companyId, { subject, bodyHtml, bodyText }) {
  const branding = await getForCompany(companyId);
  if (!branding) return null;

  const bodyContent = bodyHtml || textToHtml(bodyText);

  const { apiBase } = require('../config/appLinks');
  const logoUrl = `${apiBase()}/api/mail-branding/logo/${companyId}`;

  const html = branding.html_template
    .replace(/\{\{SUBJECT\}\}/g, subject || '')
    .replace(/\{\{BODY\}\}/g, bodyContent)
    .replace(/cid:company-logo/g, logoUrl);

  return { html };
}

module.exports = {
  generateFromLogo, getForCompany, getLogoBytes, updateTemplate, redesignFromInstruction,
  remove, render, LOGO_CONTENT_ID,
  // Exported for tests: the escaping/line-break ordering here is the thing
  // that was wrong, and it is worth being able to assert directly rather than
  // only through a render() call that needs a database and a company design.
  textToHtml,
};
