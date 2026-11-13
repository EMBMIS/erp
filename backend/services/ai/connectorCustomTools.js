/**
 * Connector tools that are not "call this REST path with these arguments".
 *
 * Every named tool in connectorProviders.js is declarative — a path, a method,
 * a query/body template — because apiFetch's job is a JSON request and almost
 * everything is one. A file upload is not: Drive, OneDrive and Box all want
 * `multipart/related` (metadata plus raw bytes) posted to a *different*
 * endpoint than the one that reads or lists files, and apiFetch has no way to
 * express that — it always JSON-encodes.
 *
 * That gap is exactly what produced a real bug: asked to put a report in
 * Drive, the assistant fell back to the generic api_request tool, POSTed the
 * file's metadata as JSON to the ordinary /drive/v3/files endpoint, and Drive
 * did precisely what it was asked — created a file with that name and no
 * content. "The file exists but the size is 0" was not a Drive quirk, it was
 * this system never having offered a real upload tool.
 *
 * A handler here is looked up by name from a provider's tool spec
 * (`custom: 'driveUploadFile'`) and takes the full (connector, config, args,
 * ctx) it needs, rather than being squeezed into the templated shape.
 */

const crypto = require('crypto');
const connectors = require('./connectors');

/**
 * Upload a PDF this ERP already generated into Google Drive.
 *
 * Takes a `document_id` rather than raw bytes as a tool argument on purpose:
 * the model has no way to pass binary content through a JSON tool call, but it
 * already has the id from whatever generate_pdf_report / generate_invoice_pdf
 * / latex_to_pdf call made the file, and the bytes are read here, server-side,
 * from the same storage those tools use — never round-tripped through the
 * model as text.
 */
async function driveUploadFile(connector, config, args, ctx) {
  const documentStore = require('../pdf/documentStore'); // lazy: avoids a require cycle at load time

  const documentId = String(args.document_id || '').trim();
  if (!documentId) throw new Error('document_id is required — generate the PDF first, then pass its id here.');

  const row = await documentStore.getDocument(documentId);
  if (!row) {
    throw new Error(`No generated document with id "${documentId}". Generate one with generate_pdf_report, generate_invoice_pdf, generate_custom_pdf or latex_to_pdf, then use the document_id from its result.`);
  }
  if (!documentStore.canAccess(row, { id: ctx?.userId, role: ctx?.role })) {
    throw new Error('You do not have access to that document.');
  }

  const bytes = documentStore.readDocumentBytes(row);
  const fileName = String(args.name || row.file_name || 'document').trim();
  // Any artifact type (migration 128), not just PDF — pick Drive's mimeType
  // from what this row actually is rather than assuming PDF.
  const mimeType = {
    pdf: 'application/pdf', html: 'text/html', svg: 'image/svg+xml',
    markdown: 'text/markdown', code: 'text/plain',
  }[row.content_type] || 'application/octet-stream';

  const metadata = { name: fileName, mimeType };
  if (args.folder_id) metadata.parents = [String(args.folder_id)];

  // Multipart/related per Drive's upload API: a JSON metadata part, then the
  // file's actual bytes, joined by a boundary that cannot collide with either
  // (random, and never derived from anything the model or the file contains).
  const boundary = `qira_${crypto.randomBytes(16).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const result = await connectors.apiFetchRaw('/upload/drive/v3/files', {
    connector,
    config,
    account: connector.account_info || {},
    method: 'POST',
    query: { uploadType: 'multipart', fields: 'id,name,size,webViewLink' },
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return result.body;
}

const HANDLERS = { driveUploadFile };

function getCustomHandler(key) {
  return HANDLERS[key] || null;
}

module.exports = { getCustomHandler };
