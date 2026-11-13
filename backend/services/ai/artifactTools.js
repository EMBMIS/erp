/**
 * Generic artifact generation — HTML, SVG, Markdown and code, alongside the
 * PDF-only tools in pdfTools.js.
 *
 * pdfTools.js renders anything into a fixed PDF layout via templatedPdf.js's
 * section renderer. That's the right tool for a report, letter or statement,
 * but it forces everything through one visual language. This module is for
 * when the assistant should hand back the real thing instead — a working
 * HTML page, an SVG diagram, a Markdown writeup, a runnable code snippet —
 * stored and downloadable the same way a PDF is (documentStore.js, migration
 * 128), but rendered by the chat UI as what it actually is: HTML/SVG get a
 * live sandboxed preview, Markdown renders through the same pipeline chat
 * messages already use, code gets syntax highlighting.
 *
 * Read-only in the same sense pdfTools' generators are: this writes a file to
 * this ERP's own document store, not to any business record, so it carries no
 * highImpact/confirmation requirement.
 */

const documentStore = require('../pdf/documentStore');

const MAX_CONTENT_BYTES = 2_000_000; // 2MB — generous for any of these formats, not for embedding a video as base64

/** Everything a caller needs to fetch or render the artifact, in one shape. */
function artifactResult(doc) {
  return {
    document_id: doc.id,
    title: doc.title,
    file_name: doc.file_name,
    byte_size: doc.byte_size,
    download_url: doc.download_path,
    content_type: doc.content_type,
    language: doc.language || undefined,
    created_at: doc.created_at,
  };
}

const artifactTools = [
  {
    name: 'generate_artifact',
    description:
      'Create a generic artifact — HTML, SVG, Markdown, or a code snippet — and return a link to it, the way generate_pdf_report does for documents. ' +
      'Use "html" for an interactive page, chart, or mini-app (the chat UI renders it live in a sandboxed preview — assume no network access and no access to this ERP\'s cookies or session). ' +
      'Use "svg" for a diagram or vector graphic. Use "markdown" for a writeup that should render with headings/lists/tables rather than as a code block. Use "code" for a snippet meant to be read or run elsewhere — set language so it displays and downloads correctly. ' +
      'Prefer generate_pdf_report instead when the user actually wants a printable/downloadable document (report, letter, statement) — this tool is for the artifact ITSELF, not a document about it.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, shown on the artifact card' },
        type: { type: 'string', description: 'One of: html, svg, markdown, code' },
        content: { type: 'string', description: 'The full artifact content — complete HTML document, SVG markup, Markdown text, or code' },
        language: { type: 'string', description: 'For type="code" only — e.g. python, javascript, sql. Controls syntax highlighting and the download extension.' },
      },
      required: ['title', 'type', 'content'],
    },
    handler: async (args, ctx = {}) => {
      const type = String(args.type || '').toLowerCase();
      if (!['html', 'svg', 'markdown', 'code'].includes(type)) {
        throw new Error(`Unknown artifact type "${args.type}". Use one of: html, svg, markdown, code.`);
      }
      const content = String(args.content || '');
      if (!content.trim()) throw new Error('An artifact needs actual content.');
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
        throw new Error(`That content is too large for an artifact (over ${Math.round(MAX_CONTENT_BYTES / 1_000_000)}MB). Split it up or use generate_pdf_report for long documents.`);
      }

      const doc = await documentStore.saveDocument(Buffer.from(content, 'utf8'), {
        title: args.title,
        kind: 'artifact',
        contentType: type,
        language: type === 'code' ? (args.language || undefined) : undefined,
        userId: ctx.userId,
        agentRunId: ctx.runId || null,
        metadata: { actor: ctx.actor || 'ai-agent', artifact_type: type },
      });

      return artifactResult(doc);
    },
  },
];

module.exports = { artifactTools, artifactResult, MAX_CONTENT_BYTES };
