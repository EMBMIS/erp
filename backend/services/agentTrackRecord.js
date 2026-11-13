/**
 * Authority granted from measured outcomes.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * An agent starts read-only. The authority engine (agents/authority.js) holds
 * it to whatever mode and limits it has; nothing so far said when it should
 * have more, or less. This reads what actually happened to everything each
 * agent did or asked for, from the company's own rows:
 *
 *   Escalations   what the agent wanted to do and was not allowed to alone.
 *                 A person approved it or rejected it (agent_escalations).
 *   Drafts        the requisitions it drafted: approved as drafted, approved
 *                 with a changed quantity, declined or cancelled.
 *   Findings      what it reported: resolved or acknowledged by a person, or
 *                 dismissed as a false alarm.
 *   Reminders     the dunning reminders it sent: whether the invoice was paid
 *                 within 21 days of the reminder.
 *   Failures      actions that errored.
 *
 * From that record it says, by fixed rules written below where a person can
 * read and disagree with them, whether an agent has earned the next mode
 * (observe → propose → act), a higher money limit (the largest amount people
 * approved with nothing at or below it rejected), or should lose authority.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * Measuring changes nothing. A proposal is carried out by grantEarnedAuthority
 * only when a manager or admin confirms it, after the record is measured
 * again; the change and the evidence behind it go into the hash-chained audit
 * trail. Switching an agent on or off stays on the Agents screen.
 */

const { pool } = require('../config/database');
const companyContext = require('./companyContext');
const { describeAuthority } = require('./agents/authority');

const DEFAULT_WINDOW_DAYS = 90;
const REMINDER_EFFECT_DAYS = 21;
const ACTORS = new Set(['ADMIN', 'MANAGER']);

/** The rules. A promotion needs enough decided work and near-total agreement. */
const RULES = {
  min_decided: 10,
  promote_to_propose_agreement: 0.85,
  promote_to_act_agreement: 0.9,
  promote_max_rejected: 0.05,
  promote_max_failed: 0.05,
  limit_min_decided: 5,
  limit_approval: 0.9,
  limit_cap_multiple: 2,
  demote_min_decided: 5,
  demote_act_rejected: 0.25,
  demote_propose_rejected: 0.4,
  demote_min_actions: 5,
  demote_failed: 0.2,
};

const NEXT_MODE = { observe: 'propose', propose: 'act' };
const LOWER_MODE = { act: 'propose', propose: 'observe' };
const MODE_WORDS = {
  observe: 'observe (reports only)',
  propose: 'propose (drafts for a person to approve)',
  act: 'act (real changes within its limits)',
};
const AMOUNT_REASONS = new Set(['AMOUNT_ABOVE_AUTHORITY', 'NO_AMOUNT_LIMIT_CONFIGURED']);

const DAY = 86400000;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const fmtMoney = (v, cur) => `${cur ? `${cur} ` : ''}${Math.round(Number(v) || 0).toLocaleString('en-US')}`;

/** The smallest of 1, 2, 2.5, 5 × 10^n at or above v — a limit a person would write. */
function niceCeil(v) {
  const n = Number(v);
  if (!(n > 0)) return null;
  const mag = 10 ** Math.floor(Math.log10(n));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * mag >= n - 1e-9) return s * mag;
  return 10 * mag;
}

async function resolveCompany(companyId) {
  return companyId || companyContext.currentCompanyId() || (await companyContext.getDefaultCompanyId());
}

/* ------------------------------------------------------------------ reads */

async function readRecord(companyId, days, agentKey) {
  const since = new Date(Date.now() - days * DAY);
  const keyFilter = agentKey ? 'AND agent_key = $3' : '';
  const args = agentKey ? [companyId, since, agentKey] : [companyId, since];

  const { rows: definitions } = await pool.query(
    `SELECT id, agent_key, display_name, domain, mode, enabled, authority
       FROM agent_definitions
      WHERE company_id = $1 ${agentKey ? 'AND agent_key = $2' : ''}
      ORDER BY domain, display_name`,
    agentKey ? [companyId, agentKey] : [companyId],
  );

  const { rows: escalations } = await pool.query(
    `SELECT id, agent_key, reason, proposed_action, status, amount, currency, title,
            resolution_note, created_at, resolved_at
       FROM agent_escalations
      WHERE company_id = $1 AND created_at >= $2 ${keyFilter}`,
    args,
  );

  // Only runs that were not previews: a dry run's "proposed" changed nothing
  // and nobody was asked to judge it.
  const { rows: actions } = await pool.query(
    `SELECT a.agent_key, a.action_type, a.decision, a.entity_type, a.entity_id, a.entity_label,
            a.amount, a.currency, a.outcome, a.error, a.created_at
       FROM agent_run_actions a
       JOIN agent_runs r ON r.id = a.run_id
      WHERE r.company_id = $1 AND r.dry_run = false AND a.created_at >= $2
        AND a.decision IN ('proposed', 'acted', 'failed')
        ${agentKey ? 'AND a.agent_key = $3' : ''}`,
    args,
  );

  const prIds = [];
  const findingIds = [];
  const invoiceIds = [];
  for (const a of actions) {
    const o = a.outcome || {};
    if (o.purchase_requisition_id) prIds.push(o.purchase_requisition_id);
    if (o.finding_id) findingIds.push(o.finding_id);
    if (a.decision === 'acted' && a.entity_type === 'customer_invoice' && a.entity_id) invoiceIds.push(a.entity_id);
  }

  const [prs, findings, allocations] = await Promise.all([
    prIds.length
      ? pool.query(
        `SELECT id, pr_number, status, quantity FROM purchase_requisitions WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [companyId, prIds],
      ).then((r) => r.rows)
      : [],
    findingIds.length
      ? pool.query(
        `SELECT id, status, title, dismiss_reason FROM ai_findings WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [companyId, findingIds],
      ).then((r) => r.rows)
      : [],
    invoiceIds.length
      ? pool.query(
        `SELECT cpa.invoice_id, cpa.allocation_date, cpa.allocation_amount
           FROM customer_payment_allocations cpa
           JOIN customer_invoices ci ON ci.id = cpa.invoice_id
          WHERE ci.company_id = $1 AND cpa.invoice_id = ANY($2::uuid[])`,
        [companyId, invoiceIds],
      ).then((r) => r.rows)
      : [],
  ]);

  return {
    definitions,
    escalations,
    actions,
    prs: new Map(prs.map((p) => [p.id, p])),
    findings: new Map(findings.map((f) => [f.id, f])),
    allocations,
  };
}

/* ---------------------------------------------------------------- measure */

/**
 * Everything a person has judged for one agent, as one list:
 * { source, action, verdict: accepted | changed | rejected | pending, amount, currency, label, at, note }
 */
function judgements(agentKey, data) {
  const out = [];
  for (const e of data.escalations) {
    if (e.agent_key !== agentKey || e.status === 'EXPIRED') continue;
    out.push({
      source: 'escalation',
      action: e.proposed_action || 'unknown',
      reason: e.reason,
      verdict: e.status === 'APPROVED' ? 'accepted' : e.status === 'REJECTED' ? 'rejected' : 'pending',
      amount: e.amount != null ? Number(e.amount) : null,
      currency: e.currency,
      label: e.title,
      at: e.resolved_at || e.created_at,
      note: e.resolution_note || null,
    });
  }
  for (const a of data.actions) {
    if (a.agent_key !== agentKey) continue;
    const o = a.outcome || {};
    if (o.purchase_requisition_id) {
      const pr = data.prs.get(o.purchase_requisition_id);
      let verdict = 'pending';
      if (!pr || ['DECLINED', 'CANCELLED'].includes(pr.status)) verdict = 'rejected';
      else if (pr.status === 'APPROVED') {
        verdict = o.quantity != null && Number(pr.quantity) !== Number(o.quantity) ? 'changed' : 'accepted';
      }
      out.push({
        source: 'draft', action: a.action_type, verdict,
        amount: a.amount != null ? Number(a.amount) : null, currency: a.currency,
        label: `${pr?.pr_number || o.pr_number || 'Requisition'} · ${a.entity_label || ''}`.trim(),
        at: a.created_at,
        note: !pr ? 'Requisition no longer exists.' : verdict === 'changed' ? `Approved at ${Number(pr.quantity)} instead of ${Number(o.quantity)}.` : null,
      });
    } else if (o.finding_id) {
      const f = data.findings.get(o.finding_id);
      const verdict = !f ? 'pending' : f.status === 'DISMISSED' ? 'rejected' : ['RESOLVED', 'ACKNOWLEDGED'].includes(f.status) ? 'accepted' : 'pending';
      out.push({
        source: 'finding', action: a.action_type, verdict,
        amount: null, currency: null, label: f?.title || a.entity_label || 'Finding', at: a.created_at,
        note: verdict === 'rejected' && f.dismiss_reason ? `Dismissed: ${f.dismiss_reason}` : null,
      });
    }
  }
  return out;
}

/** The highest amount people approved with nothing at or below it rejected. */
function clearAmount(items) {
  const priced = items.filter((j) => j.amount != null && j.verdict !== 'pending').sort((a, b) => a.amount - b.amount);
  let clear = null;
  for (const j of priced) {
    if (j.verdict !== 'accepted') break;
    clear = j.amount;
  }
  return clear;
}

function reminderEffect(agentKey, data) {
  const sent = data.actions.filter((a) => a.agent_key === agentKey && a.decision === 'acted'
    && a.entity_type === 'customer_invoice' && a.action_type === 'send_dunning_reminder');
  if (!sent.length) return null;
  let paid = 0;
  let unpaid = 0;
  let waiting = 0;
  let collected = 0;
  for (const a of sent) {
    const from = new Date(a.created_at);
    const until = new Date(from.getTime() + REMINDER_EFFECT_DAYS * DAY);
    const hits = data.allocations.filter((p) => p.invoice_id === a.entity_id
      && new Date(p.allocation_date) >= new Date(iso(from)) && new Date(p.allocation_date) <= until);
    if (hits.length) {
      paid++;
      collected += hits.reduce((s, p) => s + Number(p.allocation_amount), 0);
    } else if (until > new Date()) waiting++;
    else unpaid++;
  }
  return {
    reminders_sent: sent.length,
    paid_within_days: REMINDER_EFFECT_DAYS,
    paid,
    not_paid: unpaid,
    still_in_window: waiting,
    paid_pct: pct(paid, paid + unpaid),
    collected,
    currency: sent.find((a) => a.currency)?.currency || null,
  };
}

function measureAgent(def, data, days) {
  const mode = def.mode;
  const authority = def.authority || {};
  const js = judgements(def.agent_key, data);
  const decided = js.filter((j) => j.verdict !== 'pending');
  const accepted = decided.filter((j) => j.verdict === 'accepted').length;
  const changed = decided.filter((j) => j.verdict === 'changed').length;
  const rejected = decided.filter((j) => j.verdict === 'rejected').length;
  const own = data.actions.filter((a) => a.agent_key === def.agent_key);
  const failed = own.filter((a) => a.decision === 'failed').length;
  const performed = own.length;

  const byAction = new Map();
  for (const j of js) {
    const b = byAction.get(j.action) || { action: j.action, decided: 0, accepted: 0, changed: 0, rejected: 0, pending: 0 };
    b[j.verdict === 'accepted' ? 'accepted' : j.verdict === 'changed' ? 'changed' : j.verdict === 'rejected' ? 'rejected' : 'pending']++;
    if (j.verdict !== 'pending') b.decided++;
    byAction.set(j.action, b);
  }

  const amountItems = js.filter((j) => j.source === 'escalation' && AMOUNT_REASONS.has(j.reason));
  const amountDecided = amountItems.filter((j) => j.verdict !== 'pending');
  const amountApproved = amountDecided.filter((j) => j.verdict === 'accepted').length;
  const currency = authority.currency || js.find((j) => j.currency)?.currency || null;

  const record = {
    decided: decided.length,
    accepted,
    accepted_with_changes: changed,
    rejected,
    pending: js.length - decided.length,
    agreement_pct: pct(accepted, decided.length),
    rejected_pct: pct(rejected, decided.length),
    actions: performed,
    failed,
    failed_pct: pct(failed, performed),
  };

  const proposals = [];
  let verdict = 'too_early';
  let reason;
  const agreement = decided.length ? accepted / decided.length : 0;
  const rejectedShare = decided.length ? rejected / decided.length : 0;
  const failedShare = performed ? failed / performed : 0;
  const evidence = `${accepted} of ${decided.length} decided ${decided.length === 1 ? 'item' : 'items'} accepted as proposed`
    + `${changed ? `, ${changed} changed` : ''}${rejected ? `, ${rejected} rejected` : ''} in ${days} days`
    + `${failed ? `; ${failed} of ${performed} actions failed` : ''}`;

  // Losing authority comes first: a bad record is never offset by a large one.
  const demote = LOWER_MODE[mode] && (
    (mode === 'act' && decided.length >= RULES.demote_min_decided && rejectedShare >= RULES.demote_act_rejected)
    || (mode === 'propose' && decided.length >= RULES.demote_min_decided && rejectedShare >= RULES.demote_propose_rejected)
    || (performed >= RULES.demote_min_actions && failedShare >= RULES.demote_failed)
  );

  if (demote) {
    verdict = 'lose';
    const to = LOWER_MODE[mode];
    reason = failedShare >= RULES.demote_failed && performed >= RULES.demote_min_actions
      ? `${failed} of ${performed} actions failed (${pct(failed, performed)}%), at or above the ${RULES.demote_failed * 100}% that costs an agent its mode.`
      : `People rejected ${rejected} of ${decided.length} (${pct(rejected, decided.length)}%), at or above the ${(mode === 'act' ? RULES.demote_act_rejected : RULES.demote_propose_rejected) * 100}% that costs an agent its mode.`;
    proposals.push({
      id: `mode:${def.agent_key}:${to}`,
      kind: 'lower_mode',
      label: `Move ${def.display_name} from ${mode} to ${to}`,
      from: { mode },
      to: { mode: to },
      why: reason,
      evidence,
    });
  } else if (NEXT_MODE[mode]) {
    const to = NEXT_MODE[mode];
    const need = mode === 'observe' ? RULES.promote_to_propose_agreement : RULES.promote_to_act_agreement;
    const allowed = Array.isArray(authority.allowed_actions) ? authority.allowed_actions : [];
    if (decided.length < RULES.min_decided) {
      reason = `${decided.length} of the ${RULES.min_decided} decided items a promotion needs. ${RULES.min_decided - decided.length} more before it can earn ${to}.`;
    } else if (agreement < need || rejectedShare > RULES.promote_max_rejected) {
      verdict = 'holding';
      reason = `${pct(accepted, decided.length)}% accepted as proposed and ${pct(rejected, decided.length)}% rejected; ${to} needs ${need * 100}% accepted and no more than ${RULES.promote_max_rejected * 100}% rejected.`;
    } else if (failedShare > RULES.promote_max_failed) {
      verdict = 'holding';
      reason = `${pct(failed, performed)}% of its actions failed; ${to} needs ${RULES.promote_max_failed * 100}% or fewer.`;
    } else if (to === 'act' && !allowed.length) {
      verdict = 'holding';
      reason = 'Its record is good enough for act, but it has no allowed actions configured, so act would let it do nothing.';
    } else {
      verdict = 'earned';
      reason = `${pct(accepted, decided.length)}% of ${decided.length} decided items accepted as proposed, ${pct(rejected, decided.length)}% rejected — above the ${need * 100}% ${to} needs.`;
      const p = {
        id: `mode:${def.agent_key}:${to}`,
        kind: 'raise_mode',
        label: `Let ${def.display_name} ${to === 'act' ? 'act on its own within its limits' : 'prepare drafts for approval'}`,
        from: { mode },
        to: { mode: to },
        why: reason,
        evidence,
      };
      // Acting with money and no ceiling is escalated by the engine anyway;
      // give it the ceiling its record supports instead.
      const clear = clearAmount(js);
      if (to === 'act' && !Number.isFinite(Number(authority.max_amount)) && clear) {
        p.to.max_amount = niceCeil(clear);
        p.to.currency = currency;
        p.label += ` up to ${fmtMoney(p.to.max_amount, currency)}`;
        p.id += `:${p.to.max_amount}`;
      }
      proposals.push(p);
    }
  } else {
    verdict = 'holding';
    reason = `Already at act. ${decided.length ? `${pct(accepted, decided.length)}% of ${decided.length} decided items accepted as proposed.` : 'Nothing decided yet in this window.'}`;
  }

  // A higher limit: people keep approving amounts above it.
  let limit = null;
  const max = Number(authority.max_amount);
  if (!demote && amountDecided.length && Number.isFinite(max)) {
    const clear = clearAmount(amountItems);
    limit = {
      current: max,
      currency,
      decided: amountDecided.length,
      approved: amountApproved,
      highest_clear: clear,
    };
    if (amountDecided.length >= RULES.limit_min_decided
      && amountApproved / amountDecided.length >= RULES.limit_approval && clear && clear > max) {
      const to = Math.min(niceCeil(clear), max * RULES.limit_cap_multiple);
      if (to > max) {
        if (verdict !== 'earned') verdict = 'earned';
        const why = `People approved ${amountApproved} of the ${amountDecided.length} items above its ${fmtMoney(max, currency)} limit, up to ${fmtMoney(clear, currency)} with nothing at or below that rejected.`;
        limit.proposed = to;
        proposals.push({
          id: `limit:${def.agent_key}:${to}`,
          kind: 'raise_limit',
          label: `Raise the limit of ${def.display_name} from ${fmtMoney(max, currency)} to ${fmtMoney(to, currency)}`,
          from: { max_amount: max },
          to: { max_amount: to, currency },
          why: `${why}${to < niceCeil(clear) ? ` Capped at ${RULES.limit_cap_multiple}× the current limit.` : ''}`,
          evidence,
        });
        reason = proposals.length > 1 ? `${reason} ${why}` : why;
      }
    }
  }

  const examples = js
    .filter((j) => j.verdict === 'rejected' || j.verdict === 'changed')
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 5)
    .map((j) => ({ verdict: j.verdict, action: j.action, label: j.label, amount: j.amount, currency: j.currency, on: iso(j.at), note: j.note }));

  return {
    agent_key: def.agent_key,
    name: def.display_name,
    domain: def.domain,
    enabled: def.enabled,
    mode,
    authority: describeAuthority(authority, mode),
    earned: authority.earned || null,
    record,
    by_action: [...byAction.values()],
    limit,
    reminders: reminderEffect(def.agent_key, data),
    verdict,
    reason,
    proposals,
    rejected_or_changed: examples,
  };
}

/**
 * The measured record of every agent (or one), with what each has earned.
 * Readable by anyone signed in, like run history; `can_grant` says whether
 * the reader may confirm a proposal.
 */
async function agentTrackRecord(opts = {}) {
  const companyId = await resolveCompany(opts.companyId);
  const days = Math.min(Math.max(Number(opts.days) || DEFAULT_WINDOW_DAYS, 7), 365);
  const agentKey = opts.agentKey ? String(opts.agentKey) : null;

  return companyContext.runWithCompany(companyId, async () => {
    const data = await readRecord(companyId, days, agentKey);
    if (agentKey && !data.definitions.length) return { error: `No agent called "${agentKey}" in this company.` };
    // What needs a decision first: earned, then should lose, then the rest.
    const ORDER = { earned: 0, lose: 1, holding: 2, too_early: 3 };
    const agents = data.definitions.map((d) => measureAgent(d, data, days))
      .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);

    const earned = agents.filter((a) => a.verdict === 'earned');
    const lose = agents.filter((a) => a.verdict === 'lose');
    const decided = agents.reduce((s, a) => s + a.record.decided, 0);
    const parts = [];
    if (earned.length) parts.push(`${earned.length} ${earned.length === 1 ? 'agent has' : 'agents have'} earned more authority (${earned.map((a) => a.name).join(', ')})`);
    if (lose.length) parts.push(`${lose.length} should lose some (${lose.map((a) => a.name).join(', ')})`);
    const headline = !agents.length
      ? 'No agents are registered in this company yet.'
      : parts.length
        ? `${parts.join('; ')}. Measured from ${decided} decisions people made on their work in the last ${days} days.`
        : decided
          ? `No agent's authority should change yet. ${decided} decisions people made on agent work in the last ${days} days.`
          : `No one has decided anything an agent proposed in the last ${days} days, so no agent has a record to earn authority from yet.`;

    return {
      headline,
      window_days: days,
      rules: RULES,
      can_grant: ACTORS.has(opts.role),
      agents,
      proposals: agents.flatMap((a) => a.proposals.map((p) => ({ ...p, agent_key: a.agent_key, agent: a.name, enabled: a.enabled }))),
    };
  });
}

/**
 * Carry out one proposal after a manager or admin confirms it. The record is
 * measured again first; a proposal that no longer holds is refused.
 */
async function grantEarnedAuthority({ companyId: given, userId, role, proposalId, days }) {
  if (!ACTORS.has(role)) return { error: 'Only a manager or an admin can change what an agent may do.', status: 403 };
  if (!proposalId) return { error: 'proposal_id is required.', status: 400 };
  const companyId = await resolveCompany(given);
  const agentKey = String(proposalId).split(':')[1];
  const fresh = await agentTrackRecord({ companyId, role, agentKey, days });
  if (fresh.error) return { error: fresh.error, status: 404 };
  const p = fresh.proposals.find((x) => x.id === proposalId);
  if (!p) {
    return { error: 'That proposal no longer holds — the record or the agent changed. Look at the track record again to see what it supports now.', status: 409 };
  }

  return companyContext.runWithCompany(companyId, async () => {
    const { rows: [def] } = await pool.query(
      'SELECT id, mode, authority FROM agent_definitions WHERE company_id = $1 AND agent_key = $2',
      [companyId, agentKey],
    );
    const before = def.authority || {};
    const authority = { ...before };
    const mode = p.to.mode || def.mode;
    if (p.to.max_amount != null) authority.max_amount = p.to.max_amount;
    if (p.to.currency && !authority.currency) authority.currency = p.to.currency;
    authority.earned = {
      at: new Date().toISOString(),
      by: userId || null,
      proposal: p.id,
      change: p.label,
      evidence: p.evidence,
    };

    const { rowCount } = await pool.query(
      `UPDATE agent_definitions SET mode = $3, authority = $4, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $1 AND agent_key = $2 AND mode = $5`,
      [companyId, agentKey, mode, JSON.stringify(authority), def.mode],
    );
    if (!rowCount) return { error: 'The agent changed while this was being confirmed. Look again.', status: 409 };

    const describe = (m, a) => `${m}${Number.isFinite(Number(a.max_amount)) ? ` ≤ ${fmtMoney(a.max_amount, a.currency)}` : ''}`;
    await require('./auditTrailService').appendAuditRecord({
      entity_type: 'agent_authority',
      entity_id: def.id,
      from_status: describe(def.mode, before),
      to_status: describe(mode, authority),
      changed_by: userId || null,
      reason: `${p.label}. ${p.why} Evidence: ${p.evidence}.`.slice(0, 2000),
      company_id: companyId,
    });

    return {
      done: `${p.label}.`,
      agent_key: agentKey,
      mode: MODE_WORDS[mode],
      authority: describeAuthority(authority, mode),
      enabled: p.enabled,
      next: p.enabled ? 'It applies from its next run.' : 'It is switched off; switching it on stays on the Agents screen.',
    };
  });
}

module.exports = { agentTrackRecord, grantEarnedAuthority, RULES };
