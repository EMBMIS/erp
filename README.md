# EMBMIS ERP

An open-source, AI-native ERP: finance, sales, procurement, inventory and warehouse, manufacturing, projects, HR and CRM
in one system, with **Simeli**, an AI assistant that works on the company's own data and explains why the numbers moved.

**Free and open source** under the [Apache License 2.0](LICENSE): every module, no user limits, no trial, no paid tier.
Want it set up for your company, customised to your processes, or supported in production? [EMBMIS](https://embmis.com)
offers setup, customisation and support.

## What is in it

| Area | Highlights |
|---|---|
| Finance | General ledger and journals with approval chains, accounts receivable and payable, bank, budgets, fixed assets and depreciation, FX revaluation, period close with pre-close checks, financial reports |
| Sales and CRM | Leads, deals, quotations, sales orders, contracts, deliveries, invoicing, customer portal |
| Procurement | Requisitions, RFQs, purchase orders, goods receipts, supplier invoices and payments, supplier portal |
| Inventory and warehouse | Items, stock, bins, transfers, stocktakes, serial and lot traceability |
| Manufacturing | Bills of material, routings, work orders, MRP |
| Projects and HR | Projects, milestones and billing; employees, leave, attendance, payroll |
| Simeli (AI) | Chat over the company's data, "why did margin, sales or costs move", delivery risk, proposed follow-ups that a person approves |
| Application platform | Describe an application in a sentence and get real tables, screens, workflow and portals for one company ([APPLICATION_PLATFORM.md](APPLICATION_PLATFORM.md)) |
| Governance | Multi-company with row-level isolation in PostgreSQL, roles, delegation of authority, segregation of duties, audit trail |

Every AI action can be checked before it runs by [EMBMIS Gateway](https://github.com/EMBMIS/gateway) (optional, also
open source).

## Quick start (development)

Requirements: Node.js 20+, Docker with the compose plugin.

```bash
git clone https://github.com/EMBMIS/erp
cd erp
cp .env.example .env                 # fill in the secrets it asks for
cp backend/.env.example backend/.env
docker compose up -d                 # PostgreSQL (pgvector), migrations, API on :3001, web app on :3000
```

Open http://localhost:3000 and sign up: the first account becomes the platform owner.

To work on the code with hot reload instead, start only the database in Docker and run the apps natively:

```bash
docker compose up -d postgres
npm run setup                        # installs root, backend and frontend dependencies
cd backend && npm run db:migrate && cd ..
npm run dev                          # API on :3001 and web app on :3000
```

## Production

[DEPLOY.md](DEPLOY.md): Docker Compose behind a reverse proxy, backups, updates, connecting the Gateway.

## Tests

```bash
cd backend && npm run test:all       # against a migrated PostgreSQL database; see CONTRIBUTING.md
cd frontend && npm test && npx vite build
```

## Project structure

```text
backend/     Express API: routes/, models/, services/ (services/ai: Simeli), database/ (baseline + migrations), tests/
frontend/    React + Vite web app: src/pages, src/components, src/i18n (locales)
docker/      PostgreSQL initialisation (the restricted application role)
deploy/      Production environment and reverse-proxy examples
e2e/         Playwright end-to-end journeys
```

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md), not in public issues.

## License

Copyright 2026 Rashad Yusubov. Licensed under the [Apache License, Version 2.0](LICENSE). "EMBMIS" is a trademark of its
owner and is not licensed under Apache-2.0: forks must use a different name.
