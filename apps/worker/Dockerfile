# syntax=docker/dockerfile:1.7
# Second Brain Business OS: worker service (autonomous agent runtime, pg-boss on PostgreSQL).
#
# Build from the repository root:
#
#   docker build -f apps/worker/Dockerfile -t sbos-worker .
#
# ADR-012: the worker image contains no developer tooling. The runtime stage holds only the
# production dependency tree produced by `pnpm deploy --prod` (tsx is a production dependency of
# @sbos/worker and is the only TypeScript loader present). No pnpm, no git, no compilers, no editors,
# no vitest, no TypeScript compiler, no Claude Code.
#
# Runtime: non-root, PORT default 8080 (GET /healthz), HEALTHCHECK on /healthz.
# The same image runs database migrations (Railway preDeployCommand, Compose `migrate` service):
#
#   node --import tsx node_modules/@sbos/db/src/cli/migrate.ts
#
# Required variables at runtime: DATABASE_URL, ANTHROPIC_API_KEY, RESEND_API_KEY, PUMBLE_WEBHOOK_URL
# (and DATABASE_URL_MIGRATE for the migration command). See docs/deployment.md.

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# ---------------------------------------------------------------------------
# base: Node 22 + pnpm 10.28.0 via corepack (build stages only)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# fetch: packages from the lockfile (cached until pnpm-lock.yaml changes). The full fetch is needed because
# the legacy deploy resolves every workspace manifest; `deploy --prod` still leaves dev packages out of /out.
# ---------------------------------------------------------------------------
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# ---------------------------------------------------------------------------
# deploy: materialise @sbos/worker plus its workspace packages (@sbos/agents, @sbos/core,
# @sbos/db, @sbos/contracts) and production dependencies into /out. `--legacy` is required in
# pnpm 10 for workspaces without inject-workspace-packages; it copies the workspace packages
# (TypeScript sources, and @sbos/db/migrations) into node_modules of the deploy directory.
# ---------------------------------------------------------------------------
FROM fetch AS deploy
COPY . .
RUN pnpm --filter @sbos/worker deploy --prod --legacy --offline /out
# Entry point must exist; fail fast with a clear message instead of a broken image.
RUN test -f /out/src/main.ts \
      || { echo "apps/worker/src/main.ts is missing: the worker has no entry point"; exit 1; }
# Strip test configuration and test suites of the copied workspace packages (not tooling, but
# not needed at runtime either).
RUN rm -f /out/vitest.config.ts \
 && find /out/node_modules/.pnpm -path '*/node_modules/@sbos/*' \( -name test -o -name vitest.config.ts \) -prune -exec rm -rf {} +

# ---------------------------------------------------------------------------
# runtime: production dependency tree only, non-root
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=deploy --chown=node:node /out ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
