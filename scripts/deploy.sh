#!/usr/bin/env bash
#
# Deploy or update EMBMIS ERP on this server with docker-compose.prod.yml (see DEPLOY.md).
#
#   ./scripts/deploy.sh            pull, build, migrate, turn on company isolation once, start, health-check
#   ./scripts/deploy.sh --no-pull  the same without `git pull`
#
# Reads .env.production at the repository root. Safe to run again: unchanged images come from the build cache, and
# migrations and the isolation step are idempotent.
#
# Company isolation: every signup creates a company, and the database refuses a second company while row-level
# isolation is off. This script turns it on the first time (afterwards every migration run keeps it in sync).
# Set EMBMIS_ERP_ISOLATION=off to keep a single-company install.
set -euo pipefail

main() {
  cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [ -f .env.production ] || { echo "✗ .env.production is missing: cp deploy/env.production.example .env.production and fill it in (DEPLOY.md)"; exit 1; }

  if [ "${1:-}" != "--no-pull" ]; then
    echo "▶ Pulling"
    git pull --ff-only
  fi

  local dc=(docker compose -f docker-compose.prod.yml --env-file .env.production)

  echo "▶ Building images"
  "${dc[@]}" build

  # `up` never re-runs a migrate service that already exited 0, so run it explicitly and stop if it fails.
  echo "▶ Applying database migrations"
  "${dc[@]}" up -d postgres
  "${dc[@]}" run --rm migrate

  if [ "${EMBMIS_ERP_ISOLATION:-on}" = on ]; then
    echo "▶ Company isolation"
    "${dc[@]}" exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT CASE WHEN EXISTS (SELECT 1 FROM company_isolation_config WHERE id AND application_role IS NOT NULL)
            THEN 'company isolation: on'
            ELSE enable_multi_company('qira_app') END;
SQL
  fi

  echo "▶ Starting"
  "${dc[@]}" up -d --remove-orphans

  local port; port=$(grep -E '^BACKEND_PORT=' .env.production | cut -d= -f2- || true)
  local health="http://127.0.0.1:${port:-3001}/health"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$health"; then echo "✓ healthy ($health)"; return 0; fi
    sleep 2
  done
  echo "✗ not healthy after 2 minutes; last backend logs:"
  "${dc[@]}" logs --tail 40 backend || true
  exit 1
}

main "$@"
