/**
 * AI-generated mail branding — Admin > Mail Design.
 *
 * One design per company (see migration 202609021200 and
 * services/mailBrandingService.js): an admin uploads a logo, a vision model
 * reads its colors and produces an HTML email template, and every mailbox in
 * the company sends through that template from then on
 * (mailboxOutboundService.sendFromMailbox).
 */

const express = require('express');
const multer = require('multer');
const { auth, requireAdmin } = require('../middleware/auth');
const { scopedMulter } = require('../middleware/scopedMulter');
const mailBrandingService = require('../services/mailBrandingService');
const mailStorage = require('../services/mailStorage');

const router = express.Router();

// GET /api/mail-branding/logo/:companyId — the hosted logo image every
// branded outbound email's <img> tag actually loads (see
// mailBrandingService.render()). Deliberately public: a recipient's mail
// client fetches this with no login of any kind, and a company logo isn't
// sensitive — the same trust level as the logo already shown on the public
// login page. Mounted BEFORE router.use(auth) below, and reads through
// getLogoBytes() rather than getForCompany() precisely because there is no
// login here to have established a company context from.
router.get('/logo/:companyId', async (req, res) => {
  try {
    const logo = await mailBrandingService.getLogoBytes(req.params.companyId);
    if (!logo) return res.status(404).end();
    res.setHeader('Content-Type', logo.contentType || 'image/png');
    // Short-ish cache: long enough that one send's worth of opens doesn't
    // re-fetch per recipient, short enough that a redesign (or Remove
    // design) shows up in mail opened afterward without a hard cache-bust.
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(logo.buffer);
  } catch (error) {
    console.error('Get mail branding logo error:', error);
    res.status(500).end();
  }
});

router.use(auth);

const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// Sample content for the settings-page preview only — never sent to anyone.
// A real send fills {{SUBJECT}}/{{BODY}} with the actual message instead
// (mailboxOutboundService.js). Reads like a real note rather than a generic
// "your order was approved" so what's being previewed is obviously the
// *design*, not a stand-in business notification.
const PREVIEW_SUBJECT = 'Take a look at our new email design';
const PREVIEW_BODY = `
  <p style="margin:0 0 12px;">Dear valued customer,</p>
  <p style="margin:0 0 12px;">We've refreshed the look of our emails to feel more like us. This is just a preview
  of the new design — the colors and logo above are pulled straight from our brand, so every email you get from
  us going forward will look and feel like this one.</p>
  <p style="margin:0;">Thank you for being with us.</p>
`;

function fillPreview(htmlTemplate, logoDataUrl) {
  return htmlTemplate
    .replace(/\{\{SUBJECT\}\}/g, PREVIEW_SUBJECT)
    .replace(/\{\{BODY\}\}/g, PREVIEW_BODY)
    .replace(/cid:company-logo/g, logoDataUrl);
}

// Shared response shape for GET/generate/update — includes the RAW
// html_template (still carrying the literal {{SUBJECT}}/{{BODY}}/cid:
// placeholders) alongside the filled-in previewHtml, so the settings page's
// edit box always has the real, editable template to work from rather than
// the placeholder-substituted preview.
async function brandingPayload(branding, logoBuffer) {
  const logoDataUrl = `data:${branding.logo_content_type};base64,${logoBuffer.toString('base64')}`;
  return {
    palette: branding.palette,
    updated_at: branding.updated_at,
    logoDataUrl,
    htmlTemplate: branding.html_template,
    previewHtml: fillPreview(branding.html_template, logoDataUrl),
  };
}

// GET /api/mail-branding — the company's current design (or null), with the
// logo as a data: URL and a filled-in preview so the settings page can show
// it without a second round trip. Any company member can read this (a
// mailbox user reasonably wants to see what their outgoing mail looks like),
// only an admin can change it.
router.get('/', async (req, res) => {
  try {
    const branding = await mailBrandingService.getForCompany(req.companyId);
    if (!branding) return res.json({ success: true, data: null });

    const { buffer } = await mailStorage.getObject(branding.logo_r2_key);
    res.json({ success: true, data: await brandingPayload(branding, buffer) });
  } catch (error) {
    console.error('Get mail branding error:', error);
    res.status(500).json({ success: false, error: 'Failed to load mail design' });
  }
});

// POST /api/mail-branding/generate — upload a logo, get a design back.
router.post('/generate', requireAdmin, scopedMulter(uploadLogo.single('logo')), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'A logo image is required.' });
  try {
    const branding = await mailBrandingService.generateFromLogo({
      companyId: req.companyId, buffer: req.file.buffer, contentType: req.file.mimetype, userId: req.user.id,
    });
    res.status(201).json({ success: true, data: await brandingPayload(branding, req.file.buffer) });
  } catch (error) {
    console.error('Generate mail branding error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate mail design' });
  }
});

// POST /api/mail-branding/redesign — "make it more minimal", "use warmer
// colors" — the primary way to change a design that didn't come out right.
// An AI text call revises the existing template from the instruction rather
// than starting over; see mailBrandingService.redesignFromInstruction.
router.post('/redesign', requireAdmin, async (req, res) => {
  const { instruction } = req.body || {};
  try {
    const branding = await mailBrandingService.redesignFromInstruction(req.companyId, instruction, req.user.id);
    const { buffer } = await mailStorage.getObject(branding.logo_r2_key);
    res.json({ success: true, data: await brandingPayload(branding, buffer) });
  } catch (error) {
    console.error('Redesign mail branding error:', error);
    res.status(400).json({ success: false, error: error.message || 'Failed to redesign mail design' });
  }
});

// PATCH /api/mail-branding — hand-edit the template's HTML directly, for
// anyone who prefers that over describing the change in words above.
router.patch('/', requireAdmin, async (req, res) => {
  const { html_template: htmlTemplate } = req.body || {};
  try {
    const branding = await mailBrandingService.updateTemplate(req.companyId, htmlTemplate, req.user.id);
    const { buffer } = await mailStorage.getObject(branding.logo_r2_key);
    res.json({ success: true, data: await brandingPayload(branding, buffer) });
  } catch (error) {
    console.error('Update mail branding error:', error);
    res.status(400).json({ success: false, error: error.message || 'Failed to update mail design' });
  }
});

// DELETE /api/mail-branding — back to plain, unbranded mail.
router.delete('/', requireAdmin, async (req, res) => {
  try {
    await mailBrandingService.remove(req.companyId);
    res.json({ success: true });
  } catch (error) {
    console.error('Remove mail branding error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove mail design' });
  }
});

module.exports = router;
