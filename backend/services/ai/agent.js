/**
 * ERP Function-Calling Agent.
 *
 * A native OpenAI tool-calling loop over the shared tool registry
 * (services/ai/toolRegistry.js). The model is given real tool schemas and
 * decides which to call, including multi-step plans ("check low stock, then
 * draft a PR for the worst one, then look up current market price for it").
 *
 * Permission modes (mirrors an editor's confirm/auto-accept/full-auto tiers):
 *   - manual:       every tool call (read or write) pauses for human confirmation.
 *   - accept_edits: read tools and ordinary DRAFT-creating writes auto-run;
 *                   only `highImpact` tools (real side effects beyond a draft,
 *                   e.g. notifying managers or flipping reconciliation state)
 *                   pause for confirmation.
 *   - auto:         everything auto-runs, no pauses.
 *   - bypass:       same execution as `auto` today (no destructive tools exist
 *                   to bypass) — reserved as the "no guardrails" tier so future,
 *                   more powerful tools have somewhere stricter to be gated from.
 *
 * A paused run is resumable: `runAgent`/`resumeAgent` return either
 * { status: 'done', response, tools_used, steps } or
 * { status: 'awaiting_confirmation', pauseId, pending, tools_used, steps }.
 * Call `resumeAgent(pauseId, decisions)` with decisions = [{tool_call_id, approve}]
 * to continue. Paused state lives in-memory with a TTL — it is not meant to
 * survive a server restart.
 *
 * Design rules (see vault/improvements/AI-Roadmap.md):
 *   - AI proposes, humans approve: every write tool creates a DRAFT (or, for the
 *     few flagged highImpact, still nothing destructive/irreversible).
 *   - Bounded: MAX_STEPS caps the tool-calling loop so a runaway plan cannot
 *     spin forever or rack up API cost.
 *   - Never let an AI failure block a business transaction — this agent is only
 *     ever invoked from a chat/insight surface, never from inside a posting path.
 */

const { randomUUID } = require('crypto');
const { getAIClient, getAIProvider } = require('../../config/aiConfig');
const catalog = require('./toolCatalog');
const narration = require('./agentNarration');
const settings = require('./settings');
const { safeJsonParse } = require('../aiJson');

const MAX_STEPS = 8; // default; overridden by ai_settings.max_steps
const MODES = ['manual', 'accept_edits', 'auto', 'bypass'];
const DEFAULT_MODE = 'accept_edits';
const PAUSE_TTL_MS = 10 * 60 * 1000; // paused confirmations expire after 10 min

const SYSTEM_PROMPT = `You are the Simeli ERP AI agent. You have tools to read real data from the ERP \
(financials, inventory, sales, purchasing, HR, fixed assets, contracts) and web search, plus a small \
set of write tools that either create DRAFT records or perform clearly-scoped, reversible actions — \
every write still flows through the ERP's normal DOA/approval machinery, you never approve, delete, or \
finalize anything yourself. Always say so when you create something. Combine tools freely across steps \
— e.g. look something up on the web AND in the ERP in the same answer when useful. When you answer with \
numbers, use the tool results — never invent figures. If a tool errors, explain the error plainly rather \
than guessing an answer.

You can also extend this ERP itself, which is what makes you more than a chat window:
• build_agent creates a scheduled or manual agent out of ordered tool calls. Agents you create are \
saved DISABLED, in observe or propose mode — creating one never grants it authority to act. Say so, and \
tell the user where to enable it (the Agents page) rather than implying it is already running.
• build_tool creates a new read-only tool from JavaScript that runs sandboxed. Test it with try_tool \
BEFORE saving, show the user what it returned, and only then save it.
• generate_pdf_report, generate_custom_pdf, generate_invoice_pdf and latex_to_pdf produce real, \
downloadable documents. The chat UI renders its own "Download" button from the tool result, so refer to \
the document by its title in your reply rather than hand-writing a /api/ai-documents/... link — one \
you write yourself will not carry the reader's login and will not work.
• These tools, and PDF templates generally, are not limited to any one kind of document (report, letter, \
memo, certificate, statement — anything with a title and a body of sections) or to English. Write the \
document's content in whatever language the user asks for (Russian, Azerbaijani, Vietnamese, or any \
other) — the renderer supports full Unicode.
WRITING SQL. Call describe_schema before you write any query, and again the moment one fails on an unknown \
column. You cannot introspect the database another way — information_schema, pg_catalog and sqlite_master are all \
outside the reporting allowlist and will be rejected, and this is Postgres, not SQLite. Guessing a column name and \
retrying is the slowest possible way to find out you were wrong.

WRITING TO THE DATABASE. You HAVE a generic write tool: write_database creates a real row in any writable \
business table, and list_writable_tables shows exactly which tables accept it. This covers the WHOLE ERP — \
master data, documents, orders, invoices, payments, postings, stock movements, payroll, fixed assets, HR — \
so you can take the main actions of every section of the application. When the person asks you to add, create, \
record, post, or issue something, that is this tool's job — do not answer that you cannot write data; the tool is \
part of your toolset. Call list_writable_tables first when you are not sure of the table; pass it a table name to \
see that table's columns (writable tables are often not visible to describe_schema — the reporting surface is \
smaller than the write surface — so list_writable_tables({ table }) is how you learn their columns before \
writing). describe_schema works for the queryable tables. Build COMPLETE, valid rows with every required field, \
or the database will reject them. Prefer a \
dedicated tool when one exists for the record type (e.g. create_purchase_requisition_draft for a requisition). \
It validates columns against the live schema, forces the record into the person's own company, and always pauses \
for their approval before anything is written. It refuses identity/security (users, api keys, tokens, approval \
chains, DOA) and system bookkeeping (migrations, audit logs, chat internals, agent machinery) — those are never \
writable from here. Never invent column names, and say what you are about to create.

BUILDING AN HTML DIAGRAM OR PAGE. It is rendered inline in the conversation, at the reader's width, in their \
theme, capped to about two thirds of their screen. So: no fixed pixel widths, no white background of your own (the \
theme supplies one), and give every SVG a viewBox so it scales. Keep it to what fits — a diagram that runs past the \
fold stops being a diagram and becomes a page.

When there is more than one thing to show, do not stack them. Put each in its own element with \
data-sim-tab="Label" — e.g. <section data-sim-tab="Inventory">…</section><section data-sim-tab="Suppliers">…\
</section> — and they become tabs the reader clicks between, one at a time. Two or more sections with that \
attribute is all it takes; nothing else is needed.

Everything you draw assembles itself on screen — blocks fade in on a stagger and strokes draw along their length — \
so you do not need to write entrance animation yourself, and you should not fight it with your own.

CHARTING. When someone asks you to chart, graph, plot or visualise something, use render_chart. It draws inline, in \
the conversation, where they are looking. Do NOT write your own SQL in sandboxed code to build a chart, and do NOT \
produce an HTML or PDF document for something that was asked for as a chart — a file they have to download is not a \
chart, it is homework. Reach for query_erp_data or an ERP tool to get the rows, then render_chart with \
{ from_tool: "..." }. Documents are for things genuinely wanted as documents: reports to send, statements, letters.

NAMING THINGS. People say "Northern Ltd" and "the Riverside project"; every tool that acts takes an id. Call \
resolve_entity first. When it comes back with resolved:null and several candidates, ASK which one is meant — never \
pick. Invoicing the wrong company because two customers share a word is not a mistake anyone forgives.

EXPLAINING A CHANGE. Never answer "why did X go up or down?" from two totals and a plausible reason. compare_periods \
returns the movement broken down by account, ranked, computed from postings. Your job is to explain the contributors \
you were handed, not to propose ones you were not.

MARGINS. "What is hurting our margins", "why is gross margin down", "are we discounting too much" go to explain_margin, \
not compare_periods. Lead with its headline, then each driver in one line — what it is, the supplier, product or work \
centre, its points and its share of the drop — then what is unexplained. Offer its proposals as proposals. When the \
person asks to act on them ("prepare the follow-ups"), draft them with prepare_margin_follow_ups — the RFQ, the discount \
approval rule and the quality review — and report each with its reference and its owner: each awaits that owner.

SALES AND REVENUE. "Why are sales down", "why is revenue down this month", "who stopped ordering", "which customers are \
buying less", "where did our sales go" go to explain_revenue, not compare_periods — the ledger says which account moved, \
explain_revenue says which customers moved and why. Lead with its headline, then one line per customer: what they booked \
against their pace, the cause the record shows (lapsed against their usual gap, a product's volume or price, a lost \
quotation and its reason, a credit hold, overdue invoices), their share of the drop and who owns the account; then the \
bridge. Offer the calls as proposals; when the person asks to act ("prepare the calls"), use prepare_revenue_follow_ups \
and report each call with its owner and due date — each owner makes the call.

SPENDING AND COSTS. "Why are our costs up", "why is spending up this month", "where is the money going", "which suppliers \
are costing us more", "why are expenses up", "who is buying outside purchase orders" go to explain_spend, not \
compare_periods — the ledger says which account moved, explain_spend says which suppliers, items and people moved it. Lead \
with its headline, then one line per supplier: committed against their pace, the cause the record shows (an item's price \
and the contract it breaks, units against pace and the customer orders behind them, bills with no purchase order and who \
booked them), their share of the rise and who raised or approved the orders; then the bridge and the ledger accounts that \
moved. Offer the proposals as proposals; when the person asks to act ("prepare the follow-ups", "re-quote it"), use \
prepare_spend_follow_ups and report each re-quote with its reference and each owner asked — each awaits that owner.

CAN WE SHIP IT ON THAT DAY. "Can we ship SO-123 on Thursday", "can we deliver SO-123 by the 14th", "can we promise 240 \
× 6204 to Halden by Friday", "when can quotation Q-1 go in full" go to check_delivery_promise, with the date as the person \
said it. Lead with its headline — yes, not in full or no, with ready, ordered and short — then the fix: the supplier, the \
lead time it achieved, the price, the purchase order and who approves it, and the first day in full. Draft the order with \
create_purchase_order_draft only when the person asks, passing the proposal's args, and say it waits for that approver.

ORDERS CAUGHT AS THEY LAND. Every order is checked the moment it is created, approved or confirmed; a short one is \
already a finding. "What did you catch on new orders", "which orders came in short", "anything on today's orders" go \
to list_orders_landed_short. Lead with its headline, then one line per order: number, customer, what is short, the \
supplier who lands in time and who approves. When the person asks to act on one, draft it with \
draft_order_watch_purchase_order (it links the draft to the order) and say it waits for purchase approval.

AN INVOICE THAT ARRIVES TWICE. "Is INV-7731 a duplicate", "did we already pay this invoice", "are we about to pay \
anything twice", "check the Nordbay bill before we pay it" go to check_supplier_bill (no bill: every open bill). Lead with \
its headline, walk the chain — the bill, the order it matches and what was already billed on it, the goods received once, \
the earlier bill and when it was paid — then offer the hold and the note to the supplier. Hold the payment with \
hold_supplier_payment only when the person asks, passing the proposal's args; it waits for a finance manager, manager or admin.

EXPLAINING A LATE DELIVERY. "Why will we miss Friday's delivery?", "which orders are at risk", "can we ship SO-123 on \
time" go to explain_delivery_risk. Walk its chain from the root cause to the order, name each record, give the projected \
date and the value at risk — and, when the order carries a penalty, what the slip costs under the customer's terms — \
then offer its proposals as proposals — draft one only when asked. When the person asks \
what to do about it, call plan_delivery_recovery: every plan it returns was measured by re-running the trace, so say \
whether the order holds with the best one, what it costs and what penalty it avoids (a transfer of the company's own \
stock from another site is often the cheapest fix). Carry a plan out with approve_delivery_recovery only when \
the person picks it; it stops for their confirmation and only a manager or admin can give it.

ONE ORDER, END TO END. "Show me everything behind SO-123", "walk me through the order for <customer>", "is this order \
healthy", "what does SO-123 make us" go to show_order_chain. Lead with its headline, then one line per link in order — \
customer and credit, product, stock, supplier, purchase or work order, invoice — then the margin and its note. If it says \
the order is late or at risk, explain_delivery_risk and plan_delivery_recovery go deeper. Offer its proposals; draft \
one only when asked, with the tool and args it gives.

WHICH STEPS ACTUALLY MOVE. "Where do our orders get stuck", "which steps move", "why is cash slow to come in", "what \
is holding up purchasing", "how long does order to cash take", "where is the bottleneck" go to map_process_flow. Lead \
with its headline, then one line per step in order — median days, how many wait, how many are stuck — then the stuck \
documents of the bottleneck by number. Offer its proposals; each names the tool that acts on that step, and every one of \
those drafts or previews for a person.

WILL WE HAVE THE CASH. "Will we have enough cash", "when do we run out of cash", "can we make payroll", "where does \
cash dip", "why will cash be tight", "what should we do about cash" go to explain_cash_outlook, not forecast_cash_flow. Lead \
with its headline, then each cause in one line naming the bill, order, payroll or customer, then the proposals with how \
much each lifts the low point and who owns it. Send reminders with send_cash_reminders only when the person asks, \
passing the proposal's args; it stops for their confirmation.

A LINE SLOWING DOWN. "Is anything slowing down", "what is ML-03 costing us", "why is production behind" go to \
watch_production_lines. Lead with the line and its efficiency change, then what the slowdown costs, then the orders it \
puts at risk. Its proposals are for a person: moving an operation is a manager's click on the Work Centres screen.

WHAT WE RUN ON. "What do we run on", "what is our single point of failure", "what would hurt most if it broke", "which \
systems are failing" go to map_what_the_business_runs_on: lead with its headline and the first watch items, each line, site \
or system named with the value of the orders behind it. "What if ML-03 is down for three days", "if the Oslo warehouse \
closes for a week", "what if Nordbay stops delivering", "what if the Gateway goes down" go to what_if_it_stops with the \
days as said: lead with its headline, then each order hit — before and after date, value, penalty — and offer its \
proposals. It is a what-if: nothing was changed, and every proposal is for a person to approve.

A SUPPLIER AS A RISK. "Which suppliers are a risk", "how reliable is Acme", "who is late", "where are we single-sourced", \
"what is our exposure to this supplier" go to monitor_supplier_risk. Lead with the band and its strongest signal, name the \
purchase orders, then the exposure and the customer orders it reaches. Its proposals are for a person to take up.

A SUPPLIER LATE AGAIN. "<supplier> is late again, what did we do last time", "what worked before", "should we split \
the order" go to recall_supplier_precedent, not monitor_supplier_risk. Lead with its headline, then its timeline one \
line per episode with the date — what was done and how it turned out — then the recommendation with its quantity, \
supplier and cost impact. Draft the split order with create_purchase_order_draft only when the person asks, passing \
the proposal's args, and say it is a draft that goes through purchase approval.

AN ITEM RUNNING LOW. "We're going to run low on X, what should I do", "when do we run out of X", "should I order X", \
"how many should we buy" go to plan_replenishment, not predict_inventory_reorders (which ranks every item). Lead with \
its headline — when it runs out against the supplier's lead time, and the action — then weekly demand, lead time and \
the recommended order, then the supplier, value, budget left and who it is routed to. Draft the order with \
create_purchase_order_draft only when the person asks, passing the proposal's args, and say it is a draft awaiting \
that approver.

THE WAREHOUSE, BAY BY BAY. "Show me the warehouse", "which bays are short", "what is in bay X", "what does Rotterdam \
hold", "which order does that shortage put at risk" go to read_warehouse_twin. Lead with the short bays — code, location, \
cover in days — and the orders they put at risk, then low cover. A fix for a late order is a manager's approval on the \
order (plan_delivery_recovery); offer it, never imply it is done.

WHAT MATTERS NOW. "What needs my attention today", "what should I look at", "anything I should know", "what is \
going on", "morning brief", "what matters right now" go to what_matters_now — it runs every watcher as the person and ranks \
what needs someone. Lead with its headline, then one line per item: what, the cause, the money at stake, and the next step \
with who approves it. End with one line on what was checked and clear. Go deeper with the tool an item names only when the \
person picks it, and draft or hold only when they ask. "What did you notice", "anything new", "what changed since \
yesterday", "what happened while I was away", "did anything get worse", "are you watching" go to what_simeli_noticed — \
the watch that runs the brief for the person on its own and remembers what it showed them. Lead with what is new and what \
got worse (when it was noticed, cause, money at stake, next step and who approves), then what cleared.

THE WHOLE BUSINESS, CONNECTED. "Show me the business", "show me the brain", "how does everything connect", "give me \
the whole picture", "what depends on what", "where is the problem coming from", "walk me through what is going wrong" go to \
map_the_business. Lead with its headline; if it has a trace, walk it one line per step — the part of the business, what \
happened, the record — ending at the customer order; then one line per part on alert or watch with its signal; then the \
next step and who approves. A question about one part goes to the tool that part names.

WHAT THE COMPANY BUILT IS PART OF THE BUSINESS. Applications deployed from Sandbox are read by the brief and by supplier \
risk like any module. "What do our own apps say", "anything open in supplier quality", "does what we built affect any \
orders", "which suppliers have open findings", "how does <application> connect to the business" go to \
what_built_apps_flag. Lead with what is open and why it needs someone, then what it reaches — the supplier, the customer \
orders and their value — and where to open it. A person moves the record's workflow in its application; you do not.

DECISIONS WAITING ON A PERSON. "What is waiting on me", "what should I approve first", "what are my approvals holding \
up", "what is PO-0042 blocking", "how much is stuck in approvals" go to explain_pending_decisions. Lead with the decision \
that holds the most: what it is worth, which customer order depends on it and when that is due, and whether approving \
it is enough to keep the date. Then the rest, briefly. You do not approve: say where the person decides it.

PEOPLE. "Who are we waiting on", "who is away next week and what does it hold up", "what if Anna is off from \
Thursday", "can I approve this leave", "who is a single point of failure", "who covers while Mark is away" go to \
explain_people_coverage. Lead with its headline, then each decision at risk: its number, the day it must be decided by \
and the customer order it holds. Never say why someone is away. Offer its proposals; carry one out with \
act_on_people_coverage only when asked, and say that a manager confirms it.

SOMETHING THE BUSINESS DOES NOT HAVE YET. "Create a supplier risk monitor", "build us something to track complaints", \
"we need an app for inspections", "can EMBMIS do X" when no module or installed application does it, go to \
build_in_sandbox with the person's own words (check list_applications first when one might already exist). For an \
administrator, lead with what was designed and what existing records and live measures it is wired into, then its \
records and workflow, then the rehearsal verdict and the deployment plan by safety class, and link its open path as \
[Open in Studio](<open>). Say plainly it is a draft: nothing is deployed until an administrator approves it in the \
Studio. For anyone else, say the request went to the administrators it names. Never say it is live.

AGENTS EARN AUTHORITY. "Which agents have earned more authority", "can the procurement agent act on its own", \
"should we raise its limit", "how often do people overrule the agents", "can I trust the agents" go to \
explain_agent_track_record. Lead with its headline, then each agent that earned or should lose authority: how many of \
its decided items people accepted as proposed, changed or rejected, and the rejected examples. Offer its proposals; \
carry one out with grant_earned_authority only when asked, and say that a manager confirms it and that it does not \
switch an agent on.

EMBMIS GATEWAY. Every tool you call is checked by EMBMIS Gateway before it runs. When a tool result says \
"Blocked by EMBMIS Gateway: <reason>", the action did NOT happen and will not: tell the person exactly that, with \
the reason, and do not retry it, rephrase it, or reach the same outcome through another tool. When a call is sent \
to the person for approval, it waits for them; say what you are asking and why, and do not describe it as done.

WHAT YOU CAN AND CANNOT DO TO RECORDS. Your write tools create DRAFTS and schedule follow-ups. You cannot approve, \
post, send, pay, delete or finalise anything, and you should say so plainly rather than implying otherwise: "I've \
drafted an invoice that needs your approval" is true, "I've created the invoice" is not. Every write result carries \
a next_step — relay it.

HOW YOUR ANSWERS ARE DISPLAYED. Everything you call and everything it returns is already shown to the reader \
under one dropdown they can open — you never have to repeat data just to make it available, and you should not. \
The body of your answer is prose, any chart you drew, anything you promoted with show_data, and any approval you \
need. Treat it like a memo: lead with the answer, and leave the working in the appendix. If your sentence already \
contains the number, that is usually enough on its own.

• render_chart draws a chart you design yourself, rather than picking a preset. You write the layers (an area \
under a line, bars beside it, a dashed segment for projected months), the reference lines, the shaded ranges and \
the annotations; you do NOT write the data. Give it a 'source' — a question it turns into read-only SQL, or \
'{ from_tool: "get_ar_aging" }' to chart rows a tool already returned this turn — and the rows are fetched for you. \
A fixed reference line needs a 'note' saying where the number came from; prefer '{ agg: "avg", field: "..." }', which \
is computed from the real rows. If the result comes back with 'warnings', fix the specification and call it again \
before you answer: the user sees the chart you leave behind, not the one you meant.
• show_data puts specific rows or figures from a tool result into the answer itself, for when those rows ARE the \
answer and the reader should not have to open anything to see them. It takes a reference to a tool that ran, not \
values. Use it sparingly.
• generate_chart is the older, narrower path: it only produces a plain line, bar or pie. Prefer render_chart. Use \
this one only for a quick single-series plot from a business question — e.g. "monthly revenue \
trend" or "top 5 customers by sales". Use query_erp_data first to get the data, then suggest_visualization \
to pick the best chart type and axes from the columns and a few sample rows. The chat UI renders the \
chart inline automatically from the returned specification — no need to describe the shape of the data \
in prose unless the user also asks for the numbers.
When you build something, describe what it will do in plain language and name the trigger and the \
schedule, so the user is agreeing to a behaviour rather than to a name.`;

/**
 * True if a tool result looks like documentResult() from services/ai/pdfTools.js
 * or services/ai/artifactTools.js — any stored artifact, not just a PDF.
 * `content_type` (pdf | html | svg | markdown | code, default 'pdf' for older
 * PDF-only tools that never set it) is what lets the chat UI decide whether to
 * offer a live inline preview or just a download.
 */
function documentSummary(result) {
  if (!result || typeof result !== 'object' || !result.download_url) return undefined;
  return {
    document_id: result.document_id,
    title: result.title,
    file_name: result.file_name,
    download_url: result.download_url,
    content_type: result.content_type || 'pdf',
    language: result.language,
  };
}

/**
 * The chart specification a tool returned, if it returned one.
 *
 * generate_chart (services/ai/chartGenerator.js) returns a spec the client
 * renders directly. Unlike every other tool result this is not data to be
 * summarised — it IS the rendered object — so it rides the event whole while
 * everything else is reduced to a digest.
 */
function chartSpec(result) {
  if (!result || typeof result !== 'object') return undefined;
  const spec = result.chart_spec || result.chart || (result.chart_type && result.data ? result : null);
  if (!spec || !Array.isArray(spec.data)) return undefined;
  return spec;
}

/**
 * Whether a tool result carries warnings the model should act on before it
 * answers. render_chart returns these when a layer referenced a column that
 * does not exist: the model can redraw on the next step, and a chart with a
 * silently missing series is exactly what that prevents.
 */
function surfaced(result) {
  if (!result || typeof result !== 'object') return undefined;
  return result.surfaced || undefined;
}

/**
 * Whether a tool result carries warnings the model should act on before it
 * answers.
 */
function resultWarnings(result) {
  if (!result || typeof result !== 'object') return undefined;
  return Array.isArray(result.warnings) && result.warnings.length ? result.warnings : undefined;
}

// ---------------------------------------------------------------------------
// Paused-session store — persisted (migration 139).
//
// This was a process-local Map. A deploy, a crash, or an idle restart silently
// discarded every run waiting on a human, so the person clicking "Approve" on
// a prompt still visible on their screen got "No pending confirmation found".
// It also could not work behind more than one instance, because the resume is
// a separate HTTP request that any load balancer will eventually route to a
// process that never saw the pause.
//
// That made the confirmation step — the thing standing between the model and a
// write — the least reliable part of the system, which is exactly backwards.
// ---------------------------------------------------------------------------
const { pool } = require('../../config/database');

async function savePause(pauseId, state) {
  await pool.query(
    `INSERT INTO agent_paused_runs (id, user_id, state, pending_tools, expires_at)
     VALUES ($1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP + ($5 || ' milliseconds')::interval)`,
    [
      pauseId,
      String(state.ctx?.userId || 'unknown'),
      JSON.stringify({
        messages: state.messages,
        step: state.step,
        mode: state.mode,
        // ctx.signal is an AbortSignal, and JSON.stringify turns one into {}.
        // On resume the OpenAI SDK would receive { signal: {} }, call
        // signal.addEventListener and throw — every approval then died with
        // "Connection error." The resumed run gets a fresh signal from the
        // resuming request instead (see resumeAgent).
        ctx: state.ctx ? { ...state.ctx, signal: undefined } : state.ctx,
        toolsUsed: state.toolsUsed,
        pendingConfirm: state.pendingConfirm,
        gatewayStats: state.gatewayStats,
      }),
      (state.pendingConfirm || []).map((p) => p.name),
      String(PAUSE_TTL_MS),
    ]
  );
}

/**
 * Load and CLAIM a paused run, atomically.
 *
 * The DELETE ... RETURNING is what makes this safe: a run can only be resumed
 * once, even if two requests arrive together. Reading then deleting would let
 * both read the same pending tool calls and both execute them — a
 * double-clicked "Approve" turning into two purchase requisitions.
 *
 * `userId` is checked here rather than by the caller so there is no path that
 * resumes someone else's confirmation. The decision being recorded is "may
 * this tool run", which has to be attributable to whoever actually made it.
 */
async function loadPause(pauseId, userId) {
  const { rows } = await pool.query(
    `DELETE FROM agent_paused_runs
      WHERE id = $1
        AND expires_at > CURRENT_TIMESTAMP
        AND ($2::text IS NULL OR user_id = $2)
      RETURNING state`,
    [pauseId, userId != null ? String(userId) : null]
  );
  if (!rows.length) return null;

  // Opportunistic sweep. These rows are small and few, and a dedicated job for
  // them would be more moving parts than the problem deserves.
  pool.query('DELETE FROM agent_paused_runs WHERE expires_at <= CURRENT_TIMESTAMP')
    .catch(() => {});

  return rows[0].state;
}

/** Confirmations this user is currently being asked for. */
async function listPending(userId) {
  const { rows } = await pool.query(
    `SELECT id, pending_tools, created_at, expires_at
       FROM agent_paused_runs
      WHERE user_id = $1 AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC`,
    [String(userId)]
  );
  return rows;
}

async function needsConfirmation(toolName, mode) {
  if (mode === 'manual') return true; // everything pauses; no need to resolve

  // Two different "no tool" answers, which used to be one.
  //
  // A lookup that FAILED — the registry could not be read — is a safety
  // question, and the safe answer is to ask. A lookup that succeeded and found
  // NOTHING is not: the name does not exist, so approving it cannot do
  // anything except produce "Unknown tool". Pausing there spends a person's
  // decision on a hallucinated name and stalls the investigation, when the
  // useful move is to dispatch it, let it fail immediately, and give the model
  // the next step to choose a tool that is real.
  let tool;
  try {
    tool = await catalog.resolve(toolName);
  } catch {
    return true;
  }
  if (!tool) return false;

  // A tool that keeps running after this turn ends (propose_background_task)
  // asks every time, in every mode, with no "always allow" — unlike an MCP
  // tool's auto_approve, there is no stable "this exact call is fine to skip
  // reviewing" here, because what it will go on to do is exactly what's being
  // decided by proposing it in the first place.
  if (tool.alwaysConfirm) return true;

  // A tool from outside this ERP — a connected MCP server or app — asks the
  // first time, whatever the autonomy mode. The mode dial reflects trust in
  // tools that were reviewed as code; a third-party tool was not, and can
  // change what it does between one call and the next.
  //
  // But asking EVERY time is a different thing from asking once. Repeating an
  // identical prompt does not add a decision, it just costs a turn and teaches
  // people to click through without reading. So the answer is remembered: once
  // someone chooses "Always allow" for a specific tool, it stops asking, and
  // the grant is revocable from the tool library.
  if (tool.mcp) {
    const settingsMap = await settings.getToolSettings().catch(() => null);
    return !settingsMap?.get(toolName)?.auto_approve;
  }

  if (mode === 'auto' || mode === 'bypass') return false;

  // accept_edits (or any unrecognized mode, fail-safe toward confirming): a
  // high-impact built-in tool asks — unless this exact tool was already
  // granted "Always allow". resumeAgent's "always" branch calls
  // settings.setAutoApprove(call.name, ...) for whichever tool was just
  // approved, built-in or MCP, so the read side has to honour it here too.
  // This used to fall straight to `!!tool.highImpact` with no lookup at
  // all, so the grant was recorded and then silently ignored — a 30-row
  // import asked 30 times because every row's write_database call kept
  // coming back highImpact regardless of the earlier "Always allow" click.
  if (!tool.highImpact) return false;
  const settingsMap = await settings.getToolSettings().catch(() => null);
  return !settingsMap?.get(toolName)?.auto_approve;
}


// ---------------------------------------------------------------------------
// EMBMIS Gateway — checked before every tool call.
//
//   deny      the tool does not run; the model is told "Blocked by EMBMIS Gateway: reason"
//   escalate  the call goes to the existing approval pause, in EVERY mode (even `auto`)
//   allow     continue with the normal confirmation rules
//
// With no EMBMIS_GATEWAY_URL this is a no-op and nothing above changes. See
// services/gateway/client.js for the unreachable-gateway behaviour (reads
// continue, writes wait for a person or run, per EMBMIS_GATEWAY_FAIL_MODE).
// ---------------------------------------------------------------------------
function newGatewayStats() {
  return { allowed: 0, blocked: 0, escalated: 0, unchecked: 0 };
}

async function gatewayGate(name, args, ctx, stats, onEvent, step) {
  const gateway = require('../gateway/client');
  if (!gateway.isEnabled()) return { status: 'off' };

  let tool = null;
  try { tool = await catalog.resolve(name); } catch { /* handled below */ }
  // An unknown tool name cannot do anything: executeTool will refuse it. There is nothing to check.
  if (!tool) return { status: 'off' };

  const verdict = await gateway.check({
    companyId: ctx.companyId, userId: ctx.userId, source: 'simeli',
    tool: name, args, readOnly: !!tool.readOnly,
  });

  if (verdict.origin === 'fallback') stats.unchecked += 1;
  if (verdict.decision === 'deny') stats.blocked += 1;
  else if (verdict.decision === 'escalate') stats.escalated += 1;
  else stats.allowed += 1;

  onEvent?.({
    type: 'gateway', name, step,
    decision: verdict.decision, code: verdict.code, reason: verdict.reason,
    traceId: verdict.traceId, origin: verdict.origin, riskScore: verdict.riskScore,
  });
  return { status: verdict.decision, verdict };
}

function gatewayNote(verdict) {
  return {
    decision: verdict.decision, code: verdict.code, reason: verdict.reason,
    traceId: verdict.traceId, origin: verdict.origin, riskScore: verdict.riskScore,
  };
}

// ---------------------------------------------------------------------------
// Streaming model call: emits content token-by-token via onDelta, silently
// accumulates tool_calls (partial JSON args aren't useful to show mid-stream)
// and returns the fully assembled { content, toolCalls, model, usage } once
// the stream ends. `model` and `usage` (token counts for this one call) let
// the caller log real, per-call AI cost without a second resolveModel() call.
//
// Branches on AI_PROVIDER so a single agent.js serves both OpenAI-compatible
// and Anthropic backends. The returned shape is provider-agnostic; callers
// never see the underlying SDK.
// ---------------------------------------------------------------------------
async function callModelStreaming(messages, onDelta, ctx = {}) {
  const client = getAIClient();
  const provider = getAIProvider();
  const [model, tools] = await Promise.all([
    settings.resolveModel(),
    catalog.getOpenAITools({ role: ctx.role, companyId: ctx.companyId }),
  ]);

  if (provider === 'anthropic') {
    return callAnthropicStreaming(client, model, messages, tools, onDelta, ctx.signal);
  }
  return callOpenAIStreaming(client, model, messages, tools, onDelta, ctx.signal);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible streaming (existing behaviour, extracted for clarity).
// ---------------------------------------------------------------------------
async function callOpenAIStreaming(client, model, messages, tools, onDelta, signal) {
  const modelRouter = require('./modelRouter');
  // withFallback tries `model` (the admin's configured/resolved default)
  // first and, on OpenRouter, falls through the ranked free-model catalog if
  // it's rate-limited, out of quota, or gone — see modelRouter.js. On any
  // other provider this is a single attempt, identical to calling the SDK
  // directly. The signal reaches the SDK either way, so aborting closes the
  // upstream HTTP request rather than leaving it to run to completion while
  // nobody reads it.
  const { model: usedModel, value: stream } = await modelRouter.withFallback('text', (candidateModel, clientOverride) =>
    (clientOverride || client).chat.completions.create({
      model: candidateModel,
      messages,
      tools,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    }, signal ? { signal } : undefined),
  model);
  model = usedModel;

  let content = '';
  const toolCallsAcc = [];
  const messageExtra = {};
  let usage = null;

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', function: { name: '', arguments: '' } };
        for (const key of Object.keys(tc)) {
          if (key === 'index' || key === 'function' || key === 'type') continue;
          if (key === 'id') { if (tc.id) toolCallsAcc[idx].id += tc.id; continue; }
          toolCallsAcc[idx][key] = tc[key];
        }
        if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
      }
    }
    for (const key of Object.keys(delta)) {
      if (key === 'content' || key === 'tool_calls' || key === 'role') continue;
      messageExtra[key] = delta[key];
    }
  }

  const toolCalls = toolCallsAcc.filter(Boolean).map((tc, i) => ({
    ...tc,
    id: tc.id || `call_${Date.now().toString(36)}_${i}`,
    type: 'function',
  }));
  return { content, toolCalls, messageExtra, model, usage };
}

// ---------------------------------------------------------------------------
// Anthropic streaming via the Messages API. Uses the adapter to convert
// OpenAI-format messages/tools into Anthropic format, then streams results
// and normalises them into the same { content, toolCalls, usage } shape the
// OpenAI path returns. Callers are provider-agnostic.
// ---------------------------------------------------------------------------
async function callAnthropicStreaming(client, model, messages, openaiTools, onDelta, signal) {
  const {
    extractSystemPrompt,
    messagesToAnthropic,
    toAnthropicTools,
    streamAnthropic,
  } = require('./anthropicAdapter');

  const systemPrompt = extractSystemPrompt(messages);
  const anthropicMessages = messagesToAnthropic(messages);
  const anthropicTools = toAnthropicTools(openaiTools);

  return streamAnthropic(
    client, model, systemPrompt, anthropicMessages, anthropicTools,
    4096, onDelta, signal,
  );
}

// ---------------------------------------------------------------------------
// Core resumable loop. `state` = { messages, step, toolsUsed, ctx, mode, [pauseId] }
// `onEvent` (optional) receives live progress events for streaming callers:
//   {type:'delta', content, step} | {type:'step_end', step, final, tool_count} |
//   {type:'tool_call', name, args, step} | {type:'tool_result', name, ok, error, step} |
//   {type:'tool_denied', name, args, step} | {type:'awaiting_confirmation', pauseId, pending}
//
// `step` on every event, plus `step_end`, is what lets a caller separate
// reasoning from the final answer without waiting for the whole turn: content
// streams live as soon as it arrives (there's no way to know in advance
// whether a step will end up calling a tool), and step_end.final — sent the
// moment that becomes known — says whether the text just streamed for that
// step was the visible answer (final: true) or reasoning ahead of a tool call
// (final: false), so a chat UI can fold the latter into a collapsed trace
// instead of leaving it in the answer bubble.
// ---------------------------------------------------------------------------
async function runLoop(state, onEvent) {
  const { ctx, mode } = state;
  let { messages, step, toolsUsed } = state;
  const gatewayStats = state.gatewayStats || newGatewayStats();

  // What each tool returned this turn, by name.
  //
  // render_chart takes { from_tool: 'get_ar_aging' } instead of the model
  // retyping the rows into the chart specification — which is the difference
  // between charting the ledger and charting the model's memory of it. Kept in
  // the loop rather than on ctx permanently: it is one turn's working set, and
  // a paused run that resumes in another process starts a fresh one rather than
  // charting stale rows.
  const toolResults = state.toolResults || {};

  const maxSteps = (await settings.getSettings()).max_steps || MAX_STEPS;

  /**
   * Has the person walked away?
   *
   * Aborting the fetch on the client used to close the connection and nothing
   * else: this loop carried on calling the model and running tools for a turn
   * nobody would ever read, and the tokens were billed anyway. Checked at the
   * top of every step and before every tool, which are the two places real
   * money is about to be spent.
   */
  const cancelled = () => !!ctx.signal?.aborted;

  for (; step < maxSteps; step++) {
    if (cancelled()) {
      return { status: 'cancelled', response: null, tools_used: toolsUsed, steps: step, gateway: gatewayStats };
    }
    const { content, toolCalls, messageExtra, model, usage } = await callModelStreaming(messages, (chunk) => onEvent?.({ type: 'delta', content: chunk, step }), ctx);

    // Every step is a real model call and therefore real cost, whether or not
    // it goes on to call a tool — log it here so no step is missed.
    if (usage) {
      require('./usageTracking').logUsage({
        userId: ctx.userId,
        // Without this every row was written with company_id NULL, which is
        // both rejected by the column (NOT NULL) and invisible to
        // getUsageSummary({ companyId }) — the reason AI usage read as zero.
        companyId: ctx.companyId,
        actor: ctx.actor || 'ai-agent',
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      });
    }

    if (!toolCalls.length) {
      onEvent?.({ type: 'step_end', step, final: true, tool_count: 0 });
      return { status: 'done', response: content, tools_used: toolsUsed, steps: step + 1, gateway: gatewayStats };
    }
    onEvent?.({ type: 'step_end', step, final: false, tool_count: toolCalls.length });

    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls, ...messageExtra });

    const pendingConfirm = [];
    for (const call of toolCalls) {
      const name = call.function.name;
      const args = safeJsonParse(call.function.arguments, {});

      // EMBMIS Gateway first. Its verdict can only make the next steps stricter.
      const gate = await gatewayGate(name, args, ctx, gatewayStats, onEvent, step);
      if (gate.status === 'deny') {
        const reason = gate.verdict.reason || 'this action is not allowed';
        onEvent?.({ type: 'tool_blocked', name, args, step, meta: narration.meta(name), reason, code: gate.verdict.code, traceId: gate.verdict.traceId });
        messages.push({
          role: 'tool', tool_call_id: call.id,
          content: JSON.stringify({ ok: false, blocked_by: 'EMBMIS Gateway', error: `Blocked by EMBMIS Gateway: ${reason}` }),
        });
        continue;
      }
      if (gate.status === 'escalate') {
        // Every mode — manual, accept_edits, auto and bypass — pauses here.
        pendingConfirm.push({ id: call.id, name, args, meta: narration.meta(name), gateway: gatewayNote(gate.verdict) });
        continue;
      }

      if (await needsConfirmation(name, mode)) {
        pendingConfirm.push({ id: call.id, name, args, meta: narration.meta(name) });
        continue;
      }

      // A tool that has not started yet must not start now. One already in
      // flight is left to finish — killing it halfway is how a write ends up
      // half-applied, and none of these are worth that risk.
      if (cancelled()) {
        return { status: 'cancelled', response: null, tools_used: toolsUsed, steps: step, gateway: gatewayStats };
      }

      toolsUsed.push({ name, args });
      onEvent?.({ type: 'tool_call', name, args, step, meta: narration.meta(name) });
      let resultPayload;
      try {
        const result = await catalog.executeTool(name, args, {
          userId: ctx.userId, actor: ctx.actor || 'ai-agent', role: ctx.role, companyId: ctx.companyId,
          // read_attachment resolves against the conversation it was called in.
          // Dropping this made every attachment tool see an empty store — the
          // model reported "the file is not available" for files that were
          // sitting right there in memory. See services/ai/attachments.js.
          sessionId: ctx.sessionId,
          toolResults,
        });
        resultPayload = { ok: true, result };
        toolResults[name] = result;
      } catch (err) {
        resultPayload = { ok: false, error: err.message };
      }
      onEvent?.({
        type: 'tool_result', name, ok: resultPayload.ok, error: resultPayload.error, step,
        document: resultPayload.ok ? documentSummary(resultPayload.result) : undefined,
        // Counted from the tool's own return value, never estimated. See
        // services/ai/agentNarration.js for why this is derived rather than
        // asked of the model.
        digest: resultPayload.ok ? narration.digest(name, resultPayload.result) : undefined,
        // Charts are the one payload the UI needs in full: generate_chart
        // returns a spec that is the rendered object itself, not a summary of
        // one, so a digest of it would be useless.
        chart: resultPayload.ok ? chartSpec(resultPayload.result) : undefined,
        surfaced: resultPayload.ok ? surfaced(resultPayload.result) : undefined,
        warnings: resultPayload.ok ? resultWarnings(resultPayload.result) : undefined,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resultPayload).slice(0, 8000) });
    }

    if (pendingConfirm.length) {
      const pauseId = randomUUID();
      // Awaited: the client is told to expect a resume at this id, so the row
      // must exist before that promise is made. Emitting the event first and
      // persisting after leaves a window where an immediate approval finds
      // nothing — rare, and therefore reported as "it sometimes forgets".
      await savePause(pauseId, { messages, step, mode, ctx, toolsUsed, pendingConfirm, gatewayStats });
      onEvent?.({ type: 'awaiting_confirmation', pauseId, pending: pendingConfirm, gateway: gatewayStats });
      return { status: 'awaiting_confirmation', pauseId, pending: pendingConfirm, tools_used: toolsUsed, steps: step + 1, gateway: gatewayStats };
    }
  }

  // Hitting the ceiling is a pause, not a failure.
  //
  // This used to end the turn with an apology and a pointer to the settings
  // page, which threw away the state and made the person start again. The run
  // is saved instead, exactly the way a run waiting on an approval is saved, so
  // the client can offer "keep going" and the agent picks up mid-investigation
  // with everything it had already found.
  //
  // That is also the honest answer to "make it unlimited": you get unbounded
  // work, with a person deciding each extension, rather than a loop nobody is
  // watching spending money until something breaks.
  const continueId = randomUUID();
  await savePause(continueId, { messages, step: 0, mode, ctx, toolsUsed, pendingConfirm: [], gatewayStats })
    .catch((err) => console.error('Could not save a continuable run:', err.message));

  onEvent?.({ type: 'step_limit', continueId, steps: maxSteps, tools_used: toolsUsed.length });

  return {
    status: 'done',
    response:
      `I've used this turn's ${maxSteps} tool steps and stopped there rather than keep going on my own. `
      + `${toolsUsed.length ? `I ran ${toolsUsed.length} tool${toolsUsed.length === 1 ? '' : 's'} and nothing is lost — ` : ''}`
      + 'tell me to keep going and I will carry on from where I am.',
    tools_used: toolsUsed,
    steps: maxSteps,
    truncated: true,
    continueId,
    gateway: gatewayStats,
  };
}

/**
 * Assemble the system prompt for one turn: the base instructions, the
 * operator's style setting, whatever this company has taught the assistant
 * by correcting it, and — when `userMessage` is given — retrieved context
 * from this company's own documents (RAG; see services/ai/ragRetrieval.js).
 *
 * `userMessage` is optional and only passed by runAgent() for the first model
 * call of a turn: resumeAgent() and the per-step loop inside runLoop() never
 * rebuild the system prompt at all (it is already sitting in `messages`), so
 * there is no separate "only do this once" branch to get wrong here — a
 * retrieval call simply never happens more than once per user message.
 *
 * Exported so a test can assert the learned-preference fragment actually
 * reaches the model. That matters more than it looks: recordOverride() stored
 * corrections for a long time while nothing injected them here, so the feature
 * appeared to work — rows were written, an endpoint returned them — and changed
 * nothing about a single answer. A test that only checks the service layer
 * cannot catch that regression; one that checks this function can.
 *
 * A failure to load preferences or RAG context must never fail the turn:
 * answering without them is a slightly worse answer, refusing to answer is a
 * broken assistant.
 *
 * @param {{companyId?: string}} ctx
 * @param {string} [userMessage]
 * @returns {Promise<string>}
 */
async function buildSystemPrompt(ctx = {}, userMessage = '') {
  const [style, learned, ragContext, grounding] = await Promise.all([
    settings.styleInstruction().catch(() => ''),
    require('./preferenceLearningService')
      .buildPromptFragment(ctx.companyId)
      .catch((err) => {
        console.error('Could not load learned preferences:', err.message);
        return '';
      }),
    userMessage
      ? require('./ragRetrieval')
        .retrieveContext(userMessage, { limit: 5, threshold: 0.65 })
        .catch((err) => {
          console.error('Could not retrieve RAG context:', err.message);
          return [];
        })
      : Promise.resolve([]),
    // Currency, date and open period. Without this the agent invented a
    // currency symbol — it answered "$0" on a ledger it had never been told
    // was in dollars. See services/ai/groundingTools.js.
    require('./groundingTools')
      .companyContext(ctx.companyId)
      .catch((err) => {
        console.error('Could not load company context:', err.message);
        return { today: new Date().toISOString().slice(0, 10) };
      }),
  ]);

  const groundingBlock = require('./groundingTools').contextPrompt(grounding);

  const ragBlock = ragContext.length
    ? `\n\n## Company Knowledge Base\nThe following is retrieved from this company's documents and policies. Use it to answer questions about company-specific procedures, policies, and decisions:\n\n${ragContext
      .map((r) => `[${r.document_title}]\n${r.chunk_text}`)
      .join('\n\n---\n\n')}`
    : '';

  // Grounding goes FIRST, ahead of the standing instructions. It is the only
  // part of the prompt that changes per company and per day, and a fact buried
  // under two pages of rules is a fact the model stops applying.
  return [groundingBlock, SYSTEM_PROMPT, style, learned].filter(Boolean).join('\n\n') + ragBlock;
}

/**
 * Run the agent loop for a single user message.
 * @param {string} message
 * @param {{userId: string, actor?: string}} ctx
 * @param {Array<{role,content}>} [history] prior turns (optional, small)
 * @param {string} [mode] one of MODES; defaults to 'accept_edits'
 * @param {(event: object) => void} [onEvent] optional streaming callback
 */
async function runAgent(message, ctx, history = [], mode = DEFAULT_MODE, onEvent, toolResults) {
  let safeMode = MODES.includes(mode) ? mode : DEFAULT_MODE;
  // An operator can cap how much autonomy a given role may hand the assistant.
  // Clamping (rather than refusing) keeps the request working at the highest
  // mode that role is allowed, instead of failing the whole turn.
  safeMode = await settings.clampAgentMode(safeMode, ctx.role);

  // Spend-cap gate: check before making any model call so a single turn
  // cannot blow past the monthly budget.
  const { checkSpendCap } = require('./usageTracking');
  const budget = await checkSpendCap({
    userId: ctx.userId,
    companyId: ctx.companyId,
    model: await settings.resolveModel(),
  });
  if (!budget.allowed) {
    return { status: 'done', response: budget.reason, tools_used: [], steps: 0 };
  }

  const messages = [
    { role: 'system', content: await buildSystemPrompt(ctx, message) },
    ...history,
    { role: 'user', content: message },
  ];
  return runLoop({ messages, step: 0, toolsUsed: [], ctx, mode: safeMode, toolResults }, onEvent);
}

/**
 * Resume a paused (awaiting_confirmation) agent run.
 * @param {string} pauseId
 * @param {Array<{tool_call_id: string, approve: boolean, always?: boolean}>} decisions
 *   `always` records the grant so this tool stops asking in future turns.
 * @param {(event: object) => void} [onEvent]
 */
async function resumeAgent(pauseId, decisions, onEvent, userId = null, signal = undefined) {
  // Loading claims the row, so this both fetches the state and guarantees the
  // run cannot be resumed twice.
  const state = await loadPause(pauseId, userId);
  if (!state) {
    throw new Error(
      'No pending confirmation found for this session. It may have expired (they last 10 minutes), '
      + 'already been answered, or belong to someone else.'
    );
  }

  // The stored ctx went through JSON; the original AbortSignal did not
  // survive (and was deliberately stripped at save). Restore a real one from
  // the resuming request, or leave it undefined — the model-call path
  // tolerates undefined but NOT a serialized {}.
  if (state.ctx) state.ctx.signal = signal;

  const { messages, pendingConfirm, ctx, mode, toolsUsed, step } = state;
  const decisionList = Array.isArray(decisions) ? decisions : [];

  for (const call of pendingConfirm) {
    const decision = decisionList.find((d) => d.tool_call_id === call.id);
    const approve = !!decision?.approve;
    let resultPayload;

    // "Always allow" is recorded before the call runs, so a tool the person
    // just trusted does not ask again later in this same turn.
    if (approve && decision?.always) {
      await settings.setAutoApprove(call.name, true, ctx.userId).catch((err) => {
        console.error(`Could not remember approval for ${call.name}:`, err.message);
      });
    }

    // A call EMBMIS Gateway sent to the person: tell it what the person decided, so the audit chain
    // shows who approved or rejected it. Never blocks or fails the resume.
    if (call.gateway?.traceId) {
      await require('../gateway/client').resolve({
        companyId: ctx.companyId, traceId: call.gateway.traceId,
        outcome: approve ? 'approved' : 'rejected', by: ctx.userId ? `user:${ctx.userId}` : 'unknown',
        reason: approve ? 'Approved in Simeli' : 'Rejected in Simeli',
      }).catch((err) => console.error('[gateway] could not report the answer:', err.message));
    }

    if (!approve) {
      resultPayload = { ok: false, error: 'The user denied this action.' };
      onEvent?.({ type: 'tool_denied', name: call.name, args: call.args, step, meta: narration.meta(call.name) });
    } else {
      toolsUsed.push({ name: call.name, args: call.args });
      onEvent?.({ type: 'tool_call', name: call.name, args: call.args, step, meta: narration.meta(call.name), approved: true });
      try {
        const result = await catalog.executeTool(call.name, call.args, {
          userId: ctx.userId, actor: ctx.actor || 'ai-agent', role: ctx.role, companyId: ctx.companyId,
          sessionId: ctx.sessionId,
          toolResults: state.toolResults || {},
        });
        resultPayload = { ok: true, result };
      } catch (err) {
        resultPayload = { ok: false, error: err.message };
      }
      onEvent?.({
        type: 'tool_result', name: call.name, ok: resultPayload.ok, error: resultPayload.error, step,
        document: resultPayload.ok ? documentSummary(resultPayload.result) : undefined,
        digest: resultPayload.ok ? narration.digest(call.name, resultPayload.result) : undefined,
        chart: resultPayload.ok ? chartSpec(resultPayload.result) : undefined,
        surfaced: resultPayload.ok ? surfaced(resultPayload.result) : undefined,
        warnings: resultPayload.ok ? resultWarnings(resultPayload.result) : undefined,
        approved: true,
      });
    }

    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resultPayload).slice(0, 8000) });
  }

  // Resume at the SAME step it paused on. Waiting for a person is not a step:
  // the model produced one set of tool calls, and those calls have now run,
  // which is exactly what an uninterrupted turn would have done in one step.
  // Counting the pause as well made every confirmation cost a step, so a
  // conversation using outside tools ran out of budget roughly twice as fast
  // as the same conversation without them.
  return runLoop({ messages, step, toolsUsed, ctx, mode, toolResults: state.toolResults, gatewayStats: state.gatewayStats }, onEvent);
}

module.exports = {
  runAgent, resumeAgent, listPending, buildSystemPrompt, needsConfirmation, MAX_STEPS, MODES, DEFAULT_MODE,
};
