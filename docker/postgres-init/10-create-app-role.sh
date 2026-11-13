#!/bin/sh
# Runs automatically on first init of an empty postgres_data volume (official
# postgres image convention: every *.sh/*.sql in /docker-entrypoint-initdb.d
# is executed once, in filename order, only when the data directory is new).
#
# Creates the restricted application role that company isolation (RLS,
# migrations 110-112) requires. POSTGRES_USER (the owner, used by
# MIGRATION_DATABASE_URL) is a superuser and therefore always bypasses RLS —
# see migration 111 — so the app's own runtime connection (DATABASE_URL) must
# be a different, unprivileged role. This script creates it with the exact
# grants migration 111 documents as a manual runbook; here it's automatic
# instead, so a fresh `docker compose up` doesn't leave an operator to
# reproduce that runbook by hand.
#
# Does NOT call enable_multi_company() — turning on row-level isolation is a
# deliberate operator decision (it changes what "create a second company"
# does), not something a first boot should do silently. Run it yourself once
# ready:
#   docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
#     -c "SELECT enable_multi_company('qira_app');"

set -e

if [ -z "$APP_DB_PASSWORD" ]; then
  echo "10-create-app-role.sh: APP_DB_PASSWORD is not set — skipping qira_app role creation." >&2
  echo "  Company isolation cannot be enabled without it. Set APP_DB_PASSWORD in .env and recreate the volume, or create the role manually (see migration 111)." >&2
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qira_app') THEN
      CREATE ROLE qira_app LOGIN PASSWORD '$APP_DB_PASSWORD' NOBYPASSRLS;
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE $POSTGRES_DB TO qira_app;
  GRANT USAGE ON SCHEMA public TO qira_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qira_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qira_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qira_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO qira_app;
EOSQL

echo "10-create-app-role.sh: qira_app role ready."
