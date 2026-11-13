# Contributing to EMBMIS ERP

Thank you for helping. Bug reports, fixes, translations, new reports, module improvements, documentation and tests are
all welcome.

## Before you start

* **Small fix** (typo, obvious bug, missing test, translation): open a pull request directly.
* **Anything bigger** (a new module or feature, a change to the general ledger, approvals, company isolation or the
  database schema): open an issue first and describe what you want to do, so we can agree on the approach before you
  spend time on it.
* **Security problems**: never in a public issue. See [SECURITY.md](SECURITY.md).
* Looking for something to do? Issues labelled [`good first issue`](https://github.com/EMBMIS/erp/labels/good%20first%20issue)
  are small and self-contained.

## Development setup

Node.js 20+, Docker with the compose plugin. See the quick start in the [README](README.md):

```bash
cp .env.example .env && cp backend/.env.example backend/.env
docker compose up -d postgres
npm run setup
cd backend && npm run db:migrate && cd ..
npm run dev            # API on :3001, web app on :3000
```

## Running the tests

The backend suite runs against a real PostgreSQL with pgvector, as the restricted application role `qira_app`, with
company isolation on: the same configuration production uses. Once, on a fresh database:

```bash
export DATABASE_URL=postgresql://qira:<password>@localhost:5432/qira_erp_test     # an owner/superuser connection
export APP_DATABASE_URL=postgresql://qira_app:<app password>@localhost:5432/qira_erp_test
export JWT_SECRET=test SUPPLIER_JWT_SECRET=test

cd backend
npm run db:migrate                                        # schema
psql "$DATABASE_URL" -c "SELECT enable_multi_company('qira_app');"
npm run test:seed                                         # the default test company and its owner
```

(The `qira_app` role is created by `docker/postgres-init/10-create-app-role.sh` on a fresh compose volume;
`.github/workflows/ci.yml` shows how CI creates it on a plain PostgreSQL.)

Then, before you open a pull request:

```bash
cd backend && npm run test:all && npm run test:tenancy      # backend
cd frontend && npm test && npx vite build                   # frontend
npx eslint backend/ frontend/                               # from the repository root
```

The embedding tests download a small model the first time and need internet access.

## Rules that keep the ERP correct

* **Database changes are migrations** in `backend/database/migrations/`, named `YYYYMMDDHHMM_description.sql`. Never edit
  a migration that is already on the default branch: add a new one.
* **Every company-scoped table** has `company_id` (defaulting from the session) and is registered in
  `company_scoped_tables`; `npm run test:tenancy` fails otherwise. A table without `company_id` must be listed, with a
  reason, in `backend/tests/tenancyGuard.test.js`.
* **Money moves through the ledger**: postings are balanced journal entries, go through the approval chain, and respect
  segregation of duties and closed periods.
* **The AI proposes, a person approves**: anything Simeli changes is prepared for a person to confirm.
* Add or update tests for what you change, and update the documentation when behaviour changes.
* User-facing text goes through the translator (`t('…')`) with English in `frontend/src/i18n/locales/en.json`.
* One topic per pull request, with a description of what and why.

## Sign your commits (DCO)

Every commit must be signed off, certifying the [Developer Certificate of Origin](https://developercertificate.org/):
that you wrote the change, or otherwise have the right to submit it under this project's licence.

```bash
git commit -s -m "Explain what this commit does"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line. To sign off commits you already made:
`git rebase --signoff main`.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the licence of
this project.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
