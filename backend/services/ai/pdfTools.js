/**
 * Document-generation tools.
 *
 * The AI could already point at PDFs the ERP renders for its own records
 * (get_invoice_pdf_link). These tools let it *produce* documents that no
 * developer wrote a renderer for: "the top ten overdue customers, as a PDF I
 * can send to the CFO" becomes a real file with a real download link, in chat or
 * from an unattended agent run.
 *
 * Registered into services/ai/toolRegistry.js alongside the built-ins, so they
 * are governed by the same audit log, the same per-tool settings and the same
 * confirmation tiers.
 *
 * The tools that WRITE something a human will see externally — creating a
 * template, emailing a document — are flagged appropriately:
 *   • create_pdf_template writes configuration, not business data, so it
 *     behaves like the other draft-creating tools.
 *   • email_document is highImpact. It leaves the building. In chat that means
 *     an explicit confirmation before it sends; in an agent it additionally
 *     requires "email_document" in that agent's allowed_actions and `act` mode.
 *     Both gates exist because "email the CFO every Monday" is exactly the
 *     request that should be easy to set up and impossible to trigger by
 *     accident.
 */

const { pool } = require('../../config/database');
const { renderDocument, interpolate, DOCUMENT_PRESETS, DEFAULT_DOCUMENT_TYPE } = require('../pdf/templatedPdf');
const templateStore = require('../pdf/templateStore');
const documentStore = require('../pdf/documentStore');

const SECTION_SCHEMA = {
  type: 'array',
  description:
    'Ordered document body. Each item is one of: ' +
    '{"type":"heading","text":"..."}; ' +
    '{"type":"paragraph","text":"..."}; ' +
    '{"type":"metrics","items":[{"label":"...","value":"...","hint":"..."}]}; ' +
    '{"type":"table","columns":["A","B"],"rows":[["1","2"]],"totals":["Total","3"]}; ' +
    '{"type":"keyvalue","items":[{"label":"...","value":"..."}]}; ' +
    '{"type":"list","items":["..."]}; ' +
    '{"type":"callout","text":"...","tone":"info|warn"}; ' +
    '{"type":"divider"}; {"type":"spacer","size":1}; {"type":"pagebreak"}.',
  items: { type: 'object' },
};

// Cap on how much flattened text goes into metadata.indexable_text per
// document. This is provenance for search indexing, not the document itself —
// a report with an enormous table does not need its full text quoted back
// into the metadata JSONB.
const INDEXABLE_TEXT_LIMIT = 20000;

/**
 * Flatten a section body down to plain text, for document search
 * (services/ai/documentSearch.js#indexGeneratedDocuments). generated_documents
 * stores only the rendered PDF bytes, not the text that produced them, so this
 * is captured once at generation time rather than re-derived later by parsing
 * the PDF (which would need a new dependency this codebase does not have).
 */
function flattenSectionsText(sections) {
  const parts = [];
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    if (typeof s.text === 'string' && s.text.trim()) parts.push(s.text.trim());
    if (Array.isArray(s.items)) {
      for (const item of s.items) {
        if (typeof item === 'string') parts.push(item);
        else if (item && typeof item === 'object') {
          parts.push([item.label, item.value, item.hint].filter(Boolean).join(': '));
        }
      }
    }
    if (Array.isArray(s.columns) && s.columns.length) parts.push(s.columns.join(' | '));
    if (Array.isArray(s.rows)) {
      for (const row of s.rows) {
        if (Array.isArray(row)) parts.push(row.join(' | '));
        else if (row && typeof row === 'object') parts.push(Object.values(row).join(' | '));
      }
    }
  };
  (Array.isArray(sections) ? sections : []).forEach(walk);
  return parts.join('\n').trim().slice(0, INDEXABLE_TEXT_LIMIT);
}

/** Everything a caller needs to fetch the document, in one consistent shape. */
function documentResult(doc, extra = {}) {
  return {
    document_id: doc.id,
    title: doc.title,
    file_name: doc.file_name,
    byte_size: doc.byte_size,
    download_url: doc.download_path,
    created_at: doc.created_at,
    ...extra,
  };
}

const pdfTools = [
  {
    name: 'generate_pdf_report',
    description:
      'Build ANY PDF document — a report, letter, memo, certificate, statement, CV, notice, agenda — from a title and an ordered list of sections (headings, paragraphs, metric bands, tables, lists, callouts), and return a download link. ' +
      'Always set document_type to what the document actually is: it controls whether the page carries company letterhead, an accent rule, page numbers and a "Generated <date>" footer. A letter or certificate wearing report chrome looks wrong. ' +
      'Write the content in whatever language the user asked for. Put real figures from other tools into the sections — never invent them.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title, shown on the first page. Omit for a document that should have no title line.' },
        subtitle: { type: 'string', description: 'Optional line under the title, e.g. the period covered or the recipient' },
        sections: SECTION_SCHEMA,
        document_type: {
          type: 'string',
          description:
            'What this document is, which sets its chrome. One of: ' +
            '"report" (company letterhead, accent rule, page numbers, generated-at — for management/financial reporting); ' +
            '"letter" (letterhead, no rule, no footer); ' +
            '"memo" (letterhead and rule, no footer); ' +
            '"statement" (letterhead, rule, page numbers, no generated-at); ' +
            '"certificate" (no letterhead, centred, wide margins, no footer); ' +
            '"plain" (a clean page — no letterhead, no rule, no footer). ' +
            'Defaults to "plain", so choose deliberately rather than leaving it unset.',
        },
        style: {
          type: 'object',
          description:
            'Optional per-document overrides, beating the document_type preset: ' +
            '{ orientation, margin, colors: {primary,text,muted,border,band}, header: {show_company,show_rule,align}, footer: {text,show_page_numbers,show_generated_at} }. ' +
            'Use for a one-off look; use create_pdf_template only when the user wants the styling again later.',
        },
        template_key: { type: 'string', description: 'Optional stored template key. Only pass one the user asked for by name — otherwise leave unset and let document_type decide.' },
      },
      required: ['title', 'sections'],
    },
    handler: async (args, ctx = {}) => {
      const template = await templateStore.resolveTemplate(args.template_key);
      const documentType = args.document_type || DEFAULT_DOCUMENT_TYPE;
      const buffer = await renderDocument(
        { title: args.title, subtitle: args.subtitle, sections: args.sections || [] },
        template,
        { documentType, style: args.style }
      );
      const indexableText = flattenSectionsText(args.sections);
      const doc = await documentStore.saveDocument(buffer, {
        title: args.title,
        kind: DOCUMENT_PRESETS[documentType] ? documentType : 'plain',
        templateKey: template?.key,
        userId: ctx.userId,
        agentRunId: ctx.runId || null,
        metadata: {
          sections: (args.sections || []).length,
          document_type: documentType,
          actor: ctx.actor || 'ai-agent',
          ...(indexableText ? { indexable_text: indexableText } : {}),
        },
      });
      return documentResult(doc, { template: template?.key, document_type: documentType });
    },
  },

  {
    name: 'generate_custom_pdf',
    description:
      'Render a stored PDF template that has its own body, filling its {{placeholders}} from the data you supply. Use this for a recurring document whose layout was designed once — a monthly summary, a statement — rather than composing sections from scratch each time.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        template_key: { type: 'string', description: 'Key of the template to render' },
        data: { type: 'object', description: 'Values for the template placeholders, e.g. {"period":"June 2026","rows":[["A","1"]]}' },
        title: { type: 'string', description: 'Overrides the template title' },
      },
      required: ['template_key'],
    },
    handler: async (args, ctx = {}) => {
      const template = await templateStore.resolveTemplate(args.template_key);
      const sections = template.sections || [];
      if (!Array.isArray(sections) || !sections.length) {
        // Rendering the letterhead alone and calling it a document would be a
        // silent, confusing success.
        throw new Error(
          `The template "${template.key}" has no body sections, so there is nothing to fill in. Use generate_pdf_report with explicit sections, or add sections to the template.`
        );
      }
      const data = args.data || {};
      const filled = interpolate(sections, data);
      const title = args.title || interpolate(template.header?.title || template.name, data);

      const buffer = await renderDocument({ title, subtitle: interpolate(template.header?.subtitle || '', data), sections: filled }, template);
      const indexableText = flattenSectionsText(filled);
      const doc = await documentStore.saveDocument(buffer, {
        title,
        kind: 'templated',
        templateKey: template.key,
        userId: ctx.userId,
        agentRunId: ctx.runId || null,
        metadata: {
          template: template.key,
          actor: ctx.actor || 'ai-agent',
          ...(indexableText ? { indexable_text: indexableText } : {}),
        },
      });
      return documentResult(doc, { template: template.key });
    },
  },

  {
    name: 'generate_invoice_pdf',
    description:
      'Render a customer invoice as a PDF and return a download link. Unlike get_invoice_pdf_link (which points at the live endpoint), this stores a copy that can be attached to an email or kept with an agent run.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { invoice_id: { type: 'string', description: 'Customer invoice UUID' } },
      required: ['invoice_id'],
    },
    handler: async (args, ctx = {}) => {
      const CustomerInvoice = require('../../models/CustomerInvoice');
      const invoice = await CustomerInvoice.findById(args.invoice_id);
      if (!invoice) throw new Error('Invoice not found.');

      const { generateInvoicePdf, renderToBuffer } = require('../pdf/pdfService');
      // The existing generator is reused deliberately: an invoice the AI emails
      // must be byte-for-byte the document the ERP itself produces, not a
      // lookalike that could differ in a legally meaningful way.
      const buffer = await renderToBuffer(generateInvoicePdf(invoice));

      const doc = await documentStore.saveDocument(buffer, {
        title: `Invoice ${invoice.invoice_number}`,
        kind: 'invoice',
        userId: ctx.userId,
        agentRunId: ctx.runId || null,
        metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number, customer: invoice.customer_name },
      });
      return documentResult(doc, { invoice_number: invoice.invoice_number, outstanding: invoice.outstanding_amount });
    },
  },

  {
    name: 'list_pdf_templates',
    description: 'List the available PDF templates (key, name, whether they carry their own body sections). Use before generate_custom_pdf, or to tell the user what styling exists.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const templates = await templateStore.listTemplates();
      return {
        count: templates.length,
        templates: templates.map((t) => ({
          key: t.key,
          name: t.name,
          description: t.description,
          orientation: t.orientation,
          has_body: Array.isArray(t.sections) && t.sections.length > 0,
          placeholders: placeholdersIn(t.sections),
          is_builtin: t.is_builtin,
          version: t.version,
        })),
      };
    },
  },

  {
    name: 'create_pdf_template',
    description:
      'Create a reusable PDF template: colours, letterhead and optionally a body of sections containing {{placeholders}} that generate_custom_pdf fills in later. Use when the user asks for a document format they will want again ("a template for monthly financial summaries").',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable identifier, lowercase with underscores, e.g. monthly_financial_summary' },
        name: { type: 'string' },
        description: { type: 'string' },
        orientation: { type: 'string', description: 'portrait (default) or landscape' },
        colors: { type: 'object', description: '{ primary, text, muted, border, band } as #rrggbb' },
        header: { type: 'object', description: '{ show_company, title, subtitle } — title/subtitle may contain placeholders' },
        footer: { type: 'object', description: '{ text, show_page_numbers, show_generated_at }' },
        sections: SECTION_SCHEMA,
      },
      required: ['key', 'name'],
    },
    handler: async (args, ctx = {}) => {
      const created = await templateStore.createTemplate(args, ctx.userId);
      return {
        key: created.key,
        name: created.name,
        version: created.version,
        placeholders: placeholdersIn(created.sections),
        note: `Render it with generate_custom_pdf({ template_key: "${created.key}", data: { ... } }).`,
      };
    },
  },

  {
    name: 'email_document',
    description:
      'Email an already-generated document as a PDF attachment. Only call this after generating the document and telling the user what it contains and who will receive it.',
    readOnly: false,
    // Leaves the building. Confirmed in chat; in an agent it also needs
    // email_document in allowed_actions and `act` mode.
    highImpact: true,
    min_role: 'MANAGER',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'id returned by a generate_*_pdf tool' },
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string' },
        message: { type: 'string', description: 'Body text of the email' },
      },
      required: ['document_id', 'to'],
    },
    handler: async (args, ctx = {}) => {
      const doc = await documentStore.getDocument(args.document_id);
      if (!doc) throw new Error('Document not found. Generate it first.');

      const to = String(args.to || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`"${args.to}" is not a valid email address.`);

      const bytes = documentStore.readDocumentBytes(doc);
      const emailService = require('../emailService');
      const { businessFrom } = require('../../config/sender');
      const subject = args.subject || doc.title;

      await emailService.sendEmail({
        from: businessFrom('info'),
        to,
        subject,
        text: args.message || `Please find "${doc.title}" attached.`,
        html: `<p>${escapeHtml(args.message || `Please find "${doc.title}" attached.`)}</p>`,
        attachments: [{ filename: doc.file_name, content: bytes, contentType: 'application/pdf' }],
      });

      // Recorded on the document so "who was this sent to" is answerable from
      // the document itself, not only from a mail server log.
      await pool.query(
        `UPDATE generated_documents
            SET metadata = metadata || jsonb_build_object('emailed_to', $2::text, 'emailed_at', CURRENT_TIMESTAMP::text)
          WHERE id = $1`,
        [doc.id, to]
      ).catch(() => {});

      return { sent: true, to, subject, document: doc.title, actor: ctx.actor || 'ai-agent' };
    },
  },

  {
    name: 'latex_to_pdf',
    description:
      'Typeset a complete LaTeX document and return a download link. Use this ONLY when the document genuinely needs LaTeX typography — mathematics, pgfplots charts, cross-references, bibliographies, deep multi-level structure. ' +
      'Do NOT reach for it merely because the text is not English: generate_pdf_report renders every script (Cyrillic, Vietnamese, Azerbaijani, CJK) correctly and in one call, whereas a LaTeX document usually takes several attempts to compile. ' +
      'Write a full document: \\documentclass through \\end{document}. Prefer packages that ship with a standard TeX distribution (booktabs, geometry, xcolor, amsmath, pgfplots, siunitx, longtable, fancyhdr).',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'The complete LaTeX document source' },
        title: { type: 'string', description: 'Title for the stored document (used as the file name)' },
      },
      required: ['source', 'title'],
    },
    handler: async (args, ctx = {}) => {
      const latex = require('../pdf/latexService');

      // An unavailable engine is reported as itself, with the fix, rather than
      // as a generic failure — and never by silently rendering something else.
      // A document asked for as LaTeX and delivered as an approximation is a
      // wrong answer that looks like a right one.
      const engine = latex.detectEngine();
      if (!engine.available) throw new Error(engine.reason);

      const { buffer, engine: used } = await latex.renderLatex(args.source);
      const doc = await documentStore.saveDocument(buffer, {
        title: args.title,
        kind: 'latex',
        userId: ctx.userId,
        agentRunId: ctx.runId || null,
        metadata: { engine: used, source_bytes: Buffer.byteLength(args.source, 'utf8'), actor: ctx.actor || 'ai-agent' },
      });
      return documentResult(doc, { engine: used });
    },
  },

  {
    name: 'check_latex_available',
    description: 'Check whether a LaTeX engine is installed on this server. Call this before writing a long LaTeX document, so you do not compose one that cannot be rendered.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => require('../pdf/latexService').latexStatus(),
  },

  {
    name: 'list_generated_documents',
    description: 'List PDFs generated recently, with their download links. Use when the user asks for a document they made earlier.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'default 20' } },
    },
    handler: async (args, ctx = {}) => {
      const docs = await documentStore.listDocuments({ userId: ctx.userId, limit: args.limit || 20 });
      return { count: docs.length, documents: docs };
    },
  },

  // -------------------------------------------------------------------------
  // Printable business documents (PO, quotation, payslip)
  // -------------------------------------------------------------------------
  {
    name: 'generate_po_pdf',
    description: 'Render a purchase order as a PDF and return a download link.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { po_id: { type: 'string', description: 'Purchase order UUID' } },
      required: ['po_id'],
    },
    handler: async (args, ctx = {}) => {
      const { pool } = require('../../config/database');
      const { rows: [po] } = await pool.query(
        'SELECT po.*, s.legal_name AS supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = $1',
        [args.po_id]
      );
      if (!po) throw new Error('Purchase order not found.');
      const { generatePurchaseOrderPdf, renderToBuffer } = require('../pdf/pdfService');
      const buffer = await renderToBuffer(generatePurchaseOrderPdf(po));
      const doc = await documentStore.saveDocument(buffer, {
        title: `PO ${po.po_number}`,
        kind: 'purchase_order',
        userId: ctx.userId,
        metadata: { po_id: po.id, po_number: po.po_number, supplier: po.supplier_name },
      });
      return documentResult(doc);
    },
  },
  {
    name: 'generate_quotation_pdf',
    description: 'Render a sales quotation as a PDF and return a download link.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { quotation_id: { type: 'string', description: 'Sales quotation UUID' } },
      required: ['quotation_id'],
    },
    handler: async (args, ctx = {}) => {
      const { pool } = require('../../config/database');
      const { rows: [q] } = await pool.query(
        'SELECT sq.*, c.customer_name FROM sales_quotations sq LEFT JOIN customers c ON sq.customer_id = c.id WHERE sq.id = $1',
        [args.quotation_id]
      );
      if (!q) throw new Error('Quotation not found.');
      const { generateTabularPdf, renderToBuffer } = require('../pdf/pdfService');
      const { rows: items } = await pool.query(
        'SELECT * FROM sales_quotation_items WHERE quotation_id = $1 ORDER BY line_number',
        [args.quotation_id]
      );
      const buffer = await renderToBuffer(generateTabularPdf(
        `Quotation ${q.quotation_number}`,
        [`Customer: ${q.customer_name}`, `Date: ${q.quotation_date}`, `Valid until: ${q.valid_until || 'N/A'}`],
        ['Item', 'Description', 'Qty', 'Unit Price', 'Line Total'],
        items.map(i => [i.item_code, i.item_name, i.quantity, i.unit_price, i.line_total])
      ));
      const doc = await documentStore.saveDocument(buffer, {
        title: `Quotation ${q.quotation_number}`,
        kind: 'quotation',
        userId: ctx.userId,
        metadata: { quotation_id: q.id, quotation_number: q.quotation_number, customer: q.customer_name },
      });
      return documentResult(doc);
    },
  },
  {
    name: 'generate_payslip_pdf',
    description: 'Render an employee payslip as a PDF and return a download link.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        payroll_run_id: { type: 'string', description: 'Payroll run UUID' },
        employee_id: { type: 'string', description: 'Employee UUID' },
      },
      required: ['payroll_run_id', 'employee_id'],
    },
    handler: async (args, ctx = {}) => {
      const { pool } = require('../../config/database');
      const { rows: [run] } = await pool.query('SELECT * FROM payroll_runs WHERE id = $1', [args.payroll_run_id]);
      if (!run) throw new Error('Payroll run not found.');
      const { rows: [item] } = await pool.query(
        'SELECT * FROM payroll_items WHERE payroll_run_id = $1 AND employee_id = $2',
        [args.payroll_run_id, args.employee_id]
      );
      if (!item) throw new Error('Payslip not found for this employee in this run.');
      const { rows: [emp] } = await pool.query('SELECT * FROM employees WHERE id = $1', [args.employee_id]);
      const { generatePayslipPdf, renderToBuffer } = require('../pdf/pdfService');
      const buffer = await renderToBuffer(generatePayslipPdf(run, item, emp || {}));
      const doc = await documentStore.saveDocument(buffer, {
        title: `Payslip ${item.employee_name} — ${run.period_year}-${String(run.period_month).padStart(2, '0')}`,
        kind: 'payslip',
        userId: ctx.userId,
        metadata: { payroll_run_id: run.id, employee_id: args.employee_id },
      });
      return documentResult(doc);
    },
  },
];

/** The {{names}} a template expects, so callers know what data to supply. */
function placeholdersIn(sections) {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      const matches = value.match(/\{\{\s*([\w.[\]]+)\s*\}\}/g) || [];
      matches.forEach((m) => found.add(m.replace(/[{}\s]/g, '')));
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(sections);
  return [...found];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { pdfTools, placeholdersIn, flattenSectionsText };
