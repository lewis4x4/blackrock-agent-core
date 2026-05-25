# Agent Core Install Runbook

## Prerequisites
- A target client repo (git repo with `supabase/` directory).
- The four `@blackrock-ai/*` packages are published to GitHub Packages.
- `GITHUB_TOKEN` set with `read:packages` scope.
- `supabase` CLI installed and logged in (`supabase login`).
- `supabase_vault` extension enabled in the target Supabase dashboard.

## Step 1 — Backup target Supabase project
In Supabase dashboard: **Database → Backups → Create backup**. Wait until backup completes.

## Step 2 — Clone agent-core repo locally
```bash
git clone git@github.com:blackrock-ai/blackrock-agent-core.git
cd blackrock-agent-core
bun install
```

## Step 3 — Configure install
```bash
cp cli/install.config.example cli/install.config
```
Edit:
- `TARGET_REPO`: absolute path to target repo root.
- `TENANT_SLUG`: unique tenant key for target Supabase.
- `SUPABASE_PROJECT_REF`: target project ref.
- `TARGET_WEB_DIR`: host app source dir for `agent.config.ts`.
- `MIGRATION_STYLE`: `supabase_timestamp` or `sequential`.
- `TENANT_DISPLAY_NAME`: optional display label.

## Step 4 — Dry run
```bash
./cli/install.sh --dry-run
```
Review the full printed plan. Abort if any command/path is wrong.

## Step 5 — Run installer
```bash
./cli/install.sh
```
Watch all 12 steps and resolve any `FAIL` immediately.

## Step 6 — Add `agent_core` to dashboard exposed schemas
Open:
`https://supabase.com/dashboard/project/<ref>/settings/api`
Add `agent_core` under **Exposed schemas** and save.

## Step 7 — Mount the workspace
Open:
`$TARGET_REPO/.agent-core-install/MOUNT_SNIPPET.md`
Apply the snippet in the target app’s top-level route (Next App Router/Pages/Vite/etc.).

## Step 8 — Smoke test
Run target app, open mounted route, submit a request, confirm SSE stream returns `plan` / `tool_*` / `done` events.

## Troubleshooting
- **`401 Unauthorized` from GitHub Packages**: `GITHUB_TOKEN` missing or lacks `read:packages`.
- **`agent_core schema not in exposed schemas`**: complete Step 6 in dashboard.
- **Migration duplicate object conflict**: renumbering/timestamp conflict; re-run prepare-migrations with a fresh timestamp seed.
- **Vault extension missing**: enable `supabase_vault` in dashboard extensions.

## Appendix — Sprint 6 upgrade for existing 0.1.x installs (target: 0.2.0)

1. Pull latest `blackrock-agent-core` and ensure your host app is ready for the lockstep `0.2.0` package set.
2. Apply migrations **0008 through 0016** in order.
3. Re-install npm packages so host and schema clients pick up the new admin surfaces.
4. Re-deploy the `agent` Edge Function bundle.
5. Deploy the new `auth-jwt` Edge Function (`supabase/functions/auth-jwt/index.ts`).
6. Set hook secret:
   - `supabase secrets set SUPABASE_AUTH_HOOK_SECRET=<shared-secret> --project-ref <ref>`
7. In Supabase dashboard enable hook:
   - `Settings → Authentication → Hooks → Before-token-issued → auth-jwt`
8. Insert first superadmin row (run as an authenticated admin user context):
   - `insert into agent_core.admin_users (user_id, tenant_id, role) values (auth.uid(), null, 'superadmin')`
9. Mount `<Admin />` in your host app and wire it to the new admin RPC surface.
