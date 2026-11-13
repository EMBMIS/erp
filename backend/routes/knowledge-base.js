/**
 * Knowledge base document upload/list/delete.
 *
 * These are the documents services/ai/ragRetrieval.js draws on to give the
 * AI chat automatic context about this company's own policies and
 * procedures — see services/ai/knowledgeBase.js for the ingestion pipeline
 * (chunk + embed on upload, into document_embeddings via documentSearch.js).
 *
 * Uploading is manager/admin-only: an indexed document becomes something the
 * assistant will quote to any user who asks a related question, which makes
 * it closer to a policy publication than a personal file.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const { scopedMulter } = require('../middleware/scopedMulter');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const knowledgeBase = require('../services/ai/knowledgeBase');
const { decodeText } = require('../services/ai/textEncoding');

router.use(auth);

const EXT_TO_FORMAT = { txt: 'text', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', pdf: 'pdf' };

function formatFromFileName(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  return EXT_TO_FORMAT[ext] || 'text';
}

router.get('/', async (req, res) => {
  try {
    const docs = await knowledgeBase.listDocuments();
    res.json({ success: true, count: docs.length, data: docs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /upload — either a file (multipart, field `file`) or pasted text
 * (`title` + `content` + optional `format`, JSON body). Both land in the same
 * kb_documents row; only the source differs.
 */
router.post('/upload', requireManagerOrAdmin, scopedMulter(upload.single('file')), async (req, res) => {
  try {
    let doc;
    if (req.file) {
      const format = formatFromFileName(req.file.originalname);
      doc = await knowledgeBase.createDocument({
        title: req.body?.title || req.file.originalname,
        format,
        // decodeText tries UTF-8 first and only falls back to Windows-1250
        // when the bytes are not valid UTF-8, instead of silently turning
        // every non-UTF-8 byte into U+FFFD (mangling accented text).
        content: format === 'pdf' ? undefined : decodeText(req.file.buffer),
        buffer: format === 'pdf' ? req.file.buffer : undefined,
        fileName: req.file.originalname,
        userId: req.user.id,
      });
    } else {
      if (!req.body?.title || !req.body?.content) {
        return res.status(400).json({ success: false, error: 'Provide a file upload or a title + content.' });
      }
      doc = await knowledgeBase.createDocument({
        title: req.body.title,
        format: req.body.format || 'text',
        content: req.body.content,
        userId: req.user.id,
      });
    }
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.delete('/:id', requireManagerOrAdmin, async (req, res) => {
  try {
    await knowledgeBase.deleteDocument(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/** Re-run indexing for anything not currently 'indexed' — recovers from a transient embeddings failure. */
router.post('/reindex', requireManagerOrAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await knowledgeBase.indexPending() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
