/**
 * Journal-Stream & Transaction Anomaly Detection Service
 *
 * Benford's law alone produces noise at ERP volumes (roadmap Round 7, Task 20):
 * every detector here learns a baseline from the company's own history and
 * flags DEVIATION from it, not absolute values. The tests auditors actually
 * run:
 *
 *   • per-vendor and per-account learned baseline — amount distribution,
 *     frequency and typical approver, flagging deviation from each
 *   • duplicate payments (same vendor, amount, near-date; same invoice number
 *     across vendors)
 *   • vendor bank detail CHANGED shortly before a payment — the single
 *     highest-value fraud test
 *   • entries just under an approval threshold, per approver
 *   • weekend / after-hours postings, weighted by whether that user normally
 *     does that
 *   • vendor sharing an address, bank account or tax id with an employee
 *
 * Everything is fed into ai_findings with a severity and a plain-English
 * explanation of WHY it was flagged — a flag without a reason gets ignored
 * after the first week. All checks are deterministic SQL + robust statistics
 * (services/ai/stats.js); no LLM invents a number here.
 *
 * Re-running any detector is safe: upsertFinding dedupes on the open-finding
 * unique index and respects dismissals (ai_finding_suppressions).
 */

const { pool } = require('../../config/database');
const { currentCompanyId } = require('../companyContext');
const stats = require('./stats');
const { upsertFinding } = require('./findingsScan');

class AnomalyDetectionService {
  /**
   * Benford's Law analysis on leading digits of journal entry transaction amounts.
   */
  static async analyzeBenfordLaw(companyId = currentCompanyId()) {
    const { rows } = await pool.query(
      `SELECT total_debit::float as amount
         FROM journal_entries
        WHERE company_id = $1 AND total_debit > 0`,
      [companyId]
    );

    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
    let total = 0;

    for (const r of rows) {
      const firstDigit = String(r.amount).replace(/^0+/, '').replace(/\./, '')[0];
      if (firstDigit >= '1' && firstDigit <= '9') {
        counts[firstDigit]++;
        total++;
      }
    }

    const expected = { 1: 0.301, 2: 0.176, 3: 0.125, 4: 0.097, 5: 0.079, 6: 0.067, 7: 0.058, 8: 0.051, 9: 0.046 };
    const actual = {};
    let maxDeviation = 0;

    for (let d = 1; d <= 9; d++) {
      const freq = total > 0 ? counts[d] / total : 0;
      actual[d] = Number(freq.toFixed(3));
      const dev = Math.abs(freq - expected[d]);
      if (dev > maxDeviation) maxDeviation = dev;
    }

    return {
      sample_size: total,
      expected_benford: expected,
      actual_distribution: actual,
      anomaly_flag: total > 30 && maxDeviation > 0.15,
      max_deviation: Number(maxDeviation.toFixed(3))
    };
  }

  /**
   * Detect weekend or off-hours journal postings (after 10 PM or weekends).
   * Kept for backward compatibility; the learned, per-user weighting that
   * writes ai_findings lives in detectOffHoursPostingsWeighted.
   */
  static async detectOffHoursPostings(companyId = currentCompanyId()) {
    const { rows } = await pool.query(
      `SELECT id, journal_number, description, total_debit, created_at, created_by
         FROM journal_entries
        WHERE company_id = $1
          AND (
            EXTRACT(ISODOW FROM created_at) IN (6, 7)
            OR EXTRACT(HOUR FROM created_at) >= 22
            OR EXTRACT(HOUR FROM created_at) <= 5
          )
        ORDER BY created_at DESC
        LIMIT 50`,
      [companyId]
    );

    return rows.map((r) => ({
      ...r,
      flag_reason: 'Off-hours / weekend posting detected'
    }));
  }

  /**
   * Detect threshold-hugging transactions (e.g. $9,500 - $9,999 when approval is at $10,000).
   * Kept for backward compatibility; the per-approver version that writes
   * ai_findings lives in detectThresholdHuggingPerApprover.
   */
  static async detectThresholdHugging(threshold = 10000, companyId = currentCompanyId()) {
    const lowerBound = threshold * 0.9;

    const { rows } = await pool.query(
      `SELECT id, journal_number, total_debit as amount, description, created_at
         FROM journal_entries
        WHERE company_id = $1
          AND total_debit >= $2
          AND total_debit < $3
        ORDER BY created_at DESC`,
      [companyId, lowerBound, threshold]
    );

    return rows.map((r) => ({
      ...r,
      threshold,
      flag_reason: `Amount is within 10% below approval threshold of $${threshold}`
    }));
  }

  // =========================================================================
  // Round 7, Task 20 — learned-baseline detectors. Each returns the number of
  // NEW ai_findings rows actually created (an already-open finding for the
  // same issue, or a recent dismissal, is not duplicated).
  // =========================================================================

  /**
   * Per-vendor learned baseline on supplier payments: amount distribution
   * (robust MAD z-score), payment frequency, and typical approver.
   */
  static async detectVendorBaselineDeviation({ companyId = currentCompanyId(), sigmaThreshold = 4 } = {}) {
    const { rows } = await pool.query(
      `SELECT p.id, p.supplier_id, p.payment_number, p.payment_date, p.payment_amount::float AS amount,
              p.created_by, p.status, s.legal_name AS supplier_name
         FROM supplier_payments p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.company_id = $1 AND p.deleted_at IS NULL
          AND p.payment_date >= CURRENT_DATE - INTERVAL '365 days'`,
      [companyId]
    );

    const byVendor = new Map();
    for (const r of rows) {
      if (!byVendor.has(r.supplier_id)) byVendor.set(r.supplier_id, []);
      byVendor.get(r.supplier_id).push(r);
    }

    const pending = [];
    for (const [supplierId, payments] of byVendor) {
      if (payments.length < 3) continue; // too little history to learn a baseline
      const name = payments[0].supplier_name || 'this vendor';

      // --- Amount deviation ------------------------------------------------
      const amounts = payments.map((p) => p.amount);
      const scores = robustScores(amounts);
      const centre = stats.median(amounts);
      const scale = stats.mad(amounts);

      payments.forEach((p, i) => {
        const score = scores[i];
        if (Math.abs(score) < sigmaThreshold) return;
        queueFinding(pending, {
          companyId,
          finding_type: 'VENDOR_PAYMENT_AMOUNT_DEVIATION',
          severity: Math.abs(score) >= 8 ? 'HIGH' : 'MEDIUM',
          entity_type: 'SUPPLIER_PAYMENT',
          entity_id: p.id,
          title: `Payment ${p.payment_number} is far outside ${name}'s normal range`,
          description:
            `This vendor's ${payments.length} payments over the past year typically run ` +
            `${fmt(centre)} (typical spread ${fmt(scale)}), but ${p.payment_number} is ` +
            `${fmt(p.amount)} — ${fmt(Math.abs(score))}x the typical spread away. A single payment ` +
            `this far from the vendor's own history is worth confirming before it clears.`,
          data: { supplier_id: supplierId, payment_number: p.payment_number, amount: p.amount, deviation_sigmas: round2(score), baseline_median: centre, baseline_mad: scale },
        });
      });

      // --- Frequency deviation ---------------------------------------------
      const cutoff30 = dateStr(new Date(Date.now() - 30 * 86400000));
      const thirtyDays = payments.filter((p) => dateStr(p.payment_date) >= cutoff30);
      const monthlyRate = payments.length / (365 / 12);
      if (monthlyRate > 0 && thirtyDays.length >= 3 && thirtyDays.length > monthlyRate * 3) {
        queueFinding(pending, {
          companyId,
          finding_type: 'VENDOR_PAYMENT_FREQUENCY_SPIKE',
          severity: 'MEDIUM',
          entity_type: 'SUPPLIER',
          entity_id: supplierId,
          title: `${name} is being paid far more often than usual`,
          description:
            `This vendor normally receives about ${fmt(monthlyRate)} payment(s) per month, ` +
            `but ${thirtyDays.length} payments were made in the last 30 days — more than ` +
            `3x the learned rate. A burst of payments to one vendor is a classic fraud pattern.`,
          data: { supplier_id: supplierId, recent_30d: thirtyDays.length, learned_monthly_rate: round2(monthlyRate) },
        });
      }

      // --- Typical approver ------------------------------------------------
      const byUser = new Map();
      for (const p of payments) {
        if (!p.created_by) continue;
        byUser.set(p.created_by, (byUser.get(p.created_by) || 0) + 1);
      }
      const sorted = [...byUser.entries()].sort((a, b) => b[1] - a[1]);
      const [topUser, topCount] = sorted[0] || [null, 0];
      if (topUser && payments.length >= 5 && topCount / payments.length >= 0.7) {
        for (const p of payments) {
          if (p.created_by && p.created_by !== topUser) {
            queueFinding(pending, {
              companyId,
              finding_type: 'VENDOR_ATYPICAL_APPROVER',
              severity: 'MEDIUM',
              entity_type: 'SUPPLIER_PAYMENT',
              entity_id: p.id,
              title: `Payment ${p.payment_number} was not created by ${name}'s usual approver`,
              description:
                `${topCount} of this vendor's ${payments.length} payments were created by the ` +
                `same user, but ${p.payment_number} was created by someone else. A change in who ` +
                `approves a vendor's payments deserves a second look.`,
              data: { supplier_id: supplierId, payment_number: p.payment_number, usual_approver: topUser, actual_approver: p.created_by },
            });
          }
        }
      }
    }

    return (await Promise.all(pending)).filter((r) => r && r.id).length;
  }

  /**
   * Per-account learned baseline on journal entry line amounts: a line that
   * posts an amount far outside what that account normally carries.
   */
  static async detectAccountBaselineDeviation({ companyId = currentCompanyId(), sigmaThreshold = 4 } = {}) {
    const { rows } = await pool.query(
      `SELECT jei.account_id, jei.journal_entry_id, je.journal_number,
              (jei.debit_amount + jei.credit_amount)::float AS amount
         FROM journal_entry_items jei
         JOIN journal_entries je ON je.id = jei.journal_entry_id
        WHERE je.company_id = $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL
          AND je.entry_date >= CURRENT_DATE - INTERVAL '365 days'`,
      [companyId]
    );

    const byAccount = new Map();
    for (const r of rows) {
      if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, []);
      byAccount.get(r.account_id).push(r);
    }

    const pending = [];
    for (const [accountId, items] of byAccount) {
      if (items.length < 3) continue;
      const amounts = items.map((i) => i.amount);
      const scores = robustScores(amounts);
      const centre = stats.median(amounts);
      const scale = stats.mad(amounts);

      items.forEach((item, i) => {
        const score = scores[i];
        if (Math.abs(score) < sigmaThreshold) return;
        queueFinding(pending, {
          companyId,
          finding_type: 'ACCOUNT_AMOUNT_DEVIATION',
          severity: Math.abs(score) >= 8 ? 'HIGH' : 'MEDIUM',
          entity_type: 'JOURNAL_ENTRY',
          entity_id: item.journal_entry_id,
          title: `Unusual amount on journal ${item.journal_number}`,
          description:
            `This account's lines over the past year typically carry ${fmt(centre)} ` +
            `(spread ${fmt(scale)}), but ${item.journal_number} posts ${fmt(item.amount)} — ` +
            `${fmt(Math.abs(score))}x the typical spread. Large postings to an account that ` +
            `never carries them are how fraud hides in the general ledger.`,
          data: { account_id: accountId, journal_number: item.journal_number, amount: item.amount, deviation_sigmas: round2(score), baseline_median: centre, baseline_mad: scale },
        });
      });
    }

    return (await Promise.all(pending)).filter((r) => r && r.id).length;
  }

  /**
   * Duplicate payment detection: the same vendor paid the same amount within a
   * few days, and the same supplier invoice number raised against two
   * different vendors.
   */
  static async detectDuplicatePayments({ companyId = currentCompanyId(), windowDays = 7 } = {}) {
    const pending = [];

    // Same vendor, same amount, near-date.
    const { rows: pairs } = await pool.query(
      `SELECT a.id AS id_a, b.id AS id_b, a.payment_number AS num_a, b.payment_number AS num_b,
              a.supplier_id, a.payment_amount::float AS amount,
              a.payment_date AS date_a, b.payment_date AS date_b
         FROM supplier_payments a
         JOIN supplier_payments b
           ON a.supplier_id = b.supplier_id
          AND a.payment_amount = b.payment_amount
          AND a.id < b.id
          AND ABS(a.payment_date - b.payment_date) <= $2
        WHERE a.company_id = $1 AND b.company_id = $1
          AND a.deleted_at IS NULL AND b.deleted_at IS NULL
          AND a.status NOT IN ('CANCELLED') AND b.status NOT IN ('CANCELLED')`,
      [companyId, windowDays]
    );

    for (const pair of pairs) {
      queueFinding(pending, {
        companyId,
        finding_type: 'DUPLICATE_PAYMENT',
        severity: 'HIGH',
        entity_type: 'SUPPLIER_PAYMENT',
        entity_id: pair.id_b,
        title: `Possible duplicate payment: ${pair.num_a} and ${pair.num_b}`,
        description:
          `Two payments to the same vendor for the same amount (${fmt(pair.amount)}) were made ` +
          `${Math.abs(daysBetween(pair.date_a, pair.date_b))} days apart (${iso(pair.date_a)} and ` +
          `${iso(pair.date_b)}). The later one may pay the same bill twice.`,
        data: { payment_a: pair.num_a, payment_b: pair.num_b, amount: pair.amount, days_apart: Math.abs(daysBetween(pair.date_a, pair.date_b)) },
      });
    }

    // Same invoice number across different vendors.
    const { rows: crossVendor } = await pool.query(
      `SELECT a.id AS id_a, b.id AS id_b,
              a.supplier_invoice_number AS invoice_number,
              a.supplier_id AS supplier_a, b.supplier_id AS supplier_b,
              a.bill_number AS bill_a, b.bill_number AS bill_b
         FROM supplier_invoices a
         JOIN supplier_invoices b
           ON a.supplier_invoice_number = b.supplier_invoice_number
          AND a.supplier_id <> b.supplier_id
        WHERE a.company_id = $1 AND b.company_id = $1
          AND a.deleted_at IS NULL AND b.deleted_at IS NULL
          AND a.supplier_invoice_number IS NOT NULL
          AND a.status NOT IN ('CANCELLED') AND b.status NOT IN ('CANCELLED')`,
      [companyId]
    );

    for (const row of crossVendor) {
      queueFinding(pending, {
        companyId,
        finding_type: 'DUPLICATE_INVOICE_NUMBER_CROSS_VENDOR',
        severity: 'HIGH',
        entity_type: 'SUPPLIER_INVOICE',
        entity_id: row.id_b,
        title: `Invoice number "${row.invoice_number}" exists on two different vendors' books`,
        description:
          `The same supplier invoice number (${row.invoice_number}) was entered against two ` +
          `different vendors (${row.bill_a} and ${row.bill_b}). One of them may be a phantom ` +
          `invoice raised to pay the same bill twice.`,
        data: { invoice_number: row.invoice_number, bill_a: row.bill_a, bill_b: row.bill_b },
      });
    }

    return (await Promise.all(pending)).filter((r) => r && r.id).length;
  }

  /**
   * Vendor bank detail CHANGED shortly before a payment — the single
   * highest-value fraud test. A payment to a vendor whose bank details were
   * changed in the days before it may be paying the fraudster's account.
   */
  static async detectBankDetailChangeBeforePayment({ companyId = currentCompanyId(), windowDays = 14 } = {}) {
    const { rows } = await pool.query(
      `SELECT p.id AS payment_id, p.payment_number, p.payment_date, p.payment_amount::float AS amount,
              c.field_name, c.changed_at, c.old_value, c.new_value, c.changed_by,
              s.legal_name AS supplier_name
         FROM supplier_payments p
         JOIN supplier_bank_detail_changes c
           ON c.supplier_id = p.supplier_id
          AND c.changed_at::date BETWEEN p.payment_date - $2::int AND p.payment_date
         JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.company_id = $1 AND p.deleted_at IS NULL
          AND p.status NOT IN ('CANCELLED')`,
      [companyId, windowDays]
    );

    const pending = [];
    for (const row of rows) {
      queueFinding(pending, {
        companyId,
        finding_type: 'BANK_DETAIL_CHANGE_BEFORE_PAYMENT',
        severity: 'HIGH',
        entity_type: 'SUPPLIER_PAYMENT',
        entity_id: row.payment_id,
        title: `Bank details for ${row.supplier_name} changed just before payment ${row.payment_number}`,
        description:
          `${row.supplier_name}'s ${row.field_name.replace(/_/g, ' ')} changed ` +
          `${Math.max(daysBetween(row.changed_at, row.payment_date), 0)} day(s) before a payment ` +
          `of ${fmt(row.amount)} was made. A bank detail changed immediately before a payment is ` +
          `the classic vendor-bank-fraud redirection — verify the new details with the vendor ` +
          `by a known phone number before releasing funds.`,
        data: {
          payment_number: row.payment_number,
          supplier_name: row.supplier_name,
          field_name: row.field_name,
          old_value: row.old_value,
          new_value: row.new_value,
          changed_at: row.changed_at,
          payment_date: row.payment_date,
          amount: row.amount,
        },
      });
    }

    return (await Promise.all(pending)).filter((r) => r && r.id).length;
  }

  /**
   * Entries just under an approval threshold, per approver. Thresholds are
   * learned from the configured approval chains / delegation of authority, so
   * a $9,500 entry under a $10,000 threshold is flagged for the approver who
   * signed it.
   */
  static async detectThresholdHuggingPerApprover({ companyId = currentCompanyId(), hugFraction = 0.9 } = {}) {
    // Learn the company's approval thresholds.
    const { rows: chainRows } = await pool.query(
      `SELECT DISTINCT s.min_amount::float AS threshold
         FROM approval_chain_steps s
         JOIN approval_chain_templates t ON t.id = s.template_id
        WHERE t.company_id = $1 AND t.is_active = true AND s.min_amount > 0`,
      [companyId]
    );
    const { rows: doaRows } = await pool.query(
      `SELECT DISTINCT min_amount::float AS threshold
         FROM delegation_of_authority
        WHERE company_id = $1 AND is_active = true AND min_amount > 0`,
      [companyId]
    );
    const thresholds = [...new Set([...chainRows, ...doaRows].map((r) => r.threshold))];
    if (!thresholds.length) return 0;

    const pending = [];
    for (const threshold of thresholds) {
      const lowerBound = threshold * hugFraction;
      const { rows } = await pool.query(
        `SELECT je.id, je.journal_number, je.total_debit::float AS amount, je.approved_by,
                u.first_name || ' ' || u.last_name AS approver_name
           FROM journal_entries je
           LEFT JOIN users u ON u.id = je.approved_by
          WHERE je.company_id = $1 AND je.status = 'POSTED' AND je.deleted_at IS NULL
            AND je.total_debit >= $2 AND je.total_debit < $3
            AND je.approved_by IS NOT NULL`,
        [companyId, lowerBound, threshold]
      );

      for (const row of rows) {
        queueFinding(pending, {
          companyId,
          finding_type: 'THRESHOLD_HUGGING',
          severity: 'MEDIUM',
          entity_type: 'JOURNAL_ENTRY',
          entity_id: row.id,
          title: `${row.approver_name || 'An approver'} approved ${row.journal_number} just under the ${fmt(threshold)} approval threshold`,
          description:
            `${row.journal_number} posts ${fmt(row.amount)}, which sits within ` +
            `${Math.round((1 - hugFraction) * 100)}% below the ${fmt(threshold)} approval ` +
            `threshold that ${row.approver_name || 'this approver'} would otherwise need for ` +
            `it. Repeated just-under-threshold approvals are how larger payments sneak past ` +
            `controls.`,
          data: { journal_number: row.journal_number, amount: row.amount, threshold, approver: row.approved_by, approver_name: row.approver_name },
        });
      }
    }

    return (await Promise.all(pending)).filter((r) => r && r.id).length;
  }

  /**
   * Weekend / after-hours postings, weighted by whether that user normally
   * does that. A user who never works off-hours posting at 2am is suspicious;
   * the night-shift accountant posting at 2am is not.
   */
  static async detectOffHoursPostingsWeighted({ companyId = currentCompanyId(), minHistory = 5, consistentRate = 0.3 } = {}) {
    const { rows } = await pool.query(
      `SELECT id, journal_number, total_debit::float AS amount, created_at, created_by,
              (EXTRACT(ISODOW FROM created_at) IN (6, 7)
               OR EXTRACT(HOUR FROM created_at) >= 22
               OR EXTRACT(HOUR FROM created_at) <= 5) AS off_hours
         FROM journal_entries
        WHERE company_id = $1 AND status = 'POSTED' AND deleted_at IS NULL
          AND created_at >= CURRENT_TIMESTAMP - INTERVAL '365 days'`,
      [companyId]
    );

    // Learn each user's normal off-hours rate from their own history.
    const perUser = new Map();
    for (const r of rows) {
      if (!perUser.has(r.created_by)) perUser.set(r.created_by, { total: 0, offHours: 0, postings: [] });
      const u = perUser.get(r.created_by);
      u.total += 1;
      if (r.off_hours) u.offHours += 1;
      u.postings.push(r);
    }

    const pending = [];
    for (const [userId, u] of perUser) {
      if (u.total < minHistory) continue; // not enough history to know their pattern
      const rate = u.offHours / u.total;
      if (rate >= consistentRate) continue; // they normally work off-hours — not anomalous

      for (const r of u.postings) {
        if (!r.off_hours) continue;
        queueFinding(pending, {
          companyId,
          finding_type: 'OFF_HOURS_POSTING',
          severity: 'LOW',
          entity_type: 'JOURNAL_ENTRY',
          entity_id: r.id,
          title: `${r.journal_number} was posted off-hours by someone who does not normally do that`,
          description:
            `This user posts off-hours only ${fmt(rate * 100)}% of the time (${u.offHours} of ` +
            `${u.total} postings in the past year), yet ${r.journal_number} was posted at ` +
            `${new Date(r.created_at).toISOString()}. Off-hours postings by a user who does not ` +
            `normally work off-hours can signal a hijacked session.`,
          data: { journal_number: r.journal_number, amount: r.amount, created_at: r.created_at, user_off_hours_rate: round2(rate), user_total_postings: u.total, user_id: userId },
        });
      }
    }

    return (await Promise.all(pending)).filter((r) => r && r.id).length;
  }

  /**
   * Vendor sharing an address, bank account or tax id with an employee.
   * A vendor that is literally an employee is a self-dealing red flag; a
   * shared bank account is how fake-vendor fraud pays out.
   */
  static async detectVendorEmployeeLink({ companyId = currentCompanyId() } = {}) {
    const { rows } = await pool.query(
      `SELECT s.id AS supplier_id, s.legal_name AS supplier_name,
              e.id AS employee_id, e.first_name || ' ' || e.last_name AS employee_name,
              CASE
                WHEN s.bank_account_number IS NOT NULL
                 AND e.bank_account_number IS NOT NULL
                 AND regexp_replace(s.bank_account_number, '\D', '', 'g') = regexp_replace(e.bank_account_number, '\D', '', 'g')
                THEN 'BANK_ACCOUNT'
                WHEN s.tax_id IS NOT NULL AND e.tax_id IS NOT NULL
                 AND lower(regexp_replace(s.tax_id, '\s', '', 'g')) = lower(regexp_replace(e.tax_id, '\s', '', 'g'))
                THEN 'TAX_ID'
                WHEN s.address IS NOT NULL AND e.address IS NOT NULL
                 AND lower(regexp_replace(s.address, '\s+', ' ', 'g')) = lower(regexp_replace(e.address, '\s+', ' ', 'g'))
                THEN 'ADDRESS'
                ELSE NULL
              END AS link_type
         FROM suppliers s
         JOIN employees e ON e.company_id = s.company_id
        WHERE s.company_id = $1 AND s.status = 'ACTIVE'
          AND e.deleted_at IS NULL AND e.status = 'ACTIVE'`,
      [companyId]
    );

    const pending = [];
    for (const row of rows) {
      if (!row.link_type) continue;
      const isBankOrTax = row.link_type !== 'ADDRESS';
      const label = row.link_type.toLowerCase().replace(/_/g, ' ');
      queueFinding(pending, {
        companyId,
        finding_type: 'VENDOR_EMPLOYEE_LINK',
        severity: isBankOrTax ? 'HIGH' : 'MEDIUM',
        entity_type: 'SUPPLIER',
        entity_id: row.supplier_id,
        title: `${row.supplier_name} shares a ${label} with employee ${row.employee_name}`,
        description:
          `Vendor ${row.supplier_name} and employee ${row.employee_name} share the same ${label}. ` +
          `A vendor that overlaps with an employee is either self-dealing or a fake-vendor ` +
          `setup — confirm this relationship is legitimate and arm's-length.`,
        data: { supplier_id: row.supplier_id, supplier_name: row.supplier_name, employee_id: row.employee_id, employee_name: row.employee_name, link_type: row.link_type },
      });
    }

    return (await Promise.all(pending)).filter((r) => r && r.id).length;
  }

  /**
   * Run every Round 7 detector for a company. Returns per-detector counts of
   * NEW findings, plus the total.
   */
  static async runAnomalyScan({ companyId = currentCompanyId() } = {}) {
    const results = {
      vendor_baseline_deviation: await this.detectVendorBaselineDeviation({ companyId }),
      account_baseline_deviation: await this.detectAccountBaselineDeviation({ companyId }),
      duplicate_payments: await this.detectDuplicatePayments({ companyId }),
      bank_detail_change_before_payment: await this.detectBankDetailChangeBeforePayment({ companyId }),
      threshold_hugging: await this.detectThresholdHuggingPerApprover({ companyId }),
      off_hours_postings: await this.detectOffHoursPostingsWeighted({ companyId }),
      vendor_employee_links: await this.detectVendorEmployeeLink({ companyId }),
    };
    return {
      company_id: companyId,
      total_new_findings: Object.values(results).reduce((a, b) => a + b, 0),
      ...results,
    };
  }
}

// --- helpers ---------------------------------------------------------------

/** Queue one finding upsert; results are awaited before the detector returns. */
function queueFinding(pending, args) {
  pending.push(upsertFinding(args));
}

/**
 * Robust deviation scores against a baseline, with a rule for degenerate
 * baselines. Uses median/MAD like stats.outlierScores, but when MAD collapses
 * to zero (more than half the values are identical — very common for real
 * vendors) the standard-deviation fallback lets one large anomaly inflate the
 * scale and hide itself. With an all-identical baseline ANY difference is a
 * deviation, so the score is scaled against 1% of the median instead.
 */
function robustScores(xs) {
  if (xs.length < 3) return xs.map(() => 0);
  const centre = stats.median(xs);
  const scale = stats.mad(xs);
  if (scale === 0) {
    if (!centre) return xs.map(() => 0);
    return xs.map((x) => (x - centre) / (centre * 0.01));
  }
  return xs.map((x) => (x - centre) / scale);
}

function fmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function daysBetween(a, b) {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.round((da - db) / 86400000);
}

function iso(d) {
  const date = new Date(d);
  return date.toISOString().split('T')[0];
}

/** Local calendar date as YYYY-MM-DD (pg DATE arrives as a local-midnight Date). */
function dateStr(d) {
  const date = d instanceof Date ? d : new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

module.exports = AnomalyDetectionService;
