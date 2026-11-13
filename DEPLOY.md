# Deploying EMBMIS ERP

How to run EMBMIS ERP in production on your own server with Docker Compose and a reverse proxy. The examples use
`erp.example.com`; replace it with your host.

## What runs

`docker-compose.prod.yml` starts four containers: **postgres** (pgvector; company isolation needs the restricted
`qira_app` role, created on first boot), **migrate** (one-shot, must exit 0), **backend** (API, port 3001) and **frontend**
(static web app, port 3000). All published ports are bound to `127.0.0.1`; a reverse proxy terminates TLS
(`deploy/Caddyfile.example`).

## 1. Prepare the server

* A Linux host with Docker and the compose plugin, 4 GB of memory or more.
* A DNS record for your host (e.g. `erp.example.com`) pointing at the server; open ports 80 and 443 only.
* A reverse proxy: [Caddy](https://caddyserver.com) obtains and renews HTTPS certificates by itself.
* Clone the repository, then:

```bash
cp deploy/env.production.example .env.production
chmod 600 .env.production
```

Fill it in. Generate every secret on the server:

```bash
openssl rand -base64 48   # JWT_SECRET, SUPPLIER_JWT_SECRET, SSO_COOKIE_SECRET
openssl rand -hex 24      # POSTGRES_PASSWORD, APP_DB_PASSWORD
openssl rand -hex 32      # AI_VAULT_KEY
```

`AI_VAULT_KEY` encrypts stored secrets (AI provider keys, the gateway agent key of each company). Back it up with the
database; without it those secrets must be entered again. Nothing secret is baked into an image: `.env.production` is read
by compose at run time and is git-ignored.

**Where the app lives.** By default it is served at the root of its host: the web app at `/`, the API at `/api`. To serve
it under a path of a shared host instead (e.g. `https://example.com/erp`), set `APP_BASE_PATH=/erp`. The path is compiled
into the web bundle, so rebuild the `frontend` image after changing it, and use the matching block of
`deploy/Caddyfile.example`.

## 2. Start

```bash
./scripts/deploy.sh --no-pull
```

It builds the images, runs the migrations (and stops if one fails), turns on company isolation the first time, starts
everything and waits for the API to answer. Run it again (without `--no-pull`) to update.

Put the proxy in front: `deploy/Caddyfile.example` → `/etc/caddy/Caddyfile`, `systemctl reload caddy`.

## 3. First administrator

Sign up at `https://erp.example.com/`: the first account becomes the platform owner. Or create it from the server:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec \
  -e OWNER_EMAIL=you@example.com -e OWNER_PASSWORD='…' backend node scripts/create-owner.js
```

(and set `PLATFORM_OWNER_EMAIL` to the same address in `.env.production`).

**Company isolation.** Every signup creates its own company, and the database refuses a second company while row-level
isolation is off. `scripts/deploy.sh` turns it on once; to do it by hand:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT enable_multi_company('"'"'qira_app'"'"');"'
```

After that, every migration run keeps it in sync for new tables. For a single-company install, set
`EMBMIS_ERP_ISOLATION=off` when running `scripts/deploy.sh`.

**Before you open it to users:** the privacy policy and terms pages (`frontend/src/pages/PrivacyPolicy.jsx`,
`frontend/src/pages/TermsOfService.jsx`) contain the terms of EMBMIS's own hosted service. On your installation you are the
operator: replace them with your own text and contact addresses, then rebuild the `frontend` image.

## 4. Connect EMBMIS Gateway (optional)

[EMBMIS Gateway](https://github.com/EMBMIS/gateway) is a separate open-source project. With `EMBMIS_GATEWAY_URL` empty,
the ERP runs without it. To have every AI action checked first:

1. On the **gateway** host: `npm run platform-key` (or the container equivalent). Add the printed
   `SAG_PLATFORM_KEY_HASHES=…` line to the gateway's environment and restart it.
2. In `.env.production` here set `EMBMIS_GATEWAY_URL`, `EMBMIS_GATEWAY_CONSOLE_URL`, and `EMBMIS_GATEWAY_PLATFORM_KEY` (the
   key itself, not the hash). Choose `EMBMIS_GATEWAY_FAIL_MODE`:
   * `closed` (default): when the gateway cannot be reached, reads continue and every write waits for a person.
   * `open`: writes run without a check. Choose this only knowingly.
3. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d backend`.
4. In the app: **Settings → AI Gateway → Test connection**. The first check of each company registers it as a gateway
   tenant and stores its `simeli` agent key, encrypted, in `gateway_tenants`.

What happens at runtime: every Simeli tool call and every autonomous-agent action is sent to `POST /api/v1/decide` first.
`deny` → it does not run ("Blocked by EMBMIS Gateway: …"); `escalate` → it waits for a person in the normal approval step,
in every autonomy mode, and the person's answer is reported to the gateway's audit chain; `allow` → the usual rules apply.
Only the tool name, action type, amount and a size-bounded copy of the arguments are sent.

## Health checks

| Check | Command | Healthy |
|---|---|---|
| API | `curl -fsS https://erp.example.com/api/health` | HTTP 200 |
| Web | `curl -fsSI https://erp.example.com/` | HTTP 200 |
| Containers | `docker compose -f docker-compose.prod.yml ps` | `healthy` |
| Gateway link | Settings → AI Gateway | "Connected" |

## Backups

The database and `AI_VAULT_KEY` are what matter (uploads and exports have their own volumes).

```bash
# nightly, e.g. from cron
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > /var/backups/embmis-erp-$(date +%F).dump
docker run --rm -v embmis-erp_uploads:/d -v /var/backups:/b alpine tar czf /b/uploads-$(date +%F).tgz -C /d .
```

Restore into an empty database with `pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists file.dump`. Test a
restore before you need one.

## Updating

```bash
./scripts/deploy.sh
```

Take a backup first. Migrations run before the API starts; the API starts only if they succeed. To roll back, check out
the previous tag and run `./scripts/deploy.sh --no-pull` (migrations are forward-only: restore the backup if a migration
must be undone).

## Troubleshooting

* `backend` restarting: `docker compose logs backend`. A missing secret stops compose before anything starts.
* Web app loads but every call fails: `VITE_API_URL` was wrong at build time, or `APP_ORIGIN` does not match the address in the browser.
* "AI_VAULT_KEY is not set" in Settings → AI Gateway: set it and restart the backend.
* Settings → AI Gateway shows "Unreachable": check `EMBMIS_GATEWAY_URL` from inside the container
  (`docker compose exec backend node -e "fetch(process.env.EMBMIS_GATEWAY_URL+'/api/v1/health').then(r=>r.text()).then(console.log)"`).
