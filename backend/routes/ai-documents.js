/**
 * Generated documents — listing and download.
 *
 * Access is checked per document rather than per endpoint. A PDF produced by
 * the assistant can contain the entire AR ledger, so "authenticated" is not a
 * sufficient answer to "may you read this one": the creator and management can,
 * nobody else. That is also why there is no signed-URL scheme — a link that is
 * itself the credential ends up in email threads and tickets.
 */

const express = require('express');
const router = express.Router();
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const documentStore = require('../services/pdf/documentStore');

router.use(auth);

// content_type (migration 128) -> MIME type for the download response. Kept
// here rather than in documentStore.js, which only knows file extensions.
const MIME_TYPES = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  markdown: 'text/markdown; charset=utf-8',
  code: 'text/plain; charset=utf-8',
};

router.get('/', async (req, res) => {
  try {
    const mine = req.query.mine !== 'false';
    const docs = await documentStore.listDocuments({
      userId: mine ? req.user.id : undefined,
      agentRunId: req.query.agent_run_id,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json({ success: true, count: docs.length, data: docs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id/download', async (req, res) => {
  try {
    const doc = await documentStore.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });
    if (!documentStore.canAccess(doc, req.user)) {
      return res.status(403).json({ success: false, error: 'You do not have access to this document.' });
    }
    if (doc.expires_at && new Date(doc.expires_at) < new Date()) {
      return res.status(410).json({ success: false, error: 'This document has expired.' });
    }

    const bytes = documentStore.readDocumentBytes(doc);
    res.setHeader('Content-Type', MIME_TYPES[doc.content_type] || 'application/octet-stream');
    // Header values are Latin-1, but a document title — and therefore its file
    // name — may be in any script now that the renderer handles Unicode. Sending
    // "Отчёт.pdf" raw makes Node reject the header outright, so the name is sent
    // twice per RFC 6266: an ASCII-only `filename` any client understands, and a
    // percent-encoded `filename*` that carries the real one. Quotes are stripped
    // because an unescaped one splits the header, and the title is partly
    // model-authored.
    const asciiName = doc.file_name.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '_') || 'document.pdf';
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`
    );
    res.setHeader('Content-Length', bytes.length);
    res.send(bytes);
  } catch (error) {
    console.error('Document download error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /:id/save-to-drive
 *
 * A direct user action (a button click, not the model deciding), so it goes
 * straight to the same custom handler drive_upload_file uses rather than
 * through the AI tool-calling loop — there is a human clicking this button
 * right now, which is exactly the confirmation that tool would otherwise ask
 * for. Requires the user's Google connector to already be connected (AI
 * Settings → Connectors); this does not initiate that OAuth flow itself.
 */
router.post('/:id/save-to-drive', async (req, res) => {
  try {
    const doc = await documentStore.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });
    if (!documentStore.canAccess(doc, req.user)) {
      return res.status(403).json({ success: false, error: 'You do not have access to this document.' });
    }

    const connectors = require('../services/ai/connectors');
    const { getProvider } = require('../services/ai/connectorProviders');
    const { getCustomHandler } = require('../services/ai/connectorCustomTools');

    const connected = await connectors.listConnected();
    const googleConnector = connected.find((c) => c.provider === 'google');
    if (!googleConnector) {
      return res.status(400).json({ success: false, error: 'Connect Google (Drive) first in AI Settings → Connectors.' });
    }

    const driveUploadFile = getCustomHandler('driveUploadFile');
    const result = await driveUploadFile(
      googleConnector,
      getProvider('google'),
      { document_id: doc.id, folder_id: req.body?.folder_id },
      { userId: req.user.id, role: req.user.role }
    );

    res.json({ success: true, drive_file_id: result.id, name: result.name, web_view_link: result.webViewLink });
  } catch (error) {
    console.error('Save to Drive error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/purge-expired', requireManagerOrAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await documentStore.purgeExpired() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
