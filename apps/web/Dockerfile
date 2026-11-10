# syntax=docker/dockerfile:1.7
# Second Brain Business OS: web service (Next.js 16, standalone output).
#
# Build from the repository root (the build context must be the monorepo root,
# because @sbos/db and @sbos/contracts are consumed as TypeScript source via
# `transpilePackages` and must be present at build time):
#
#   docker build -f apps/web/Dockerfile -t sbos-web .
#
# Runtime: non-root, PORT from the environment (Railway sets PORT), HEALTHCHECK on /api/health.
# This image intentionally contains no pnpm, no tsx and no TypeScript sources: it cannot run
# migrations. Migrations run from the worker image (see docs/deployment.md, "Migrations").

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# ---------------------------------------------------------------------------
# base: Node 22 + pnpm 10.28.0 via corepack (pinned, matches package.json#packageManager)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# fetch: populate the pnpm store from the lockfile only, so this layer is cached
# until pnpm-lock.yaml changes (source edits do not invalidate it).
# ---------------------------------------------------------------------------
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# ---------------------------------------------------------------------------
# build: install only @sbos/web and its workspace dependencies (offline, from the
# fetched store), then `next build` with output: "standalone".
# ---------------------------------------------------------------------------
FROM fetch AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline --filter "@sbos/web..."
# `next build` evaluates server modules while collecting page data; the auth module refuses to load
# without a secret and a database URL. These placeholders exist only inside this build stage and are
# never part of the runtime image or its configuration: the real values come from the service
# variables at runtime (docs/deployment.md, section 2).
ENV BETTER_AUTH_SECRET=build-time-placeholder-not-used-at-runtime-0123456789 \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    BETTER_AUTH_URL=http://localhost:3000
RUN pnpm --filter @sbos/web build
# Next.js infers the workspace root from pnpm-lock.yaml, so the standalone tree mirrors the
# monorepo: .next/standalone/apps/web/server.js with node_modules at the standalone root.
# Fail the build early if the layout is not what the runtime stage expects.
RUN test -f apps/web/.next/standalone/apps/web/server.js \
      || { echo "standalone output not found at apps/web/.next/standalone/apps/web/server.js"; exit 1; } \
 && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
 && mkdir -p apps/web/public \
 && cp -r apps/web/public apps/web/.next/standalone/apps/web/public

# ---------------------------------------------------------------------------
# runtime: minimal image with only the traced standalone output.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# The official Node image ships a non-root user `node` (uid 1000); the app runs as that user.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
USER node
EXPOSE 3000
# /api/health returns 200 when the database is reachable and 503 otherwise. The slim image has no
# curl, so the probe uses Node's built-in fetch. PORT is read at probe time (Railway overrides it).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
