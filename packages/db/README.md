# @sbos/db

PostgreSQL schema, SQL migrations, Row-Level Security policies, seed data and isolation tests.

## Commands (from repo root)

```
pnpm db:migrate     # apply migrations to DATABASE_URL_MIGRATE (falls back to DATABASE_URL)
pnpm db:seed        # synthetic tenants and users (idempotent)
pnpm db:reset       # drop and recreate schema public (refuses in production)
pnpm --filter @sbos/db test   # resets DATABASE_URL_TEST, migrates, runs vitest
```

## How access works

Every query runs inside `handle.withContext(ctx, fn)`:

1. `SET LOCAL ROLE sbos_app` (tenant or agency scope) or `SET LOCAL ROLE sbos_operator` (cross-client metadata).
2. `set_config('app.tenant_id' | 'app.actor_id' | 'app.actor_type' | 'app.actor_scope' | 'app.roles', value, true)`.
3. Policies compare `tenant_id` with `app_tenant_id()`. Unset context means no rows (fail closed).

Settings are transaction-local, so pooled connections never leak context. The test `context does not leak between pooled transactions` guards this.

## Production roles

The migration role needs `CREATEROLE` the first time, or an administrator pre-creates the roles:

```sql
CREATE ROLE sbos_app NOLOGIN NOINHERIT;
CREATE ROLE sbos_operator NOLOGIN NOINHERIT;
GRANT sbos_app TO <migration_role> WITH SET TRUE, INHERIT FALSE;
GRANT sbos_operator TO <migration_role> WITH SET TRUE, INHERIT FALSE;
```

The application connects as a role that can `SET ROLE` to both but is not a superuser and has no `BYPASSRLS`.

## Adding a table

1. Add `tenant_id uuid NOT NULL REFERENCES tenants(id)` (or document why not).
2. `ENABLE` and `FORCE ROW LEVEL SECURITY`, add `*_app` and `*_operator_select` policies.
3. Grant privileges to `sbos_app`; grant only metadata columns to `sbos_operator`.
4. Add the Drizzle table in `src/schema/`.
5. Extend `test/isolation.test.ts`. The schema guard test fails automatically if RLS is missing.
