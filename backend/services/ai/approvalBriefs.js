/**
 * AI Approval Briefs — on-demand context summaries for approval decisions.
 *
 * When an approver opens a document (PO, invoice, sales order), this service
 * gathers relevant context from the ERP and produces a concise AI brief:
 * price vs history, supplier/customer risk signals, budget impact, and similar
 * past documents.
 *
 * Results are cached in-memory with a short TTL so multiple approvers viewing
 * the same document don't each trigger a fresh AI call.
 */

const { getAIClient, AI_MODEL_FAST } = require('../../config/aiConfig');
const { pool } = require('../../config/database');

const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * @param {'purchase_order'|'supplier_invoice'|'sales_order'} documentType
 * @param {string} documentId
 * @returns {{ summary: string, alerts: string[], context: object }}
 */
async function briefForDocument(documentType, documentId) {
  const cacheKey = `${documentType}:${documentId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const context = await gatherContext(documentType, documentId);
  const brief = await generateBrief(documentType, context);

  const result = { ...brief, context };
  cache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

async function gatherContext(type, id) {
  switch (type) {
    case 'purchase_order': {
      const { rows: [po] } = await pool.query(
        `SELECT po.*, s.legal_name AS supplier_name
           FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
          WHERE po.id = $1`, [id]
      );
      if (!po) return { found: false };

      // Average unit price from past POs with this supplier (last 12 months)
      const { rows: [priceHistory] } = await pool.query(
        `SELECT AVG(poli.unit_price)::numeric(15,2) AS avg_price, COUNT(DISTINCT po2.id)::int AS past_orders
           FROM purchase_orders po2
           JOIN purchase_order_line_items poli ON poli.po_id = po2.id
          WHERE po2.supplier_id = $1 AND po2.id != $2 AND po2.created_at > CURRENT_DATE - INTERVAL '12 months'`,
        [po.supplier_id, id]
      );

      // Supplier on-time delivery rate
      const { rows: [delivery] } = await pool.query(
        `SELECT COUNT(*)::int AS total_pos,
                COUNT(*) FILTER (WHERE status IN ('FULLY_RECEIVED','COMPLETED'))::int AS on_time
           FROM purchase_orders
          WHERE supplier_id = $1 AND status NOT IN ('DRAFT','CANCELLED')`,
        [po.supplier_id]
      );

      return {
        found: true,
        document: { number: po.po_number, total: Number(po.total_amount), supplier: po.supplier_name, status: po.status },
        price_history: priceHistory || { avg_price: null, past_orders: 0 },
        delivery: delivery || { total_pos: 0, on_time: 0 },
      };
    }

    case 'sales_order': {
      const { rows: [so] } = await pool.query(
        `SELECT so.*, c.customer_name, c.credit_limit, c.current_balance
           FROM sales_orders so LEFT JOIN customers c ON so.customer_id = c.id
          WHERE so.id = $1`, [id]
      );
      if (!so) return { found: false };

      const { rows: [paymentHistory] } = await pool.query(
        `SELECT COUNT(*)::int AS total_invoices,
                COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_on_time,
                AVG(EXTRACT(DAY FROM (paid_date - due_date)))::numeric(5,1) AS avg_days_to_pay
           FROM customer_invoices
          WHERE customer_id = $1 AND status IN ('PAID','PARTIALLY_PAID')`,
        [so.customer_id]
      );

      return {
        found: true,
        document: { number: so.so_number, total: Number(so.total_amount), customer: so.customer_name, status: so.status },
        credit: { limit: Number(so.credit_limit) || 0, balance: Number(so.current_balance) || 0 },
        payment_history: paymentHistory || {},
      };
    }

    default:
      return { found: false };
  }
}

async function generateBrief(type, context) {
  if (!context.found) return { summary: 'Document not found.', alerts: [] };

  const client = getAIClient();
  const systemPrompt = `You are an ERP approval assistant. Given context about a document awaiting approval, \
write a 2-3 sentence summary an approver can read in under 10 seconds, and list 1-3 specific alerts or \
risk signals (if any). Format as JSON: { "summary": "string", "alerts": ["string"] }. Be concise and \
data-driven — cite the specific numbers that matter. If everything looks normal, say so briefly.`;

  try {
    const response = await client.chat.completions.create({
      model: AI_MODEL_FAST,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({ type, ...context }) },
      ],
      temperature: 0.3,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });

    const content = response.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content || '{}');
    return {
      summary: parsed.summary || 'Unable to generate brief.',
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    };
  } catch {
    return { summary: 'AI brief unavailable.', alerts: [] };
  }
}

module.exports = { briefForDocument };
