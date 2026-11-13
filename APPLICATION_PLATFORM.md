# The EMBMIS Application Platform

EMBMIS can create the applications a company needs.

Not screens over the ERP's tables — applications: their own relational data
model, their own screens, their own workflow with its approvals, their own
permissions, their own portals for the suppliers and customers outside the
company, and their own place in the navigation. Described in a sentence,
designed by the platform, reviewed by a person, compiled deterministically, and
deployed as real Postgres tables that belong to one company.

Nothing in this document is aspirational. `npm run test:platform` in `backend/`
runs 194 tests over it, including the whole loop end to end against a real
database with row-level security enforced.

---

## The one architectural decision everything follows from

**An application is global. Its data is not.**

```
applications                 the design. One row. No company_id.
  └── application_versions   immutable snapshots of that design
        │
app_company_instances        "company X has an instance of application Y"
  └── app_instance_tables    logical entity -> physical table. AUTHORITATIVE.
        └── app_7fa2c81d_9b3e04d1_quality_findings   ACME's findings
        └── app_7fa2c81d_c4419a02_quality_findings   Northwind's findings
```

The first pass at generated applications did the obvious thing: a company-scoped
`apps` row whose entities pointed at ordinary shared tables, one
`supplier_shipments` for everybody, separated by a `company_id` column. That is
the right shape for a table the product *ships with*. It is the wrong shape for
a table the product *invents*, for three reasons:

1. **Different owners, different lifetimes.** "Supplier Quality Management" is a
   design; any number of companies should be able to install it. The findings
   ACME records under it are ACME's alone.
2. **One schema for everyone.** The second company that needs one more column
   has nowhere to put it that does not change the first company's table.
3. **Isolation resting on memory.** A shared table is safe exactly as long as
   nobody ever forgets a `WHERE`.

So: one design, one instance per company, one set of physical tables per
instance. Each generated table carries `company_id` with the same
`company_isolation` policy every other company-scoped table in EMBMIS has —
applied in the same transaction that created it — plus a `CHECK` pinning it to
the one instance that owns it, so a bug in the registry produces a constraint
violation rather than a silent cross-application write.

**The runtime never accepts a table name.** It accepts an application key and a
logical entity key, and resolves the rest through `app_instance_tables`. There
is no function anywhere that takes a physical table name from a caller.

---

## What the AI produces, and what it cannot

The model produces a **declarative specification** and nothing else. No SQL, no
JavaScript, no migration text, no table names.

The vocabulary is closed — 20 field types, ~25 UI component types, 6 automation
actions, 8 aggregations, 6 transition requirements — and every consumer fails
closed on a miss. There is no default branch that falls back to `text`, and no
emitter for an operation nobody reviewed. A specification cannot ask for
`type: "raw_sql"` because the compiler's only way to turn a field into DDL is a
lookup that would find nothing.

Conditions, computed fields and constraints use a small expression language
(`backend/services/platform/spec/expressions.js`) that is tokenized, parsed to an
AST, type-checked against the entity's declared fields, and compiled either to
SQL with bound parameters or to an interpreter that walks the tree. There is no
`eval`, no `Function`, and no path by which a model-supplied string reaches the
database as anything but a bound value or an identifier the server resolved
itself. A backslash, a semicolon and a backtick do not tokenize.

```
model / analyzer
   -> design brief (data, workflow, audiences)
   -> composer          derives pages, roles, analytics, navigation
   -> validator         structure, coherence, and what would leak
   -> sandbox           seven sections, plus the migration plan
   -> planner           typed operations, each safety-classified
   -> approval          destructive steps named back, not a checkbox
   -> ddl.js            the only place that writes DDL
   -> one transaction   schema and registry together
```

### Who decides what

The model is asked the three things that require judgement about a business:
what the records ARE, how the process RUNS, and who is INVOLVED. Pages,
navigation, charts, roles and permissions are derived from those
deterministically by `studio/composer.js`. That is not distrust — it is asking
ten questions instead of two hundred, where the other hundred and ninety are
mechanical and each is a chance to reference a page that does not exist.

With no model configured, `studio/analyzer.js` reads the requirement for the
business process it names and produces the same kind of brief. It is a genuine
fallback, not a stub: the applications it designs are smaller and blunter, and
they deploy, work, and can be iterated on. The Studio says which path produced
your application rather than presenting a generic design as bespoke.

---

## Deployment

**Plan, approve, apply** — and the three are separate because three different
things need the plan before anything executes: the person approving it, the
safety classifier, and the deployer, which re-plans immediately before applying
and refuses if the plan changed since approval.

| Class | What it means | Gate |
|---|---|---|
| `safe` | additive only — new table, new nullable column, new index | proceeds |
| `review` | data keeps its bytes but changes meaning: a widened type, a new `NOT NULL`, a narrowed enum | explicit approval |
| `destructive` | data goes away: a dropped column or table, a narrowing type change | approval **plus** each destructive step named back |

The acknowledgement is not a boolean. A checkbox is something you click past;
echoing back *"Drop column root_cause from findings. Everything stored in it is
destroyed."* requires having read it — and because it is derived from the plan,
an approval cannot outlive the plan it was for.

DDL and registry writes share **one transaction**. A failure cannot leave a
table nothing can find or a registry row pointing at nothing. Postgres does
transactional DDL, so the correct answer is available and taken.

A narrowing type change is destructive even though Postgres will perform it
happily: `NUMERIC(18,4)` to `INTEGER` silently rounds every value, which is data
loss with a success message. Changes absent from the widening table are
destructive by default rather than "probably fine".

---

## Outside the company

A supplier answering a quality finding is not an employee with fewer
permissions. They are **anchored** to a canonical record — supplier `0f3a…` —
and every row they can reach is derived from that anchor:

```sql
WHERE t."app_instance_id" = $1 AND t."deleted_at" IS NULL
  AND (t."supplier_id" = $2::uuid)      -- their own id, bound by the server
```

That clause is ANDed into the query in one place
(`runtime/authorization.js` → `runtime/data.js`), before it runs. Filtering
after the fact would mean the rows were read, which makes every count, aggregate
and page number wrong even when the list looks right — and makes one missed call
site a full disclosure.

The internal side and every portal are served by **the same router**. There is
no portal-specific list endpoint and no second implementation of "only their own
records": the principal carries the anchor and the shared code does the rest.
The second implementation is where the leak would live.

Portal identities live in `app_external_identities`, not `users`, because every
existing query in this product that says `FROM users` was written assuming that
means "someone who works here". Their sessions are opaque tokens stored as
sha256 and checked against the identity's *current* status on every request:
revoking a supplier's access after a dispute takes effect on the next request,
not when their token happens to expire.

The validator refuses, before deployment, a specification that would put an
unshared canonical column, an unanchored entity, or a field marked `sensitive`
onto an external surface. The runtime refuses the same things again at read
time — because a validator can be bypassed by a specification deployed before a
rule existed, and a runtime cannot.

---

## Capability Discovery

Detection is arithmetic over the ledger. No model runs per scan.

```
detectors        counted queries: late deliveries, overdue receivables,
                 poor-condition receipts, unresolved anomalies, supply
                 concentration, canonical data no application touches
  -> accumulation   counts persist across scans
  -> thresholds     a count crossing a line, not a single occurrence
  -> deduplication  one open opportunity per underlying problem
  -> proposal       a stored row a person reads
```

Each stage exists to stop the previous one becoming noise. Without
accumulation, one late delivery is a "capability gap". Without deduplication,
the same problem is proposed on every scan until someone acts, which teaches
people to ignore the list.

**Discovery never deploys.** The strongest thing in it writes a row. Accepting
one opens the Studio with the requirement filled in; a person sees the plan and
decides.

---

## Where things are

| | |
|---|---|
| `services/platform/identifiers.js` | every SQL identifier the platform emits |
| `services/platform/spec/` | the closed vocabulary, the canonical EMBMIS catalogue, the expression language, the validator |
| `services/platform/compiler/` | planner (typed, safety-classified operations) and `ddl.js` (the only DDL writer) |
| `services/platform/registry.js` | applications, versions, instances, and `resolveTable` |
| `services/platform/deployer.js` | prepare / approve / apply, one transaction |
| `services/platform/runtime/` | authorization, data, analytics, workflow, automation, collaboration, page rendering, external identities |
| `services/platform/studio/` | analyzer, composer, generator, patch vocabulary, iteration, sessions |
| `services/platform/sandbox/` | the seven-section validation report and synthetic preview data |
| `services/platform/discovery/` | signal detectors and the proposal pipeline |
| `services/platform/scheduler.js` | scheduled automations, per company, off unless `PLATFORM_SCHEDULER_ENABLED=true` |
| `services/platform/legacyMigration.js` | pre-platform shared tables → per-company tables |
| `services/ai/platformTools.js` | Simeli's read-only view of all of it |
| `routes/platform/` | catalogue, Studio, internal runtime, portal, identities, opportunities |
| `frontend/src/pages/platform/` | Studio, AppRuntime, Applications, Opportunities, Portal |
| `frontend/src/components/platform/` | the block renderers — every component a generated application can use |

`/apps/:appKey/*` is the only route a generated application needs. Adding an
application adds no route and no component.

---

## Two sandboxes, deliberately kept apart

EMBMIS has a second thing called a sandbox: the ledger-grounded counterfactual
engine, which answers *"what happens to this business if we take this action?"*
by applying real writes to real rows inside a transaction it always rolls back.

The application sandbox answers a different question: *"will this application
work, and is it safe?"* It never touches business data and produces a report
about a specification rather than about a company. Conflating them would be a
category error with security consequences — one of them is allowed to touch the
ledger and one is not.

---

## Autonomy

The platform records provenance in six classes — observation, decision,
simulation, authorization, execution, outcome — and keeps them distinct, so a
proposal never reads later like something that happened.

Nothing here is autonomous. An AI agent inside an application is `read_only` by
default, cannot act at all on an external surface, and cannot widen its own
reach through a tool. Authority is granted from measured outcomes and explicit
approval; a specification asking for it is refused, and a model reporting high
confidence is not evidence of anything. Natural language is not a security
boundary: "deploy it" said to a chat window must not be a deployment, and there
is no Simeli tool that writes an application record or deploys one.

---

## Running it

```bash
cd backend
npm run db:migrate        # the platform's five migrations apply like any other
npm run test:platform     # 194 tests
node scripts/migrate-legacy-apps.js          # report on pre-platform applications
node scripts/migrate-legacy-apps.js --apply  # migrate them
```

The Studio is at `/studio`, the catalogue at `/applications`, discovery at
`/capability-opportunities`, a deployed application at `/apps/:appKey`, and the
external portal at `/portal/login` — outside the employee session entirely.
