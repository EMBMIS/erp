/**
 * Template-driven PDF rendering.
 *
 * services/pdf/pdfService.js renders documents whose layout is fixed in code —
 * an invoice looks like an invoice. This module renders documents whose layout
 * is *data*: a list of sections, styled by a row in `pdf_templates`. That is
 * what lets the AI produce a report nobody wrote a renderer for, and what lets
 * a user restyle every generated document without touching code.
 *
 * A document is `{ title, subtitle, sections[] }`. Each section is one of:
 *
 *   { type: 'heading',   text }
 *   { type: 'paragraph', text }
 *   { type: 'metrics',   items: [{ label, value, hint }] }   — the KPI band
 *   { type: 'table',     columns: [...], rows: [[...]|{...}], totals? }
 *   { type: 'keyvalue',  items: [{ label, value }] }
 *   { type: 'list',      items: ['...'] }
 *   { type: 'callout',   text, tone: info|warn }
 *   { type: 'divider' } | { type: 'spacer', size }
 *   { type: 'pagebreak' }
 *
 * Unknown section types are skipped with a visible note rather than throwing.
 * A model will eventually invent a section type, and losing one block of a
 * report is a much better failure than losing the whole document — but silently
 * dropping it would leave a report that looks complete and isn't.
 */

const path = require('path');
const PDFDocument = require('pdfkit');

// Bundled so Cyrillic, Vietnamese diacritics, Azerbaijani letters (Ə/ə) etc.
// render as glyphs instead of blank boxes — pdfkit's Standard-14 fonts
// (Helvetica/Times/Courier) are WinAnsi/Latin-1 only.
const NOTO_REGULAR = path.join(__dirname, '../../assets/fonts/NotoSans-Regular.ttf');
const NOTO_BOLD = path.join(__dirname, '../../assets/fonts/NotoSans-Bold.ttf');

function registerUnicodeFonts(doc) {
  doc.registerFont('NotoSans', NOTO_REGULAR);
  doc.registerFont('NotoSans-Bold', NOTO_BOLD);
}

const COMPANY = {
  name: process.env.COMPANY_NAME || 'Simeli ERP',
  address: process.env.COMPANY_ADDRESS || '',
  email: process.env.COMPANY_EMAIL || '',
  phone: process.env.COMPANY_PHONE || '',
};

const DEFAULT_TEMPLATE = {
  key: 'standard_report',
  page_size: 'A4',
  orientation: 'portrait',
  margin: 50,
  header: { show_company: true, show_rule: true, align: 'left' },
  footer: { show_page_numbers: true, show_generated_at: true },
  colors: { primary: '#2563eb', text: '#111827', muted: '#6b7280', border: '#e5e7eb', band: '#f3f4f6' },
  fonts: { family: 'NotoSans', base_size: 10, heading_size: 14 },
};

/**
 * Chrome per kind of document.
 *
 * Everything used to render as a financial report: company letterhead, an
 * accent rule under the title, "Generated <timestamp>" and "Page 1 of 1" on
 * every page — because the one built-in template said so and it was applied
 * whenever no template was named. That is right for a management report and
 * wrong for a letter, a certificate or a CV, and the only escape was to create
 * a stored template first, which is far too much ceremony for a one-off
 * document.
 *
 * These are defaults, not a fixed menu: a named template still wins over the
 * preset, and explicit per-document style wins over both. `plain` is the
 * fallback deliberately — when nobody has said what the document is, a clean
 * page is a much better guess than someone else's letterhead.
 */
const DOCUMENT_PRESETS = {
  plain: {
    header: { show_company: false, show_rule: false },
    footer: { show_page_numbers: false, show_generated_at: false },
  },
  report: {
    header: { show_company: true, show_rule: true },
    footer: { show_page_numbers: true, show_generated_at: true },
  },
  letter: {
    header: { show_company: true, show_rule: false },
    footer: { show_page_numbers: false, show_generated_at: false },
  },
  memo: {
    header: { show_company: true, show_rule: true },
    footer: { show_page_numbers: false, show_generated_at: false },
  },
  certificate: {
    margin: 90,
    header: { show_company: false, show_rule: false, align: 'center' },
    footer: { show_page_numbers: false, show_generated_at: false },
  },
  statement: {
    header: { show_company: true, show_rule: true },
    footer: { show_page_numbers: true, show_generated_at: false },
  },
};

const DEFAULT_DOCUMENT_TYPE = 'plain';

// NotoSans is the real default (Unicode: Cyrillic, Vietnamese, Latin Extended).
// Times-Roman/Courier remain available as explicit stylistic opt-ins, but a
// template naming anything else — or Helvetica, which cannot render non-Latin
// scripts — must fall back rather than throw at render time, halfway through a
// scheduled agent run.
const SAFE_FAMILIES = new Set(['NotoSans', 'Times-Roman', 'Courier']);

/**
 * Resolve the effective template, least to most specific:
 *   built-in defaults → document-type preset → stored template → inline style.
 *
 * A stored template beats the preset because naming one is an explicit request
 * for that styling; inline style beats everything because it is the most
 * specific thing the caller said about this one document.
 */
function mergeTemplate(template, { documentType, style } = {}) {
  const preset = DOCUMENT_PRESETS[String(documentType || '').toLowerCase()] || {};
  const layers = [preset, template || {}, style || {}];

  const merged = {
    ...DEFAULT_TEMPLATE,
    header: { ...DEFAULT_TEMPLATE.header },
    footer: { ...DEFAULT_TEMPLATE.footer },
    colors: { ...DEFAULT_TEMPLATE.colors },
    fonts: { ...DEFAULT_TEMPLATE.fonts },
  };

  for (const layer of layers) {
    const { header, footer, colors, fonts, ...rest } = layer;
    // Only defined values overwrite — a stored template row carries explicit
    // nulls for columns that were never set, and those must not erase a preset.
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
    Object.assign(merged.header, header || {});
    Object.assign(merged.footer, footer || {});
    Object.assign(merged.colors, colors || {});
    Object.assign(merged.fonts, fonts || {});
  }

  return merged;
}

function fontsFor(template) {
  const family = SAFE_FAMILIES.has(template.fonts.family) ? template.fonts.family : 'NotoSans';
  const bold = family === 'Times-Roman' ? 'Times-Bold' : `${family}-Bold`;
  return {
    regular: family,
    bold,
    base: Number(template.fonts.base_size) || 10,
    heading: Number(template.fonts.heading_size) || 14,
  };
}

// A colour that pdfkit cannot parse throws mid-render, which would turn a bad
// hex string in a template into a failed agent run.
function color(value, fallback) {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(value || '')) ? value : fallback;
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function ensureRoom(doc, needed) {
  const limit = doc.page.height - doc.page.margins.bottom - 30;
  if (doc.y + needed > limit) doc.addPage();
}

function drawHeading(doc, s, tpl, f) {
  ensureRoom(doc, f.heading + 14);
  doc.moveDown(0.6);
  doc.font(f.bold).fontSize(f.heading).fillColor(color(tpl.colors.text, '#111827'));
  doc.text(text(s.text));
  doc.moveDown(0.3);
}

function drawParagraph(doc, s, tpl, f) {
  doc.font(f.regular).fontSize(f.base).fillColor(color(tpl.colors.text, '#111827'));
  doc.text(text(s.text), { align: s.align || 'left' });
  doc.moveDown(0.4);
}

/**
 * The KPI band. Laid out as fixed-width cells across the content width so a
 * report's headline numbers read as a row of figures rather than a paragraph.
 */
function drawMetrics(doc, s, tpl, f) {
  const items = Array.isArray(s.items) ? s.items.slice(0, 8) : [];
  if (!items.length) return;
  const left = doc.page.margins.left;
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const perRow = Math.min(items.length, 4);
  const cellWidth = available / perRow;
  const cellHeight = 52;

  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow);
    ensureRoom(doc, cellHeight + 8);
    const top = doc.y;
    row.forEach((item, idx) => {
      const x = left + idx * cellWidth;
      doc.roundedRect(x + 2, top, cellWidth - 4, cellHeight, 4)
        .fillAndStroke(color(tpl.colors.band, '#f3f4f6'), color(tpl.colors.border, '#e5e7eb'));
      doc.fillColor(color(tpl.colors.muted, '#6b7280')).font(f.regular).fontSize(f.base - 2)
        .text(text(item.label), x + 10, top + 8, { width: cellWidth - 20, ellipsis: true });
      doc.fillColor(color(tpl.colors.primary, '#2563eb')).font(f.bold).fontSize(f.base + 5)
        .text(text(item.value), x + 10, top + 20, { width: cellWidth - 20, ellipsis: true });
      if (item.hint) {
        doc.fillColor(color(tpl.colors.muted, '#6b7280')).font(f.regular).fontSize(f.base - 3)
          .text(text(item.hint), x + 10, top + 38, { width: cellWidth - 20, ellipsis: true });
      }
    });
    doc.y = top + cellHeight + 8;
    doc.x = left;
  }
  doc.fillColor(color(tpl.colors.text, '#111827'));
}

/**
 * Rows may arrive as arrays or as objects keyed by column name — a model
 * produces both, and rejecting one of them would be a pointless failure.
 */
function normaliseRows(columns, rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (Array.isArray(row)) return row.map(text);
    if (row && typeof row === 'object') return columns.map((c) => text(row[c] ?? row[String(c).toLowerCase()] ?? ''));
    return [text(row)];
  });
}

function drawTable(doc, s, tpl, f) {
  const columns = (Array.isArray(s.columns) && s.columns.length
    ? s.columns
    : Object.keys((Array.isArray(s.rows) && s.rows[0]) || {})).map(text);
  if (!columns.length) return;

  const rows = normaliseRows(columns, s.rows);
  const left = doc.page.margins.left;
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Width proportional to the widest cell in each column, so a column of dates
  // does not get the same space as one of descriptions.
  const weights = columns.map((c, i) => {
    const longest = rows.reduce((max, r) => Math.max(max, String(r[i] ?? '').length), String(c).length);
    return Math.min(Math.max(longest, 6), 44);
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => (w / totalWeight) * available);

  // Right-align a column whose values are all numeric — figures that do not
  // line up on the decimal point are much harder to compare down a column.
  const numeric = columns.map((_, i) =>
    rows.length > 0 && rows.every((r) => r[i] === '' || /^-?[\d,.\s()%$€£]+$/.test(String(r[i]))));

  const rowHeight = f.base + 8;
  const header = () => {
    const top = doc.y;
    doc.rect(left, top, available, rowHeight).fill(color(tpl.colors.band, '#f3f4f6'));
    doc.fillColor(color(tpl.colors.text, '#111827')).font(f.bold).fontSize(f.base - 1);
    let x = left;
    columns.forEach((c, i) => {
      doc.text(c, x + 4, top + 4, { width: widths[i] - 8, align: numeric[i] ? 'right' : 'left', ellipsis: true });
      x += widths[i];
    });
    doc.y = top + rowHeight;
  };

  ensureRoom(doc, rowHeight * 3);
  header();

  doc.font(f.regular).fontSize(f.base - 1);
  rows.forEach((row, rowIndex) => {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
      // Repeat the header on the new page — a table continuing across a page
      // break without column names is unreadable on paper.
      header();
      doc.font(f.regular).fontSize(f.base - 1);
    }
    const top = doc.y;
    if (rowIndex % 2 === 1) {
      doc.rect(left, top, available, rowHeight).fill('#fbfbfc');
    }
    doc.fillColor(color(tpl.colors.text, '#111827'));
    let x = left;
    row.forEach((cell, i) => {
      doc.text(cell, x + 4, top + 4, { width: widths[i] - 8, align: numeric[i] ? 'right' : 'left', ellipsis: true });
      x += widths[i];
    });
    doc.y = top + rowHeight;
  });

  if (Array.isArray(s.totals) && s.totals.length) {
    const top = doc.y;
    doc.moveTo(left, top).lineTo(left + available, top).strokeColor(color(tpl.colors.border, '#e5e7eb')).stroke();
    doc.font(f.bold).fontSize(f.base - 1).fillColor(color(tpl.colors.text, '#111827'));
    let x = left;
    normaliseRows(columns, [s.totals])[0].forEach((cell, i) => {
      doc.text(cell, x + 4, top + 4, { width: widths[i] - 8, align: numeric[i] ? 'right' : 'left', ellipsis: true });
      x += widths[i];
    });
    doc.y = top + rowHeight;
  }

  doc.x = left;
  doc.moveDown(0.6);
}

function drawKeyValue(doc, s, tpl, f) {
  const items = Array.isArray(s.items) ? s.items : [];
  const labelWidth = 150;
  doc.fontSize(f.base);
  items.forEach((item) => {
    ensureRoom(doc, f.base + 8);
    const top = doc.y;
    const left = doc.page.margins.left;
    doc.font(f.bold).fillColor(color(tpl.colors.muted, '#6b7280'))
      .text(text(item.label), left, top, { width: labelWidth, ellipsis: true });
    doc.font(f.regular).fillColor(color(tpl.colors.text, '#111827'))
      .text(text(item.value), left + labelWidth, top, {
        width: doc.page.width - doc.page.margins.right - left - labelWidth,
      });
    doc.y = Math.max(doc.y, top + f.base + 4);
    doc.x = left;
  });
  doc.moveDown(0.4);
}

function drawList(doc, s, tpl, f) {
  const items = Array.isArray(s.items) ? s.items : [];
  doc.font(f.regular).fontSize(f.base).fillColor(color(tpl.colors.text, '#111827'));
  items.forEach((item) => {
    ensureRoom(doc, f.base + 6);
    doc.text(`•  ${text(item)}`, { indent: 8 });
  });
  doc.moveDown(0.4);
}

function drawCallout(doc, s, tpl, f) {
  const warn = s.tone === 'warn';
  const body = text(s.text);
  const left = doc.page.margins.left;
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font(f.regular).fontSize(f.base);
  const height = doc.heightOfString(body, { width: available - 24 }) + 16;
  ensureRoom(doc, height + 8);
  const top = doc.y;
  doc.roundedRect(left, top, available, height, 4)
    .fillAndStroke(warn ? '#fffbeb' : color(tpl.colors.band, '#f3f4f6'), warn ? '#fcd34d' : color(tpl.colors.border, '#e5e7eb'));
  doc.fillColor(warn ? '#92400e' : color(tpl.colors.text, '#111827'))
    .text(body, left + 12, top + 8, { width: available - 24 });
  doc.y = top + height + 8;
  doc.x = left;
}

function drawDivider(doc, tpl) {
  ensureRoom(doc, 14);
  doc.moveDown(0.4);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(color(tpl.colors.border, '#e5e7eb')).stroke();
  doc.moveDown(0.6);
}

const SECTION_RENDERERS = {
  heading: drawHeading,
  paragraph: drawParagraph,
  text: drawParagraph,
  metrics: drawMetrics,
  table: drawTable,
  keyvalue: drawKeyValue,
  list: drawList,
  callout: drawCallout,
};

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function drawHeader(doc, tpl, f, title, subtitle) {
  const left = doc.page.margins.left;
  const align = ['left', 'center', 'right'].includes(tpl.header.align) ? tpl.header.align : 'left';
  doc.y = doc.page.margins.top;

  if (tpl.header.show_company !== false) {
    doc.font(f.bold).fontSize(f.base + 2).fillColor(color(tpl.colors.text, '#111827'))
      .text(COMPANY.name, left, doc.y, { align });
    doc.font(f.regular).fontSize(f.base - 2).fillColor(color(tpl.colors.muted, '#6b7280'));
    if (COMPANY.address) doc.text(COMPANY.address, { align });
    const contact = [COMPANY.email, COMPANY.phone].filter(Boolean).join('  |  ');
    if (contact) doc.text(contact, { align });
    doc.moveDown(0.5);
  }

  // 'Report' as the last-resort title is only right for a report; for anything
  // else an untitled document should simply have no title line.
  const heading = text(title || tpl.header.title || '');
  if (heading) {
    doc.font(f.bold).fontSize(f.heading + 4).fillColor(color(tpl.colors.primary, '#2563eb'));
    doc.text(heading, { align });
  }

  const sub = subtitle || tpl.header.subtitle;
  if (sub) {
    doc.font(f.regular).fontSize(f.base).fillColor(color(tpl.colors.muted, '#6b7280')).text(text(sub), { align });
  }

  if (tpl.header.show_rule !== false) {
    doc.moveDown(0.4);
    doc.moveTo(left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .lineWidth(2).strokeColor(color(tpl.colors.primary, '#2563eb')).stroke();
    doc.lineWidth(1);
  }
  doc.moveDown(0.8);
  doc.x = left;
}

/**
 * Footers are written after the body, over buffered pages, because "page 3 of 7"
 * cannot be known while page 3 is being written.
 *
 * The bottom margin is temporarily zeroed for each page. pdfkit treats any text
 * whose top edge is past `page.maxY()` (height minus the bottom margin) as an
 * overflow and silently ADDS A PAGE for it — so writing a footer in the margin,
 * which is the only place a footer goes, appended a blank page per page and put
 * the footer at the top of it. The visible symptom was simply no footers at all.
 */
function drawFooters(doc, tpl, f, generatedAt) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const margins = doc.page.margins;
    const originalBottom = margins.bottom;
    margins.bottom = 0;

    const bottom = doc.page.height - originalBottom + 8;
    const left = margins.left;
    const width = doc.page.width - margins.left - margins.right;

    doc.font(f.regular).fontSize(f.base - 3).fillColor(color(tpl.colors.muted, '#6b7280'));
    const parts = [];
    if (tpl.footer.text) parts.push(text(tpl.footer.text));
    if (tpl.footer.show_generated_at !== false) parts.push(`Generated ${generatedAt}`);
    if (parts.length) doc.text(parts.join('  •  '), left, bottom, { width, align: 'left', lineBreak: false });
    if (tpl.footer.show_page_numbers !== false) {
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, left, bottom, { width, align: 'right', lineBreak: false });
    }

    margins.bottom = originalBottom;
  }
}

/**
 * Render a document. Returns a Buffer.
 *
 * @param {object} spec { title, subtitle, sections[] }
 * @param {object} template a pdf_templates row (or nothing, for the default)
 * @param {object} options { documentType, style } — chrome for this one
 *   document, when no stored template says otherwise. See DOCUMENT_PRESETS.
 */
async function renderDocument(spec = {}, template = null, options = {}) {
  const tpl = mergeTemplate(template, options);
  const f = fontsFor(tpl);
  const margin = Math.min(Math.max(Number(tpl.margin) || 50, 10), 150);

  const doc = new PDFDocument({
    size: tpl.page_size || 'A4',
    layout: tpl.orientation === 'landscape' ? 'landscape' : 'portrait',
    margin,
    bufferPages: true,
    info: { Title: String(spec.title || 'Report').slice(0, 200) },
  });
  registerUnicodeFonts(doc);

  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  drawHeader(doc, tpl, f, spec.title, spec.subtitle);

  const sections = Array.isArray(spec.sections) ? spec.sections : [];
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const type = String(section.type || 'paragraph').toLowerCase();

    if (type === 'pagebreak') { doc.addPage(); continue; }
    if (type === 'divider') { drawDivider(doc, tpl); continue; }
    if (type === 'spacer') { doc.moveDown(Number(section.size) || 1); continue; }

    const renderer = SECTION_RENDERERS[type];
    if (!renderer) {
      // Visible, not silent: a report that quietly lost a section still looks
      // complete, and the reader has no way to know a number is missing.
      drawCallout(doc, { text: `[Unsupported section type "${type}" was skipped.]`, tone: 'warn' }, tpl, f);
      continue;
    }
    renderer(doc, section, tpl, f);
  }

  drawFooters(doc, tpl, f, generatedAt);
  doc.end();
  return done;
}

/**
 * Substitute {{path.to.value}} references in a template's stored sections
 * against caller-supplied data. Templates are documents with holes in them, so
 * this is what makes "monthly financial summary" reusable month to month.
 *
 * Missing paths render as an empty string rather than the literal placeholder:
 * a finished document showing `{{total}}` reads as a bug to whoever receives it,
 * while a blank reads as missing data, which is what it is.
 */
function interpolate(value, data) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, path) => {
      const resolved = lookup(data, path);
      return resolved === undefined || resolved === null ? '' : text(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, data));
  if (value && typeof value === 'object') {
    // A whole-value reference ({{rows}}) must yield the array itself, not its
    // string form, or a table template could never receive its rows.
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') {
        const whole = v.match(/^\{\{\s*([\w.[\]]+)\s*\}\}$/);
        if (whole) {
          const resolved = lookup(data, whole[1]);
          out[k] = resolved === undefined ? '' : resolved;
          continue;
        }
      }
      out[k] = interpolate(v, data);
    }
    return out;
  }
  return value;
}

function lookup(data, path) {
  return String(path).split(/[.[\]]+/).filter(Boolean).reduce(
    (acc, key) => (acc === null || acc === undefined ? undefined : acc[key]),
    data
  );
}

module.exports = {
  renderDocument,
  interpolate,
  mergeTemplate,
  DEFAULT_TEMPLATE,
  DOCUMENT_PRESETS,
  DEFAULT_DOCUMENT_TYPE,
};
