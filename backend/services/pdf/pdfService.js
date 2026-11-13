/**
 * PDF document generation (invoices, purchase orders, payslips) using pdfkit.
 *
 * Each generator returns a PDFDocument stream the caller pipes to an HTTP
 * response or a file. Company letterhead is environment-configurable
 * (COMPANY_NAME/ADDRESS/EMAIL/PHONE) with sensible fallbacks so this works
 * out of the box.
 */

const path = require('path');
const PDFDocument = require('pdfkit');

const COMPANY = {
  name: process.env.COMPANY_NAME || 'Simeli ERP',
  address: process.env.COMPANY_ADDRESS || '',
  email: process.env.COMPANY_EMAIL || '',
  phone: process.env.COMPANY_PHONE || '',
};

// Bundled so invoices/POs/payslips can carry non-Latin customer names, notes
// etc. — pdfkit's built-in Helvetica is WinAnsi/Latin-1 only. Same fonts as
// services/pdf/templatedPdf.js.
const NOTO_REGULAR = path.join(__dirname, '../../assets/fonts/NotoSans-Regular.ttf');
const NOTO_BOLD = path.join(__dirname, '../../assets/fonts/NotoSans-Bold.ttf');

function registerUnicodeFonts(doc) {
  doc.registerFont('NotoSans', NOTO_REGULAR);
  doc.registerFont('NotoSans-Bold', NOTO_BOLD);
  return doc;
}

function money(n, currency = 'USD') {
  const v = Number(n || 0);
  return `${currency} ${v.toFixed(2)}`;
}

/**
 * A Date as YYYY-MM-DD in the server's own timezone.
 *
 * Deliberately not toISOString(): node-pg parses a DATE column to local
 * midnight, and toISOString() converts that to UTC — which east of Greenwich
 * lands on the previous day. An invoice dated the 1st printed as the last day
 * of the prior month, silently, and worst at month and year ends where the
 * period is what the document is about.
 */
function ymd(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function fmtDate(d) {
  if (!d) return '-';
  return ymd(d) || '-';
}

function drawLetterhead(doc, title, docNumber) {
  doc.fontSize(18).font('NotoSans-Bold').text(COMPANY.name, { continued: false });
  doc.fontSize(9).font('NotoSans').fillColor('#555');
  if (COMPANY.address) doc.text(COMPANY.address);
  const contactLine = [COMPANY.email, COMPANY.phone].filter(Boolean).join('  |  ');
  if (contactLine) doc.text(contactLine);
  doc.fillColor('#000');
  doc.moveDown(1);
  doc.fontSize(16).font('NotoSans-Bold').text(title, { align: 'right' });
  doc.fontSize(10).font('NotoSans').text(docNumber || '', { align: 'right' });
  doc.moveDown(1);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#cccccc').stroke();
  doc.moveDown(1);
}

function drawItemsTable(doc, headers, rows, colWidths) {
  const startX = doc.page.margins.left;
  let y = doc.y;
  const rowHeight = 20;

  doc.font('NotoSans-Bold').fontSize(9);
  let x = startX;
  headers.forEach((h, i) => { doc.text(h, x, y, { width: colWidths[i], align: i === 0 ? 'left' : 'right' }); x += colWidths[i]; });
  y += rowHeight;
  doc.moveTo(startX, y - 4).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 4).strokeColor('#cccccc').stroke();

  doc.font('NotoSans').fontSize(9);
  rows.forEach((row) => {
    if (y > doc.page.height - doc.page.margins.bottom - 60) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    x = startX;
    row.forEach((cell, i) => { doc.text(String(cell), x, y, { width: colWidths[i], align: i === 0 ? 'left' : 'right' }); x += colWidths[i]; });
    y += rowHeight;
  });
  doc.y = y + 8;
}

/**
 * Generate a customer invoice PDF. `invoice` must be the result of
 * CustomerInvoice.findById (includes .items[]).
 */
function generateInvoicePdf(invoice) {
  const doc = new PDFDocument({ margin: 50 });
  registerUnicodeFonts(doc);
  drawLetterhead(doc, 'INVOICE', invoice.invoice_number);

  doc.fontSize(10).font('NotoSans-Bold').text('Bill To:');
  doc.font('NotoSans').text(invoice.customer_name || '-');
  if (invoice.customer_email) doc.text(invoice.customer_email);
  doc.moveDown(0.5);
  doc.text(`Invoice Date: ${fmtDate(invoice.invoice_date)}`);
  doc.text(`Due Date: ${fmtDate(invoice.due_date)}`);
  if (invoice.so_number) doc.text(`Sales Order: ${invoice.so_number}`);
  doc.moveDown(1);

  const rows = (invoice.items || []).map((it) => [
    it.item_description || '-',
    it.quantity,
    money(it.unit_price, invoice.currency),
    money(it.line_total, invoice.currency),
  ]);
  drawItemsTable(doc, ['Description', 'Qty', 'Unit Price', 'Line Total'], rows, [260, 60, 100, 100]);

  doc.font('NotoSans').fontSize(10);
  doc.text(`Subtotal: ${money(invoice.subtotal, invoice.currency)}`, { align: 'right' });
  doc.text(`Tax: ${money(invoice.tax_amount, invoice.currency)}`, { align: 'right' });
  doc.text(`Discount: ${money(invoice.discount_amount, invoice.currency)}`, { align: 'right' });
  doc.font('NotoSans-Bold').text(`Total: ${money(invoice.total_amount, invoice.currency)}`, { align: 'right' });
  doc.font('NotoSans').text(`Paid: ${money(invoice.paid_amount, invoice.currency)}`, { align: 'right' });
  doc.font('NotoSans-Bold').text(`Outstanding: ${money(invoice.outstanding_amount, invoice.currency)}`, { align: 'right' });

  if (invoice.notes) { doc.moveDown(1); doc.font('NotoSans').fontSize(9).text(`Notes: ${invoice.notes}`); }

  doc.end();
  return doc;
}

/**
 * Generate a purchase order PDF. `po` should include `.items` (an array from
 * purchase_order_line_items) attached by the caller.
 */
function generatePurchaseOrderPdf(po) {
  const doc = new PDFDocument({ margin: 50 });
  registerUnicodeFonts(doc);
  drawLetterhead(doc, 'PURCHASE ORDER', po.po_number);

  doc.fontSize(10).font('NotoSans-Bold').text('Supplier:');
  doc.font('NotoSans').text(po.supplier_name || '-');
  if (po.supplier_email) doc.text(po.supplier_email);
  if (po.supplier_address) doc.text(po.supplier_address);
  doc.moveDown(0.5);
  doc.text(`Order Date: ${fmtDate(po.order_date || po.created_at)}`);
  if (po.expected_delivery_date) doc.text(`Expected Delivery: ${fmtDate(po.expected_delivery_date)}`);
  doc.text(`Status: ${po.status}`);
  doc.moveDown(1);

  const rows = (po.items || []).map((it) => [
    it.item_description || '-',
    it.quantity,
    money(it.unit_price, po.currency),
    money(it.line_total, po.currency),
  ]);
  drawItemsTable(doc, ['Description', 'Qty', 'Unit Price', 'Line Total'], rows, [260, 60, 100, 100]);

  doc.font('NotoSans').fontSize(10);
  doc.text(`Subtotal: ${money(po.subtotal, po.currency)}`, { align: 'right' });
  doc.text(`Tax: ${money(po.tax_amount, po.currency)}`, { align: 'right' });
  doc.font('NotoSans-Bold').text(`Total: ${money(po.total_amount, po.currency)}`, { align: 'right' });

  doc.end();
  return doc;
}

/**
 * Generate a payslip PDF for one employee's line within a payroll run.
 * `item` is a row from payroll_items; `run` is the parent payroll_runs row;
 * `employee` (optional) supplies allowance breakdown if available.
 */
function generatePayslipPdf(run, item, employee = {}) {
  const doc = new PDFDocument({ margin: 50 });
  registerUnicodeFonts(doc);
  drawLetterhead(doc, 'PAYSLIP', run.run_number);

  doc.fontSize(10).font('NotoSans-Bold').text('Employee:');
  doc.font('NotoSans').text(item.employee_name || '-');
  doc.moveDown(0.5);
  doc.text(`Pay Period: ${run.period_year}-${String(run.period_month).padStart(2, '0')}`);
  doc.moveDown(1);

  const rows = [
    ['Gross Salary', '', '', money(item.gross_salary)],
    ['Deductions', '', '', money(item.deductions)],
  ];
  if (employee.housing_allowance) rows.push(['Housing Allowance', '', '', money(employee.housing_allowance)]);
  if (employee.transport_allowance) rows.push(['Transport Allowance', '', '', money(employee.transport_allowance)]);
  drawItemsTable(doc, ['Description', '', '', 'Amount'], rows, [260, 60, 100, 100]);

  doc.font('NotoSans-Bold').fontSize(11).text(`Net Pay: ${money(item.net_salary)}`, { align: 'right' });

  doc.end();
  return doc;
}

// ---------------------------------------------------------------------------
// Generic tabular reports
// ---------------------------------------------------------------------------
//
// The document generators above each know their own layout because an invoice
// has a fixed shape. A saved report does not: it is whatever columns its SQL
// returned, in whatever types, and there may be forty of them. So this renders
// from the data rather than from a template.
//
// Everything below exists because of a specific way a naive grid fails on real
// report output:
//
//   • Column widths are measured from the content, not divided evenly. One
//     `description` column beside six short codes makes an even split unusable.
//   • Cells are single-line and ellipsised. Wrapping means variable row
//     heights, which means the page-break arithmetic has to run per row and
//     gets it wrong at the boundary; a report is a grid, not prose.
//   • The header row repeats on every page. A forty-page export whose columns
//     are named only on page one cannot be read.
//   • Numbers are detected and right-aligned, because a column of
//     left-aligned money is not scannable.

const TABLE_FONT_SIZE = 8;
const TABLE_ROW_HEIGHT = 14;
const CELL_PADDING = 4;
const MIN_COL_WIDTH = 34;

/** Format one cell value for display. */
function formatCell(value, decimals = null) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return ymd(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    // `decimals` is the column's decision (see decimalsForColumns); on its own a
    // cell cannot know that the 0 beside it belongs to a money column.
    if (decimals !== null) return value.toFixed(decimals);
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === 'object') return JSON.stringify(value);

  const s = String(value);
  // Postgres hands back timestamps as strings; show the date part only, which
  // is what a report reader wants and what keeps the column narrow.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.split('T')[0];
  return s;
}

/**
 * Which columns hold numbers, so they can be right-aligned.
 *
 * Decided per column from the data rather than per cell: aligning cell by cell
 * makes a column with one null or one 'n/a' ragged.
 */
function detectNumericColumns(columns, rows) {
  const sample = rows.slice(0, 200);
  return columns.map((col) => {
    let numeric = 0;
    let present = 0;
    for (const row of sample) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      present += 1;
      if (typeof v === 'number' || (typeof v === 'string' && /^-?[\d,]+(\.\d+)?$/.test(v.trim()))) {
        numeric += 1;
      }
    }
    return present > 0 && numeric === present;
  });
}

/**
 * How many decimal places each numeric column should show, or null to leave the
 * column alone.
 *
 * Per column rather than per cell, because precision is a property of what the
 * column measures. A money column that happens to hold a round number renders
 * it as `0` and `371` beside `1375.50`, which reads as a different quantity
 * rather than the same one — and in an accounts report that is the column
 * people are checking. If anything in the column has decimals, everything in it
 * gets the same width; integer columns (ids, counts, quantities) are untouched.
 *
 * The widest precision in the column wins, capped at four places. Two would be
 * enough for money, but it is not only money that reaches here — a tax rate of
 * 0.0825 rendered as `0.08` is not a narrower column, it is a different number.
 * The cap exists for the other direction: a float that arrived as 3.3333333
 * must not push every value in its column to seven places.
 */
function decimalsForColumns(columns, rows, numeric) {
  const sample = rows.slice(0, 200);
  return columns.map((col, i) => {
    if (!numeric[i]) return null;
    let places = 0;
    for (const row of sample) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
      if (!Number.isFinite(n) || Number.isInteger(n)) continue;
      const frac = String(n).split('.')[1];
      if (frac) places = Math.max(places, Math.min(frac.length, 4));
    }
    // Floored at two so a fractional column reads as money by default: an
    // amount of 1000.5 belongs under a 1000.50, not beside it.
    return places > 0 ? Math.max(places, 2) : null;
  });
}

/**
 * Column widths measured from the content and scaled to fill the page.
 *
 * Scaled rather than clipped when the natural widths overflow: a report with
 * more columns than fit still has to produce something readable, and shrinking
 * every column proportionally degrades better than dropping the last ones.
 */
function computeColumnWidths(doc, columns, rows, available, decimals = []) {
  const sample = rows.slice(0, 200);

  const natural = columns.map((col, i) => {
    doc.font('NotoSans-Bold').fontSize(TABLE_FONT_SIZE);
    let widest = doc.widthOfString(String(col));
    doc.font('NotoSans').fontSize(TABLE_FONT_SIZE);
    for (const row of sample) {
      // Measured with the same precision it will be drawn at, or a column
      // padded out to 2dp overflows the width measured from its bare integers.
      const text = formatCell(row[col], decimals[i] ?? null);
      if (!text) continue;
      // Very long free-text cells would otherwise claim the whole page; they
      // are ellipsised at render time anyway.
      const w = doc.widthOfString(text.length > 60 ? text.slice(0, 60) : text);
      if (w > widest) widest = w;
    }
    return Math.max(MIN_COL_WIDTH, widest + CELL_PADDING * 2);
  });

  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= available) {
    // Spread the slack proportionally so the table fills the page rather than
    // huddling against the left margin.
    const scale = available / total;
    return natural.map((w) => w * scale);
  }

  // Overflowing: shrink the columns that have room to give, keeping every
  // column at least MIN_COL_WIDTH so none collapses to nothing.
  const floor = columns.length * MIN_COL_WIDTH;
  if (floor >= available) return columns.map(() => available / columns.length);

  const shrinkable = total - floor;
  const excess = total - available;
  return natural.map((w) => w - ((w - MIN_COL_WIDTH) / shrinkable) * excess);
}

/**
 * Render any rowset as a paginated PDF table.
 *
 * @param {string}   title    Heading, also used as the document title.
 * @param {string[]} columns  Column keys, in display order.
 * @param {object[]} rows     Row objects keyed by column.
 * @param {object}   options  { subtitle, landscape, meta, truncated }
 * @returns {PDFDocument}     Ended stream, ready to pipe.
 */
function generateTabularPdf(title, columns, rows, options = {}) {
  const cols = Array.isArray(columns) && columns.length
    ? columns
    : Object.keys(rows[0] || {});
  const data = Array.isArray(rows) ? rows : [];

  // Portrait holds about six columns before cells become unreadable; past that
  // landscape is the difference between a usable report and a wall of ellipses.
  const landscape = options.landscape !== undefined ? options.landscape : cols.length > 6;

  const doc = new PDFDocument({
    margin: 36,
    layout: landscape ? 'landscape' : 'portrait',
    size: 'A4',
    bufferPages: true,          // needed to number pages once the total is known
    info: { Title: title || 'Report' },
  });
  registerUnicodeFonts(doc);

  const left = doc.page.margins.left;
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = doc.page.height - doc.page.margins.bottom - 24;

  // --- Heading --------------------------------------------------------------
  doc.fontSize(14).font('NotoSans-Bold').fillColor('#000').text(COMPANY.name, left, doc.page.margins.top);
  doc.fontSize(13).font('NotoSans-Bold').text(title || 'Report');
  doc.fontSize(8).font('NotoSans').fillColor('#555');
  if (options.subtitle) doc.text(options.subtitle);
  doc.text(`${data.length} row${data.length === 1 ? '' : 's'} — generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`);
  if (options.meta) doc.text(options.meta);
  if (options.truncated) {
    doc.fillColor('#b45309').text('This report hit the row limit — it shows a truncated result set.');
  }
  doc.fillColor('#000').moveDown(0.8);

  if (!cols.length) {
    doc.fontSize(10).font('NotoSans').text('This report returned no columns.');
    doc.end();
    return doc;
  }

  const numeric = detectNumericColumns(cols, data);
  const decimals = decimalsForColumns(cols, data, numeric);
  const widths = computeColumnWidths(doc, cols, data, available, decimals);

  const drawHeaderRow = (y) => {
    doc.rect(left, y - 2, available, TABLE_ROW_HEIGHT).fill('#f1f5f9');
    doc.fillColor('#000').font('NotoSans-Bold').fontSize(TABLE_FONT_SIZE);
    let x = left;
    cols.forEach((col, i) => {
      doc.text(String(col), x + CELL_PADDING, y + 2, {
        width: widths[i] - CELL_PADDING * 2,
        align: numeric[i] ? 'right' : 'left',
        lineBreak: false,
        ellipsis: true,
        height: TABLE_ROW_HEIGHT,
      });
      x += widths[i];
    });
    return y + TABLE_ROW_HEIGHT;
  };

  let y = drawHeaderRow(doc.y);

  if (!data.length) {
    doc.font('NotoSans').fontSize(9).fillColor('#666')
      .text('No rows matched.', left, y + 6);
  }

  doc.font('NotoSans').fontSize(TABLE_FONT_SIZE);
  data.forEach((row, index) => {
    if (y + TABLE_ROW_HEIGHT > bottomLimit) {
      doc.addPage({ margin: 36, layout: landscape ? 'landscape' : 'portrait', size: 'A4' });
      y = drawHeaderRow(doc.page.margins.top);
      doc.font('NotoSans').fontSize(TABLE_FONT_SIZE);
    }

    if (index % 2 === 1) {
      doc.rect(left, y - 2, available, TABLE_ROW_HEIGHT).fill('#fafafa');
    }

    doc.fillColor('#000');
    let x = left;
    cols.forEach((col, i) => {
      doc.text(formatCell(row[col], decimals[i]), x + CELL_PADDING, y + 2, {
        width: widths[i] - CELL_PADDING * 2,
        align: numeric[i] ? 'right' : 'left',
        lineBreak: false,
        ellipsis: true,
        height: TABLE_ROW_HEIGHT,
      });
      x += widths[i];
    });
    y += TABLE_ROW_HEIGHT;
  });

  // --- Page numbers ---------------------------------------------------------
  //
  // Written last because "of N" is not known until the last row is laid out.
  //
  // The bottom margin is zeroed first. The footer sits in the margin by
  // definition, and pdfkit responds to text placed below the bottom margin by
  // starting a new page — which then needs a footer of its own, so numbering an
  // N-page report silently produces 2N pages, every other one blank.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('NotoSans').fontSize(7).fillColor('#666').text(
      `Page ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - bottom + 6,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'right' }
    );
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return doc;
}

/**
 * Collect a generated document into a Buffer.
 *
 * Needed wherever the PDF is not being piped to a response — an email
 * attachment, a file on disk. Listeners are attached in the same tick the
 * document is returned, before pdfkit flushes, so nothing is missed.
 */
function renderToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

module.exports = {
  generateInvoicePdf,
  generatePurchaseOrderPdf,
  generatePayslipPdf,
  generateTabularPdf,
  renderToBuffer,
  formatCell,
  computeColumnWidths,
  detectNumericColumns,
  decimalsForColumns,
  ymd,
};
