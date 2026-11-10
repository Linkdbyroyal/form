# Deployment

Ticket M1-16. Hosting decision: ADR-014 (Railway for the pilot, portable by construction). Related: ADR-012 (worker runs on our infrastructure, no developer tooling in the image), ADR-016 (`ANTHROPIC_API_KEY` only in the worker), ADR-018 (`RESEND_API_KEY` and `PUMBLE_WEBHOOK_URL` only in the worker).

Status of this document: the Dockerfiles and `docker-compose.prod.yml` are implemented and reviewed. The Railway staging project `second-brain-os` (environment `staging`, services `postgres`, `web`, `worker`) was created on 2026-11-10 through the Railway GraphQL API from the development session; section 3.10 records what was actually done and how it differs from the original runbook. Railway reports config-as-code (`railway.json`) as deprecated in favour of Infrastructure as Code (`.railway/railway.ts`); the service settings are therefore set directly on the service instances (API or dashboard) and the `railway.json` files remain as the documented reference values.

## 1. Artefacts

| File | Purpose |
|---|---|
| `apps/web/Dockerfile` | Multi-stage build of the Next.js app (standalone output). Runtime image has Node only: no pnpm, no tsx, no sources. Listens on `PORT` (default 3000), `HEALTHCHECK` on `/api/health`, runs as user `node`. |
| `apps/worker/Dockerfile` | Multi-stage build of the agent worker with `pnpm deploy --prod`. Runtime image holds the production dependency tree plus `tsx` (a production dependency, the only TypeScript loader). No pnpm, git, compilers, vitest or TypeScript compiler. Listens on `PORT` (default 8080), `HEALTHCHECK` on `/healthz`, runs as user `node`. Also used to run migrations. |
| `apps/web/railway.json`, `apps/worker/railway.json` | Railway config-as-code per service: Dockerfile path, health check, restart policy, pre-deploy migration command (worker). |
| `docker-compose.prod.yml` | Portable stack for Hetzner or any Docker host: `postgres` (pgvector), `pg-backup`, `migrate`, `web`, `worker` (2 replicas), `caddy` (automatic HTTPS). |
| `.dockerignore` | Keeps `node_modules`, `.git`, `.next`, `legacy`, `docs`, Markdown and every `.env*` file out of the build context. |
| `.env.example` | Variable reference, including the deployment block at the end. |

Both images are built from the repository root as build context, because `@sbos/db` and `@sbos/contracts` are consumed as TypeScript source (`transpilePackages`) and must be present at build time:

```
docker build -f apps/web/Dockerfile    -t sbos-web    .
docker build -f apps/worker/Dockerfile -t sbos-worker .
```

The web image is stateless and has no migration capability by design. The worker image contains `node_modules/@sbos/db` with `migrations/` and `src/cli/migrate.ts`, so one image runs both the worker and the migrations:

```
node --import tsx node_modules/@sbos/db/src/cli/migrate.ts
```

## 2. Variables

Service column: `web`, `worker`, `migrate` (the migration command, which runs inside the worker image), `postgres` (Compose only), `caddy` (Compose only). Secret: whether the value must be stored as a secret and never logged.

| Name | Service(s) | Secret | Purpose |
|---|---|---|---|
| `DATABASE_URL` | web, worker | yes | Application connection string. Role must be able to `SET ROLE sbos_app` / `sbos_operator`, must not be a superuser and must not have `BYPASSRLS`. |
| `DATABASE_URL_MIGRATE` | migrate (worker service on Railway) | yes | Schema-owner connection string used by `migrate.ts`. Needs `CREATEROLE` on first run or pre-created roles (see `packages/db/README.md`, "Production roles"). |
| `DATABASE_URL_TEST` | none in production | yes | Local and CI only. |
| `ANTHROPIC_API_KEY` | worker | yes | Model calls. Never set on web (ADR-016). |
| `SBOS_DEFAULT_MODEL` | worker | no | Default model id (`claude-sonnet-5-5`). |
| `SBOS_PLATFORM_BUDGET_USD_MONTH` | worker | no | Platform-wide monthly spend cap, default 25 (ADR-016). |
| `SBOS_WORKER_CONCURRENCY` | worker | no | pg-boss jobs handled concurrently per process, default 2. |
| `RESEND_API_KEY` | worker | yes | Formal e-mail (ADR-018). Never set on web. |
| `RESEND_FROM_EMAIL` | worker | no | Verified sender, for example `Second Brain OS <noreply@yourdomain>`. |
| `PUMBLE_WEBHOOK_URL` | worker | yes | Internal operational notifications (ADR-018). Treat as a secret: whoever has it can post to the channel. |
| `BETTER_AUTH_SECRET` | web | yes | Session signing key, `openssl rand -base64 32`. Different per environment. |
| `BETTER_AUTH_URL` | web, worker | no | Public base URL, `https://<SBOS_DOMAIN>`. The worker uses it for deep links in notifications. |
| `SBOS_DOMAIN` | web, worker, caddy | no | Public hostname without scheme. Caddy requests the certificate for it. |
| `PORT` | web, worker | no | Listening port. Railway injects it; Compose sets 3000 and 8080. |
| `HOSTNAME` | web | no | `0.0.0.0` so the standalone server binds all interfaces (set in the Dockerfile). |
| `NODE_ENV` | web, worker | no | `production` (set in the Dockerfiles). |
| `SBOS_APP_DB_ROLE`, `SBOS_APP_DB_PASSWORD` | migrate (worker service on Railway) | yes | When both are set, `migrate.ts` creates or updates the application login role after the migrations (LOGIN, no superuser, no BYPASSRLS, `SET ROLE` grants, access to `auth`, CREATE on the database for the `pgboss` schema). `DATABASE_URL` of web and worker then uses that role. |
| `SBOS_SEED_ON_START` | worker | no | `1` runs the idempotent synthetic seed (agency tenant, agent catalogue, approved tech sources, two demo tenants marked synthetic) once before the queue starts. First start of a fresh database only; remove afterwards. |
| `SBOS_SETUP_TOKEN` | web | yes | Enables `POST /api/setup` (first superadmin) while set; 32+ characters, `openssl rand -hex 24`. The route refuses as soon as an admin user exists. Remove after use. |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | web, worker | secret key yes | Optional observability (Milestone 5). Leave empty until then. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | postgres, pg-backup (Compose only) | password yes | Container superuser and database name. Railway Postgres manages these itself. |
| `BACKUP_RETENTION_DAYS` | pg-backup (Compose only) | no | Days of local dumps to keep, default 14. |
| `CADDY_ACME_EMAIL` | caddy (Compose only) | no | Contact e-mail for Let's Encrypt. |

Rule of thumb: the web service receives exactly `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SBOS_DOMAIN`, `PORT` and the optional Langfuse keys. Everything else belongs to the worker.

Pending reconciliation (2026-11-09): uncommitted work in progress on auth (M1-01) and the worker (M1-06) reads variables that are not in this table yet: `DATABASE_URL_AUTH`, `MAIL_FROM` and `RESEND_API_KEY` in `apps/web` (Better Auth sending verification mail directly, which deviates from the ADR-018 consequence that Resend lives only in the worker), and `SBOS_APP_URL` and `SBOS_FORCE_SIMULATED` in `apps/worker`. When those tickets land, add the variables here and to `docker-compose.prod.yml`, and either record the ADR-018 deviation in `docs/DECISIONS.md` or route verification mail through the worker queue.

## 3. Railway, step by step

Railway runs each service from a Dockerfile; there is no Railway-specific code in the repository (ADR-014). Only `railway.json` files and the variables below are Railway artefacts.

### 3.1 Project and environments

1. Create a Railway project `second-brain-os` from the GitHub repository.
2. Environments: Railway creates `production`. Add a second environment `staging`. Both deploy from the same repository; set the branch per environment in each service's settings (for example `main` for production and the integration branch for staging).
3. Enable "Wait for CI" on both environments so a deployment starts only after the GitHub Actions workflow passes.

### 3.2 Postgres service

1. In each environment add a database service and pick the pgvector image: when creating the Postgres service choose the custom image option and set `pgvector/pgvector:pg16`, with a volume mounted at `/var/lib/postgresql/data`. If the Railway Postgres template is used instead, make sure the image is the pgvector variant (the template offers it) because Milestone 2 needs `CREATE EXTENSION vector`.
2. Railway exposes the connection details as service variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `DATABASE_URL`, and the private `DATABASE_PRIVATE_URL` on the internal network).
3. Create the application roles once per database. Connect with the Railway-provided superuser (`railway connect postgres` or the Railway data tab) and run:

   ```sql
   CREATE ROLE sbos_app NOLOGIN NOINHERIT;
   CREATE ROLE sbos_operator NOLOGIN NOINHERIT;
   CREATE ROLE sbos_web LOGIN PASSWORD '<strong password>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
   GRANT sbos_app TO sbos_web WITH SET TRUE, INHERIT FALSE;
   GRANT sbos_operator TO sbos_web WITH SET TRUE, INHERIT FALSE;
   GRANT CREATE ON DATABASE sbos TO sbos_web;  -- pg-boss creates and owns schema pgboss on first worker start
   ```

   The migration role is the Railway superuser (it owns the schema). Migration 0001 grants `sbos_app` and `sbos_operator` to the migration role itself; the statements above add a separate login role for the application so that application traffic never runs as a superuser (`packages/db/README.md`, "Production roles").

### 3.3 Web service

1. Add a service from the GitHub repository, name it `web`.
2. Settings, Source: Root Directory `/` (repository root; the Dockerfile needs the whole monorepo as context). Config-as-code path: `apps/web/railway.json`. Railway then reads `build.dockerfilePath = apps/web/Dockerfile` relative to the root directory. If the config path setting is not available in the UI, set the variable `RAILWAY_DOCKERFILE_PATH=apps/web/Dockerfile` instead and configure health check and restart policy by hand with the same values as in the JSON.
3. Variables (use references to the Postgres service so the URL follows the database):
   - `DATABASE_URL` = `postgresql://sbos_web:<password>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` (private network host; Railway resolves `PGHOST` to the internal hostname when both services are in the same project).
   - `BETTER_AUTH_SECRET` = generated per environment.
   - `BETTER_AUTH_URL` = `https://${{RAILWAY_PUBLIC_DOMAIN}}` (or the custom domain once attached).
   - `SBOS_DOMAIN` = the public hostname.
   - Do not set `ANTHROPIC_API_KEY`, `RESEND_API_KEY` or `PUMBLE_WEBHOOK_URL` here.
4. Networking: generate a public domain, later attach the custom domain. Railway injects `PORT`; the image reads it.
5. Health check `/api/health` and restart policy `ON_FAILURE` with 5 retries come from `railway.json`. The health check returns 503 until the database is reachable and migrated, so the first deployment of `web` goes green only after the worker's pre-deploy migration has run (see 3.5).

### 3.4 Worker service

1. Add a second service from the same repository, name it `worker`.
2. Root Directory `/`, config path `apps/worker/railway.json` (or `RAILWAY_DOCKERFILE_PATH=apps/worker/Dockerfile`).
3. Variables:
   - `DATABASE_URL` = same `sbos_web` URL as the web service (shared variable or copy).
   - `DATABASE_URL_MIGRATE` = `${{Postgres.DATABASE_PRIVATE_URL}}` (the Railway superuser; used only by the pre-deploy command).
   - `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `PUMBLE_WEBHOOK_URL`.
   - `SBOS_DEFAULT_MODEL`, `SBOS_PLATFORM_BUDGET_USD_MONTH=25`, `SBOS_WORKER_CONCURRENCY=2`.
   - `BETTER_AUTH_URL` and `SBOS_DOMAIN` as on web (deep links in notifications).
4. Networking: the worker needs no public domain. Leave it private; Railway's health check works over the private network on `PORT`.
5. `railway.json` sets `preDeployCommand` to the migration command, `healthcheckPath` `/healthz`, `restartPolicyType` `ON_FAILURE` with 10 retries, `numReplicas` 1 and `drainingSeconds` 60 so in-flight jobs can finish on redeploy. pg-boss supports several workers on one queue; raise `numReplicas` when the pilot needs it.

### 3.5 Migration strategy

- Migrations are forward-only SQL files in `packages/db/migrations`, applied in lexical order by `migrate.ts`, each in its own transaction and recorded in `schema_migrations`.
- On Railway they run as the worker service's `preDeployCommand` inside the worker image, before the new worker instance takes traffic. The web image cannot run migrations (no pnpm or tsx by design), so there is no `preDeployCommand` on the web service.
- Ordering: Railway deploys `web` and `worker` independently after a push. Because migrations follow expand-and-contract (add columns and tables first, remove them in a later release once no deployed code reads them), a web build that briefly runs against a newer schema is fine, and a web build that runs against the old schema until the worker migration finishes is fine as well. Never ship a migration that drops or renames something the currently deployed web code uses.
- Manual run (first setup, or if a pre-deploy failed): open a shell in the worker container with `railway ssh --service worker` and run the migration command from section 1. Alternative from a developer machine: `railway run --service worker -- pnpm --filter @sbos/db migrate` uses the service's variables with a local checkout.
- `/api/health` reports the number of applied migrations, which is the quickest way to confirm a migration landed.

### 3.6 First superadmin bootstrap

Public sign-up is disabled (ADR-015). Two ways, same logic (`apps/web/lib/bootstrap-admin.ts`):

1. Developer machine with database access: `SBOS_ADMIN_EMAIL=you@example.com SBOS_ADMIN_PASSWORD='...' pnpm --filter @sbos/web bootstrap-admin` (uses `DATABASE_URL`).
2. Hosted database without a public endpoint (Railway staging): the one-time route `POST /api/setup`, see 3.11.

Either way the agency tenant must exist first (seed) and the new superadmin must enable the second factor at `/account/security` right after the first sign-in: the application refuses to activate `superadmin` memberships without a verified second factor.

### 3.7 Backups

- Railway Postgres: enable the built-in backup schedule on the Postgres service (daily, keep at least 7 daily and 4 weekly) in the service's Backups tab, in both environments. Test a restore to a scratch service in staging once before the pilot.
- Weekly logical dump to storage outside Railway: run `pg_dump --format=custom` against `DATABASE_PRIVATE_URL` from a scheduled job and copy it to an S3-compatible bucket (Hetzner Object Storage, Cloudflare R2 or Backblaze B2). Two ways: a GitHub Actions workflow with a weekly `schedule` that uses the Railway CLI token and `railway run pg_dump ...`, or a third Railway service with a `cronSchedule` in its `railway.json` that runs the dump and `rclone copy`. Keep the dump encrypted at rest in the bucket and keep 8 weeks.
- Restore drill: `pg_restore --clean --if-exists --no-owner --dbname <url> <file>` into an empty database, then run `migrate.ts` to confirm the schema is at the expected version.

### 3.8 Rollback

- Code: in the Railway deployment list pick the previous successful deployment and choose "Redeploy". Both services keep their own history; roll back `web` and `worker` together if the release contained both.
- Database: migrations are not reverted automatically. If a migration breaks production, deploy a new forward migration that repairs it, or restore the pre-deploy backup into a fresh database and point `DATABASE_URL` at it (downtime). Because `web` only sees expand-phase changes, rolling back the code alone is safe as long as the contract phase of that migration has not shipped.
- Environment variables are versioned per deployment on Railway; redeploying an older deployment uses the variables it was built with.

### 3.9 Logs and operations

- `railway logs --service web --environment production` (or the Logs tab) streams structured JSON logs. Logs carry `tenant_id` and `run_id` and never secrets or client content (agent runtime design, section 7). Filter with the Railway log query syntax, for example `@level:error`.
- Health: `https://<domain>/api/health` returns `{ status, database, migrations, latency_ms }`. The worker's `/healthz` is private; check it with `railway ssh --service worker -- node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>r.text()).then(console.log)"`.
- Incidents and stall alarms are rows in the database and reach the team via Pumble (worker); an external uptime monitor should ping `/api/health` every minute.
- Costs: the worker enforces `SBOS_PLATFORM_BUDGET_USD_MONTH`; Railway usage is visible in the project usage page. Expected pilot footprint: web 0.5 vCPU / 512 MB, worker 1 vCPU / 1 GB, Postgres 1 GB volume.

## 4. Portability: Hetzner with Docker Compose

ADR-014 requires that leaving Railway is configuration, not code. `docker-compose.prod.yml` runs the same two images plus Postgres, a backup sidecar and Caddy on one VM (the pilot sizing in `docs/agent-runtime.md`, section 7: 4 vCPU / 8 GB).

1. Server: Ubuntu LTS, Docker Engine with Compose v2.23 or newer, firewall open on 22, 80 and 443 only. Point the DNS `A`/`AAAA` record of `SBOS_DOMAIN` at the VM before the first start so Caddy can obtain the certificate.
2. Clone the repository on the server (or copy the two Dockerfiles, the compose file and `.dockerignore`; the build needs the full monorepo as context, so cloning is simpler).
3. Create `.env.production` next to the compose file (never commit it; `.gitignore` already excludes `.env.*`). Required keys: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` (role `sbos_web`, host `postgres`), `DATABASE_URL_MIGRATE` (the `POSTGRES_USER` superuser, host `postgres`), `BETTER_AUTH_SECRET`, `SBOS_DOMAIN`, `CADDY_ACME_EMAIL`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `PUMBLE_WEBHOOK_URL`. Optional: `SBOS_DEFAULT_MODEL`, `SBOS_PLATFORM_BUDGET_USD_MONTH`, `SBOS_WORKER_CONCURRENCY`, `BACKUP_RETENTION_DAYS`, Langfuse keys. `chmod 600 .env.production`.
4. First start:

   ```
   docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres
   docker compose --env-file .env.production -f docker-compose.prod.yml exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
   ```

   Run the role statements from section 3.2 (the superuser here is `POSTGRES_USER`), then:

   ```
   docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
   ```

   `migrate` runs once and exits; `web` and `worker` start only after it completed successfully; `caddy` starts after `web` is healthy and obtains the certificate.
5. Each deploy: `git pull`, then `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build`. Compose rebuilds changed images, re-runs `migrate`, and recreates `web` and the two `worker` replicas.
6. Backups: `pg-backup` writes a gzip-compressed custom-format dump into the `sbos_backups` volume once a day and prunes dumps older than `BACKUP_RETENTION_DAYS`. Copy that volume off the host weekly with `rclone` or `restic` from a host cron job, for example `0 4 * * 0 docker run --rm -v sbos_sbos_backups:/backups:ro -v /root/.config/rclone:/config/rclone rclone/rclone sync /backups remote:sbos-backups`. Restore as in section 3.7.
7. Secrets: `.env.production` on the host (owner root, mode 600) for the pilot; move to SOPS-encrypted files or Docker secrets when a second operator gets server access (agent runtime design, section 7).
8. Logs: `docker compose -f docker-compose.prod.yml logs -f worker`. Configure the Docker `json-file` driver with rotation (`max-size`, `max-file`) in `/etc/docker/daemon.json` or ship to a central store.
9. Only `caddy` publishes ports. `postgres` and `pg-backup` are on the internal `backend` network; `web` and `worker` are on `backend` and `edge` (outbound HTTPS for Anthropic, Resend, Pumble, OAuth providers).

## 5. Verification record (2026-11-09)

- Docker daemon was not available in the development sandbox (`docker info` fails to connect to the daemon), so `docker build` could not be executed there. The Dockerfiles were validated by review and by executing their steps directly with the same pnpm version on a clean copy of the repository without `node_modules`:
  - `pnpm fetch` then `pnpm install --frozen-lockfile --offline --filter "@sbos/web..."` installed 3 of 7 workspace projects; `next build` with `output: "standalone"` produced `apps/web/.next/standalone/apps/web/server.js` with `pg` and `next` traced into `node_modules/.pnpm`; the standalone server answered `/` with 200 and `/api/health` with 503 "degraded" when the database was deliberately unreachable.
  - `pnpm fetch --prod` then `pnpm --filter @sbos/worker deploy --prod --legacy --offline <dir>` produced a tree with `@sbos/agents`, `@sbos/core`, `@sbos/db`, `@sbos/contracts`, `pg-boss`, `resend`, `tsx` and `zod`, and no vitest, TypeScript compiler or turbo; `node --import tsx node_modules/@sbos/db/src/cli/migrate.ts` resolved and ran up to the database connection.
  - Correction (2026-11-10, Railway build logs): on a clean builder the legacy deploy fails with `ERR_PNPM_NO_OFFLINE_META` because `pnpm fetch` stores tarballs but no registry metadata, and the legacy deploy resolves every workspace manifest against that metadata. The sandbox run above passed only because its pnpm cache already held the metadata. The Dockerfile now runs a full `pnpm fetch` and deploys with `--prefer-offline` (tarballs from the cache, manifests from the registry).
- Open item: the real `next build` in `apps/web` currently fails type checking in `apps/web/lib/queries.ts` because two `drizzle-orm` instances exist in `pnpm-lock.yaml` (one resolved with the `kysely` peer that pg-boss introduces, one without). The web image build will fail until that is deduplicated (see `docs/HANDOFF.md`).
- Open item: `apps/worker/src/main.ts` did not exist at the time of writing; the worker Dockerfile fails fast with a clear message if it is missing.


## 3.10 Staging as built (2026-11-10)

Created through the Railway GraphQL API (`backboard.railway.com/graphql/v2`, workspace token stored as a network secret of the development environment, never in the repository):

| Item | Value |
|---|---|
| Project | `second-brain-os` (id `e0883b56-51e6-4d9f-89ee-821bda7a9c6b`), workspace "linkdbyroyal's Projects" |
| Environment | `staging` (id `0f105362-06a9-4e5d-9565-6d2dd5104b65`) |
| `postgres` | image `pgvector/pgvector:pg16`, volume at `/var/lib/postgresql/data`, `PGDATA=/var/lib/postgresql/data/pgdata`, database `sbos`, reachable only on the private network (`postgres.railway.internal:5432`); no TCP proxy and no public endpoint |
| `web` | source GitHub `Linkdbyroyal/form`, branch `claude/second-brain-os-architecture-ovfky3`, root `/`, Dockerfile `apps/web/Dockerfile`, health `/api/health`, restart ON_FAILURE 5, public domain `web-staging-8e6d.up.railway.app` |
| `worker` | same source, Dockerfile `apps/worker/Dockerfile`, health `/healthz`, restart ON_FAILURE 10, draining 60 s, pre-deploy command `node --import tsx node_modules/@sbos/db/src/cli/migrate.ts` |

Variables: as in section 2, plus `SBOS_APP_DB_ROLE` and `SBOS_APP_DB_PASSWORD` on the worker. The migrate CLI creates or updates that login role after the migrations (no superuser, no BYPASSRLS, `SET ROLE` grants to `sbos_app` and `sbos_operator`, access to schema `auth`, CREATE on the database so pg-boss can create its `pgboss` schema; the first staging worker start failed with `permission denied for database sbos` before that grant existed), so the database never needs a public endpoint or a manual SQL session for setup; `DATABASE_URL` of both services uses that role, `DATABASE_URL_MIGRATE` the Railway Postgres superuser. `ANTHROPIC_API_KEY` is set on the worker only. Resend and Pumble credentials are not set yet (delivery is logged). The key pasted into the chat on 2026-11-10 must be rotated and the rotated value set on the worker service.

Operational notes: builds are triggered by pushes to the branch (Railway GitHub integration); the deployment list and logs are readable through the API (`deployments`, `deploymentLogs`) or the dashboard. The first superadmin is created with `pnpm bootstrap-admin` run inside the worker container (dashboard shell) or by `deploymentInstanceExecutionCreate` through the API.

## 3.11 First start on a fresh database (2026-11-10)

The runtime images contain no pnpm, tsx CLI entry or developer tooling (ADR-012), and the staging database has no public endpoint, so the first start uses two one-time switches instead of a shell:

1. Worker: set `SBOS_SEED_ON_START=1` and redeploy. On start the worker runs the idempotent seed from `@sbos/db` (agency tenant `second-brain-agency`, agent catalogue and skills, approved tech sources, two demo tenants marked synthetic) and logs `seed on start executed`. Remove the variable afterwards; a second run would be harmless but the switch should not stay on.
2. Web: set `SBOS_SETUP_TOKEN` (32+ random characters) and redeploy. Then, once:

   ```sh
   curl -X POST https://<SBOS_DOMAIN>/api/setup \
     -H "authorization: Bearer $SBOS_SETUP_TOKEN" -H "content-type: application/json" \
     -d '{"email":"owner@example.com","password":"<12+ characters>","name":"Owner"}'
   ```

   The route creates the auth user (admin, e-mail verified), the agency organisation linked to the agency tenant, the owner membership and the `superadmin` membership row, and returns identifiers only. Without the variable the route answers 404; with a wrong token 401; once any admin user exists 409, whatever the token. Remove the variable afterwards.
3. Sign in at `/sign-in`, enable TOTP at `/account/security`, then invite the rest of the agency from Mission Control.
