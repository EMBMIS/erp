/**
 * Customer PO intake — PDF upload → AI extraction → matched customer → draft SO.
 *
 * WHY THIS REPLACED A REGEX
 * ===========================================================================
 * The previous implementation lived inline in routes/sales-orders.js and did
 * three things that a system of record must never do:
 *
 *   • `text.match(/total[\s:$]*([0-9.,]+)/i)` — and when that missed, it used
 *     a literal `250.00` as the order total.
 *   • `SELECT id FROM customers WHERE status='ACTIVE' LIMIT 1` — it assigned
 *     the order to whichever customer the database happened to return first.
 *   • It created the sales order immediately, with no one having seen the
 *     numbers it invented.
 *
 * Any one of those produces a real, numbered sales order containing figures
 * that appear nowhere in the customer's document. A wrong number that is
 * clearly wrong gets caught; a plausible one gets shipped and invoiced.
 *
 * So this module never fabricates and never commits. It extracts what the
 * document says, says how confident it is, resolves the customer by matching
 * on what the PO actually names, and hands the result back for a human to
 * confirm. Nothing is written until they do.
 */

const { getAIClient, AI_MODEL, isAIEnabled } = require('../../config/aiConfig');
const { pool } = require('../../config/database');

// Below this, the extraction is not worth presenting as a draft — the operator
// is better served by being told the document could not be read than by being
// handed fields they must check one by one anyway.
const MIN_USABLE_CONFIDENCE = 40;

async function extractText(fileBuffer) {
  try {
    const PDFMod = require('pdf-parse');
    if (typeof PDFMod === 'function') {
      const data = await PDFMod(fileBuffer);
      return (data.text || '').slice(0, 8000);
    }
    if (PDFMod?.PDFParse) {
      const parser = new PDFMod.PDFParse({ data: fileBuffer });
      const data = await parser.getText();
      return (data.text || '').slice(0, 8000);
    }
  } catch {
    return '';
  }
  return '';
}

const SYSTEM_PROMPT = `You are a customer purchase-order data extractor. Given the raw text of a \
customer's PO document, return a JSON object with these fields. Use null for anything the document \
does not state.

{
  "customer_name": "string or null — the BUYER issuing this PO, not the seller",
  "customer_po_number": "string or null",
  "order_date": "YYYY-MM-DD or null",
  "requested_delivery_date": "YYYY-MM-DD or null",
  "currency": "3-letter code or null",
  "delivery_address": "string or null",
  "line_items": [
    { "item_code": "string or null", "description": "string", "quantity": number,
      "unit_price": number, "line_total": number }
  ],
  "subtotal": number or null,
  "tax_amount": number or null,
  "total_amount": number or null,
  "confidence": number 0-100
}

Rules:
- Extract ONLY what the document states. Never infer, estimate, or supply a default.
- If a number is not present in the text, use null. Do not compute it unless the document shows the arithmetic.
- The customer is whoever ISSUED the PO. Do not confuse them with the supplier being ordered from.
- If the text is empty, garbled, or clearly not a purchase order, set confidence to 0 and return nulls.
- Return ONLY valid JSON.`;

/**
 * Find the customer this PO was issued by.
 *
 * Exact match first, then a case-insensitive contains, and it will not guess
 * between several candidates — an ambiguous name comes back as ambiguous, with
 * the options, so a person can pick. Returning "the first active customer",
 * which is what this used to do, is a wrong answer wearing a right answer's
 * clothes.
 */
async function resolveCustomer(customerName) {
  if (!customerName || !String(customerName).trim()) {
    return { customer: null, candidates: [], reason: 'The PO does not name a customer.' };
  }
  const name = String(customerName).trim();

  const { rows: exact } = await pool.query(
    `SELECT id, customer_name, customer_number, primary_email
       FROM customers
      WHERE LOWER(customer_name) = LOWER($1) AND deleted_at IS NULL
      LIMIT 5`,
    [name]
  );
  if (exact.length === 1) return { customer: exact[0], candidates: [], reason: null };
  if (exact.length > 1) {
    return {
      customer: null,
      candidates: exact,
      reason: `More than one customer is named "${name}".`,
    };
  }

  const { rows: fuzzy } = await pool.query(
    `SELECT id, customer_name, customer_number, primary_email
       FROM customers
      WHERE customer_name ILIKE $1 AND deleted_at IS NULL
      ORDER BY LENGTH(customer_name) ASC
      LIMIT 5`,
    [`%${name}%`]
  );
  if (fuzzy.length === 1) return { customer: fuzzy[0], candidates: [], reason: null };
  if (fuzzy.length > 1) {
    return {
      customer: null,
      candidates: fuzzy,
      reason: `"${name}" matches ${fuzzy.length} customers.`,
    };
  }

  return {
    customer: null,
    candidates: [],
    reason: `No customer matches "${name}". Create the customer first, or pick one manually.`,
  };
}

/**
 * Match extracted lines against the item master so the draft references real
 * items rather than free text. Unmatched lines are returned as-is and flagged;
 * they are not dropped, because a line the system cannot identify is exactly
 * the line a person needs to look at.
 */
async function resolveLineItems(lines) {
  const resolved = [];
  for (const line of lines) {
    let match = null;

    if (line.item_code) {
      const { rows } = await pool.query(
        `SELECT id, item_number, short_description, standard_price
           FROM items
          WHERE (item_number = $1 OR LOWER(short_description) = LOWER($2))
            AND deleted_at IS NULL
          LIMIT 1`,
        [String(line.item_code).trim(), String(line.description || '').trim()]
      );
      match = rows[0] || null;
    }

    if (!match && line.description) {
      const { rows } = await pool.query(
        `SELECT id, item_number, short_description, standard_price
           FROM items
          WHERE short_description ILIKE $1 AND deleted_at IS NULL
          ORDER BY LENGTH(short_description) ASC
          LIMIT 1`,
        [`%${String(line.description).trim()}%`]
      );
      match = rows[0] || null;
    }

    resolved.push({
      ...line,
      item_id: match?.id || null,
      matched_item_number: match?.item_number || null,
      // The PO's price governs — it is what the customer committed to. The
      // list price is surfaced alongside it so a discrepancy is visible rather
      // than silently accepted.
      list_price: match ? Number(match.standard_price) : null,
      price_variance:
        match && line.unit_price != null
          ? Number((Number(line.unit_price) - Number(match.standard_price)).toFixed(2))
          : null,
      needs_review: !match,
    });
  }
  return resolved;
}

/**
 * Read a customer PO and return a PROPOSAL. Writes nothing.
 *
 * @returns {{ok: boolean, extracted: object|null, customer: object|null,
 *             candidates: array, line_items: array, confidence: number,
 *             warnings: string[], error?: string}}
 */
async function processCustomerPoPdf(fileBuffer, fileName) {
  if (!isAIEnabled()) {
    return {
      ok: false,
      error: 'PO intake needs the AI service, which is not configured on this server (no API key set). '
        + 'You can still create the sales order manually.',
      extracted: null, customer: null, candidates: [], line_items: [], confidence: 0, warnings: [],
    };
  }

  const rawText = await extractText(fileBuffer);
  if (!rawText.trim()) {
    return {
      ok: false,
      error: 'No text could be read from this PDF. It is most likely a scanned image; '
        + 'this intake path needs a text-based PDF.',
      extracted: null, customer: null, candidates: [], line_items: [], confidence: 0, warnings: [],
    };
  }

  let parsed;
  try {
    const client = getAIClient();
    const response = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `File: ${fileName}\n\nRaw PDF text:\n${rawText}` },
      ],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    });
    parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
  } catch (err) {
    console.error('Customer PO extraction error:', err.message);
    return {
      ok: false,
      error: `The document could not be read: ${err.message}`,
      extracted: null, customer: null, candidates: [], line_items: [], confidence: 0, warnings: [],
    };
  }

  const confidence = Number(parsed.confidence) || 0;
  if (confidence < MIN_USABLE_CONFIDENCE) {
    return {
      ok: false,
      error: `This document could not be read reliably (confidence ${confidence}%). `
        + 'Nothing was created — please enter the order manually or upload a clearer PDF.',
      extracted: parsed, customer: null, candidates: [], line_items: [], confidence, warnings: [],
    };
  }

  const { customer, candidates, reason } = await resolveCustomer(parsed.customer_name);
  const lineItems = await resolveLineItems(
    Array.isArray(parsed.line_items) ? parsed.line_items : []
  );

  // Everything a person should look at before accepting, stated plainly.
  const warnings = [];
  if (reason) warnings.push(reason);
  if (!lineItems.length) warnings.push('No line items could be read from this PO.');
  const unmatched = lineItems.filter((l) => l.needs_review).length;
  if (unmatched) warnings.push(`${unmatched} line(s) did not match an item in the catalogue.`);
  if (parsed.total_amount == null) warnings.push('The PO total could not be read from the document.');

  // Cross-check the stated total against the lines. A PO whose own arithmetic
  // disagrees is either mis-read or genuinely wrong; either way, say so rather
  // than picking one of the two numbers.
  const lineSum = lineItems.reduce(
    (sum, l) => sum + (Number(l.line_total) || Number(l.quantity) * Number(l.unit_price) || 0), 0
  );
  if (parsed.total_amount != null && lineSum > 0) {
    const diff = Math.abs(Number(parsed.total_amount) - lineSum);
    if (diff > Math.max(0.02, lineSum * 0.01)) {
      warnings.push(
        `The stated total (${Number(parsed.total_amount).toFixed(2)}) does not match the sum of the `
        + `lines (${lineSum.toFixed(2)}).`
      );
    }
  }

  return {
    ok: true,
    extracted: {
      customer_name: parsed.customer_name || null,
      customer_po_number: parsed.customer_po_number || null,
      order_date: parsed.order_date || null,
      requested_delivery_date: parsed.requested_delivery_date || null,
      currency: parsed.currency || null,
      delivery_address: parsed.delivery_address || null,
      subtotal: parsed.subtotal ?? null,
      tax_amount: parsed.tax_amount ?? null,
      total_amount: parsed.total_amount ?? null,
    },
    customer,
    candidates,
    line_items: lineItems,
    confidence,
    warnings,
    source_file: fileName,
  };
}

module.exports = { processCustomerPoPdf, MIN_USABLE_CONFIDENCE };
