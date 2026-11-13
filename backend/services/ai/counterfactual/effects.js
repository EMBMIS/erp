/**
 * Effect primitives — the only things a counterfactual branch may do.
 *
 * THE CENTRAL SAFETY DECISION IN THIS FEATURE
 * ---------------------------------------------------------------------------
 * The obvious way to simulate a course of action is to replay the agent's own
 * write tools inside a transaction and roll it back. That is wrong here, and
 * quietly so: every handler in services/ai/toolRegistry.js takes its connection
 * from the shared pool. Called from inside a shadow transaction they would run
 * on a DIFFERENT connection, outside it — so the simulation would COMMIT real
 * records while the transaction it was supposedly confined to rolled back an
 * empty change set. A simulator that occasionally issues real payments is worse
 * than no simulator.
 *
 * So a branch cannot call tools at all. It can only name effects from this
 * catalogue, and every effect here is a small, bounded set of statements that
 * takes `client` — the shadow transaction's own connection — as its first
 * argument. There is no path from a branch to the pool. That is the invariant;
 * a new effect that reaches for `pool` breaks the whole guarantee.
 *
 * WHAT AN EFFECT MOVES
 * ---------------------------------------------------------------------------
 * Documents and balances, never postings. Paying a bill in simulation marks the
 * bill paid, records the payment row, and moves the cash and AP control-account
 * balances — it does not manufacture a journal entry with a fabricated number,
 * because a journal number is a real, sequential, auditable artefact and
 * inventing one even inside a doomed transaction is asking for a sequence to
 * drift. observables.ledgerBalance is therefore expected to be unchanged by
 * every branch; it is carried as a tripwire, so that an effect which one day
 * does post something one-sided is caught by the branch that ran it rather than
 * by a controller at year end.
 *
 * Every effect returns a short, factual description of what it changed, which
 * is what the UI shows under a branch. None of them consults a model.
 */

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Positive `delta` always means "this account's balance goes up by delta". */
async function adjustAccount(client, companyId, subtype, delta) {
  const amount = round2(delta);
  if (!amount) return 0;
  const { rowCount } = await client.query(
    `UPDATE chart_of_accounts
        SET current_balance = current_balance + $3,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM chart_of_accounts
         WHERE company_id = $1
           AND account_subtype = $2
           AND status = 'ACTIVE'
           AND deleted_at IS NULL
           AND is_header = false
         ORDER BY account_code
         LIMIT 1)`,
    [companyId, subtype, amount]
  );
  // A company with no cash account mapped is a real configuration problem, and
  // silently scoring a branch as if the money moved would hide it. The caller
  // turns a zero here into a violation rather than an exception, so one missing
  // account degrades the run instead of killing it.
  return rowCount ? amount : 0;
}

async function findSupplierInvoice(client, companyId, args) {
  const { rows } = await client.query(
    `SELECT id, bill_number, supplier_id, total_amount, paid_amount, outstanding_amount, due_date, status
       FROM supplier_invoices
      WHERE company_id = $1
        AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR id = $2::uuid)
        AND ($3::text IS NULL OR bill_number = $3::text)
      LIMIT 1`,
    [companyId, args.invoice_id || null, args.bill_number || null]
  );
  if (!rows[0]) throw new Error(`No supplier invoice matched ${args.bill_number || args.invoice_id}`);
  return rows[0];
}

async function findCustomerInvoice(client, companyId, args) {
  const { rows } = await client.query(
    `SELECT id, invoice_number, customer_id, total_amount, paid_amount, outstanding_amount, discount_amount, due_date, status
       FROM customer_invoices
      WHERE company_id = $1
        AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR id = $2::uuid)
        AND ($3::text IS NULL OR invoice_number = $3::text)
      LIMIT 1`,
    [companyId, args.invoice_id || null, args.invoice_number || null]
  );
  if (!rows[0]) throw new Error(`No customer invoice matched ${args.invoice_number || args.invoice_id}`);
  return rows[0];
}

// `status` is a CHECK-constrained enum on both invoice tables; these are the
// only two values a payment can legitimately move a bill to.
const settledStatus = (outstanding) => (outstanding <= 0.005 ? 'PAID' : 'PARTIALLY_PAID');

const effects = {
  /**
   * Settle a supplier bill, in full or in part. Cash down, AP down.
   */
  pay_supplier_invoice: {
    description: 'Pay a supplier bill (in full, or a stated amount). Cash falls, payables fall.',
    args: { bill_number: 'string', invoice_id: 'uuid', amount: 'number (default: the whole outstanding balance)' },
    async apply(client, companyId, args, ctx) {
      const bill = await findSupplierInvoice(client, companyId, args);
      const outstanding = Number(bill.outstanding_amount || 0);
      const amount = round2(Math.min(args.amount != null ? Number(args.amount) : outstanding, outstanding));
      if (amount <= 0) return { note: `${bill.bill_number} has nothing outstanding`, cash_delta: 0 };

      const paid = round2(Number(bill.paid_amount || 0) + amount);
      await client.query(
        `UPDATE supplier_invoices
            SET paid_amount = $2, status = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [bill.id, paid, settledStatus(Number(bill.total_amount || 0) - paid)]
      );
      await client.query(
        `INSERT INTO supplier_payments
           (payment_number, supplier_id, payment_date, payment_method, payment_amount, status, description, created_by, company_id)
         VALUES ($1, $2, CURRENT_DATE, 'BANK_TRANSFER', $3, 'PENDING', $4, $5, $6)`,
        [`SIM-${Date.now().toString(36).toUpperCase()}`, bill.supplier_id, amount,
         `Counterfactual branch payment for ${bill.bill_number}`, ctx.userId, companyId]
      );
      await adjustAccount(client, companyId, 'CASH', -amount);
      await adjustAccount(client, companyId, 'ACCOUNTS_PAYABLE', -amount);

      return { note: `Paid ${amount.toFixed(2)} against ${bill.bill_number}`, cash_delta: -amount };
    },
  },

  /**
   * Renegotiate a due date rather than the money. Nothing moves; the bill just
   * stops being late, which is exactly the trade-off worth measuring against
   * paying it: lateness is a supplier-relationship cost, not a cash cost.
   */
  defer_supplier_invoice: {
    description: 'Push a supplier bill\'s due date out by N days (a renegotiated term). No cash moves.',
    args: { bill_number: 'string', invoice_id: 'uuid', days: 'number of days to defer' },
    async apply(client, companyId, args) {
      const bill = await findSupplierInvoice(client, companyId, args);
      const days = Math.max(1, Math.min(Math.round(Number(args.days) || 30), 365));
      await client.query(
        `UPDATE supplier_invoices
            SET due_date = due_date + ($2 || ' days')::interval,
                status = CASE WHEN status = 'OVERDUE'
                              AND due_date + ($2 || ' days')::interval >= CURRENT_DATE
                         THEN 'APPROVED' ELSE status END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [bill.id, String(days)]
      );
      return { note: `Deferred ${bill.bill_number} by ${days} days`, cash_delta: 0 };
    },
  },

  /**
   * Collect from a customer. Cash up, AR down.
   */
  collect_customer_invoice: {
    description: 'Collect a customer invoice (in full, or a stated amount). Cash rises, receivables fall.',
    args: { invoice_number: 'string', invoice_id: 'uuid', amount: 'number (default: the whole outstanding balance)' },
    async apply(client, companyId, args, ctx) {
      const inv = await findCustomerInvoice(client, companyId, args);
      const outstanding = Number(inv.outstanding_amount || 0);
      const amount = round2(Math.min(args.amount != null ? Number(args.amount) : outstanding, outstanding));
      if (amount <= 0) return { note: `${inv.invoice_number} has nothing outstanding`, cash_delta: 0 };

      const paid = round2(Number(inv.paid_amount || 0) + amount);
      await client.query(
        `UPDATE customer_invoices
            SET paid_amount = $2, status = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [inv.id, paid, settledStatus(Number(inv.total_amount || 0) - paid)]
      );
      await client.query(
        `INSERT INTO customer_payments
           (payment_number, customer_id, payment_date, payment_method, payment_amount, status, description, created_by, company_id)
         VALUES ($1, $2, CURRENT_DATE, 'BANK_TRANSFER', $3, 'PENDING', $4, $5, $6)`,
        [`SIM-${Date.now().toString(36).toUpperCase()}`, inv.customer_id, amount,
         `Counterfactual branch collection for ${inv.invoice_number}`, ctx.userId, companyId]
      );
      await adjustAccount(client, companyId, 'CASH', amount);
      await adjustAccount(client, companyId, 'ACCOUNTS_RECEIVABLE', -amount);

      return { note: `Collected ${amount.toFixed(2)} against ${inv.invoice_number}`, cash_delta: amount };
    },
  },

  /**
   * Buy the cash forward at a price. The discount is a real revenue give-up, so
   * it lands on the invoice's discount_amount and the total falls with it —
   * otherwise the branch would look like free money, which is how a 2/10 net 30
   * policy ends up costing a company 36% annualised without anyone noticing.
   */
  discount_for_early_payment: {
    description: 'Offer a customer a discount to pay now. Cash rises by the net amount; the discount is a real give-up on the invoice.',
    args: { invoice_number: 'string', invoice_id: 'uuid', discount_percent: 'number, e.g. 2 for 2%' },
    async apply(client, companyId, args, ctx) {
      const inv = await findCustomerInvoice(client, companyId, args);
      const outstanding = Number(inv.outstanding_amount || 0);
      if (outstanding <= 0) return { note: `${inv.invoice_number} has nothing outstanding`, cash_delta: 0 };

      const pct = Math.max(0, Math.min(Number(args.discount_percent) || 0, 50));
      const discount = round2(outstanding * (pct / 100));
      const net = round2(outstanding - discount);

      await client.query(
        `UPDATE customer_invoices
            SET discount_amount = discount_amount + $2,
                total_amount    = total_amount - $2,
                paid_amount     = paid_amount + $3,
                status          = 'PAID',
                updated_at      = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [inv.id, discount, net]
      );
      await client.query(
        `INSERT INTO customer_payments
           (payment_number, customer_id, payment_date, payment_method, payment_amount, status, description, created_by, company_id)
         VALUES ($1, $2, CURRENT_DATE, 'BANK_TRANSFER', $3, 'PENDING', $4, $5, $6)`,
        [`SIM-${Date.now().toString(36).toUpperCase()}`, inv.customer_id, net,
         `Counterfactual early settlement of ${inv.invoice_number} at ${pct}%`, ctx.userId, companyId]
      );
      await adjustAccount(client, companyId, 'CASH', net);
      await adjustAccount(client, companyId, 'ACCOUNTS_RECEIVABLE', -outstanding);

      return {
        note: `Settled ${inv.invoice_number} early: ${net.toFixed(2)} in, ${discount.toFixed(2)} given up`,
        cash_delta: net,
      };
    },
  },

  /**
   * Restock. Cash out at the item's own unit price, stock in.
   */
  replenish_item: {
    description: 'Buy stock for an item now: inventory rises, cash falls by quantity x unit price.',
    args: { item_code: 'string', inventory_item_id: 'uuid', quantity: 'number of units' },
    async apply(client, companyId, args) {
      const { rows } = await client.query(
        `SELECT ii.id, ii.unit_price, ii.current_stock_quantity, ii.reorder_point, i.item_code, i.name
           FROM inventory_items ii
           JOIN items i ON i.id = ii.item_master_id
          WHERE ii.company_id = $1
            AND ($2::uuid IS NULL OR ii.id = $2::uuid)
            AND ($3::text IS NULL OR i.item_code = $3::text)
          LIMIT 1`,
        [companyId, args.inventory_item_id || null, args.item_code || null]
      );
      const item = rows[0];
      if (!item) throw new Error(`No inventory item matched ${args.item_code || args.inventory_item_id}`);

      // Default to whatever it takes to get back to the reorder point — the
      // decision being simulated is usually "do we replenish", not "how much".
      const gap = Number(item.reorder_point || 0) - Number(item.current_stock_quantity || 0);
      const qty = Math.max(0, Number(args.quantity != null ? args.quantity : Math.max(gap, 0)));
      if (qty <= 0) return { note: `${item.item_code} needs no replenishment`, cash_delta: 0 };

      const cost = round2(qty * Number(item.unit_price || 0));
      await client.query(
        `UPDATE inventory_items
            SET current_stock_quantity = current_stock_quantity + $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [item.id, qty]
      );
      await adjustAccount(client, companyId, 'CASH', -cost);

      return { note: `Replenished ${item.item_code} by ${qty} (${cost.toFixed(2)})`, cash_delta: -cost };
    },
  },

  /**
   * Demand arrives. This is how a branch that skips replenishment gets to show
   * its real cost: the stockout appears in the measured vector rather than in
   * an argument about it.
   */
  consume_stock: {
    description: 'Model demand against an item: stock falls by the quantity. Used to expose a stockout a branch would cause.',
    args: { item_code: 'string', inventory_item_id: 'uuid', quantity: 'number of units consumed' },
    async apply(client, companyId, args) {
      const { rows } = await client.query(
        `SELECT ii.id, ii.current_stock_quantity, i.item_code
           FROM inventory_items ii
           JOIN items i ON i.id = ii.item_master_id
          WHERE ii.company_id = $1
            AND ($2::uuid IS NULL OR ii.id = $2::uuid)
            AND ($3::text IS NULL OR i.item_code = $3::text)
          LIMIT 1`,
        [companyId, args.inventory_item_id || null, args.item_code || null]
      );
      const item = rows[0];
      if (!item) throw new Error(`No inventory item matched ${args.item_code || args.inventory_item_id}`);

      // current_stock_quantity carries a >= 0 CHECK, so demand that exceeds
      // stock is clamped and reported. The shortfall is the finding.
      const asked = Math.max(0, Number(args.quantity) || 0);
      const have = Number(item.current_stock_quantity || 0);
      const taken = Math.min(asked, have);
      const short = round2(asked - taken);

      await client.query(
        `UPDATE inventory_items
            SET current_stock_quantity = current_stock_quantity - $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [item.id, taken]
      );
      return {
        note: short > 0
          ? `Demand of ${asked} on ${item.item_code} could only be met to ${taken} — short ${short}`
          : `Consumed ${taken} of ${item.item_code}`,
        cash_delta: 0,
        shortfall: short,
      };
    },
  },

  /**
   * A known inflow or outflow the ERP does not hold as a document — payroll,
   * a tax payment, a drawdown. Kept deliberately blunt: it moves cash and says
   * why, and it is the one effect where the number comes from the person rather
   * than from a record.
   */
  cash_movement: {
    description: 'A known cash inflow (positive) or outflow (negative) with no document behind it — payroll, tax, a loan drawdown.',
    args: { amount: 'number, negative for an outflow', reason: 'string' },
    async apply(client, companyId, args) {
      const amount = round2(Number(args.amount) || 0);
      if (!amount) return { note: 'No cash movement', cash_delta: 0 };
      await adjustAccount(client, companyId, 'CASH', amount);
      return {
        note: `${amount < 0 ? 'Paid out' : 'Received'} ${Math.abs(amount).toFixed(2)} — ${args.reason || 'unspecified'}`,
        cash_delta: amount,
      };
    },
  },
};

/** The catalogue, in the shape a model can be shown. */
function catalogue() {
  return Object.entries(effects).map(([name, e]) => ({ name, description: e.description, args: e.args }));
}

/**
 * Apply one effect. Throws for an unknown name — a branch naming an effect that
 * does not exist is a failed branch, not a branch that silently did nothing.
 */
async function applyEffect(client, companyId, step, ctx) {
  const effect = effects[step?.effect];
  if (!effect) throw new Error(`Unknown effect: ${step?.effect}`);
  const result = await effect.apply(client, companyId, step.args || {}, ctx || {});
  return { effect: step.effect, ...result };
}

module.exports = { effects, catalogue, applyEffect, adjustAccount };
