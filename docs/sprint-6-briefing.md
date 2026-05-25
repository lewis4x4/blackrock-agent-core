# GOAL — Agent Core · Sprint 6 · Hardening, Metering & Admin

You are the **orchestrator** of a coordinated, multi-agent build. You do not write the bulk of the code yourself — you decompose the work, dispatch specialists, integrate what they return, drive a proof pass, and you do not stop until the scope is built, integrated, and clean.

**Work fully autonomously. Do not stop, do not ask for permission, do not pause for input — from the moment the run starts until you emit `[GOAL COMPLETE]`.** Make every routine decision yourself inside the locked stack and the spec's conventions; document assumptions inline and keep moving.

---

## Your role and the chain of command

- **You are the orchestrator.** You own the plan, the dispatch, the integration, and the proof pass. Nothing gets lost; nothing ships unverified.
- **Specialist agents.** Spawn a fresh sub-agent per part, each briefed deeply on its one part. Use `explore` agents to research, `engineer` agents to build, `design` agents only if a sub-area needs a written report.
- **The oracle — your code reviewer.** After you integrate every part, ask the oracle for a full proof pass over the whole scope. The oracle does not build; it finds defects.

The loop runs: **discover → decompose → dispatch → integrate → proof → fix → re-proof → … → complete.** It never stops in the middle.

---

## Paths

- **Project root:** `/Users/brianlewis/blackrock-agent-core`
- **Reference docs (read first):**
  - `docs/architecture.md` — master architecture & file manifest
  - `docs/agent-core-build-directive.md` — the reusable build directive (this sprint follows it)
  - `docs/install-runbook.md` — the watched runbook (Sprint 6 updates it)
  - `docs/designs/sprint-6-security.md` — 25 audit findings + ranking. **Read first.** Contains 3 production blockers in shipped code.
  - `docs/designs/sprint-6-metering.md` — usage / cost data model, RPCs, retention
  - `docs/designs/sprint-6-runtime.md` — 4 new runtime modules, handler.ts pipeline rewrite, SSE event additions
  - `docs/designs/sprint-6-migrations.md` — concrete SQL spec for every Sprint 6 migration
  - `docs/designs/sprint-6-admin-ux.md` — admin package, page-by-page spec, auth model
- **Stack (locked):** TypeScript (strict), Bun workspaces, `tsup` build; Supabase — PostgreSQL 15, Vault, Edge Functions in Deno; `@supabase/supabase-js`; React 18 for shell + admin.
- **Build / typecheck / test:** `bun run build` / `bun run typecheck` / `bun test`.

---

## Context — why this sprint exists

Agent Core is built and deployed through Sprint 5 (`main` at `231e8fb`): four packages published at `@blackrock-ai/*@0.1.2`, schema namespaced into `agent_core`, generic installer proven against BlackRock as tenant #1 (live at `gsvhuzpysxaegoecwjmf`). The runtime serves real requests, real Claude responses come back, the install pipeline is reusable for the next client.

Three things are now true, and Sprint 6 addresses them in order of urgency:

1. **The shipped code has three production security blockers** discovered by the Sprint 6 security audit:
   - **B1:** `handler.ts` never cross-checks the body's `tenantId` against the JWT's `tenant_id` claim. Any authenticated user can submit a run for any tenant and spend that tenant's Anthropic credit.
   - **B2:** Migration `0007_agent_core_grants.sql` blanket-grants `EXECUTE ON ALL FUNCTIONS … TO authenticated`, silently undoing the explicit revokes from `0002`/`0003`/`0004`/`0006`. Any signed-in user can call `agent_core.resolve_tenant_secret(<any tenant>, 'anthropic')` and read every tenant's plaintext API key, plus `resolve_tenant_connection` for OAuth tokens.
   - **B3:** `supabase/functions/oauth/index.ts` `handleStart` takes `tenant_id` from the URL with no JWT gate. An attacker can complete OAuth with their own IdP credentials, having the resulting tokens stored as the victim tenant's connection.
   These exist *today* in production at `gsvhuzpysxaegoecwjmf`. Sprint 6 Part A fixes them as its first action.

2. **The named Sprint 6 deliverables remain — metering, admin, hardening.** Per the master manifest. Metering enables billing; admin enables tenant operations without raw SQL; hardening adds rate limits, the oauth states sweeper, audit logging, and budget caps.

3. **The first install proved the pipeline works.** The next four clients (QEP, Redex, Lewis, Circle of Life) are now "Client Install" jobs, not core engineering. Sprint 6 must NOT regress the install path that BlackRock proved out.

This sprint is four parts: emergency security (A), operational hardening (B), metering (C), admin package (D). They ship in order. Part A is non-negotiable.

---

## First action — DISCOVERY (mandatory, before any building)

Check out a new branch from `main`: `git checkout main && git pull && git checkout -b cc/sprint-6-hardening-metering-admin`.

Then read the four specialist design docs in full — they ARE the discovery for this sprint. The Sprint 5 pattern of dispatching explore agents to re-discover the codebase is not needed; the design pass already did it. **Confirm the design docs against the actual code** before any building:

1. **Security audit confirm.** Open `docs/designs/sprint-6-security.md` and `packages/runtime/src/handler.ts` side by side. Confirm B1 (no JWT cross-check), B2 (the over-broad grant at `0007_agent_core_grants.sql:35`), B3 (no JWT gate in `oauth/index.ts handleStart`). If any blocker is misdiagnosed, note the correction and adjust Part A. **Building Part A starts only after this confirm.**
2. **Migration numbering claim.** Confirm that the next free migration filename in `packages/schema/migrations/` is `0008_*.sql`. (Sprint 5 ends at 0007.)
3. **Runtime module surface.** Open `packages/runtime/src/` and confirm the 11-file surface the runtime design doc assumes still matches reality.
4. **Admin package non-existence.** Confirm `packages/admin/` does not exist yet.

Emit a `[DISCOVERY]` block: confirmed defects, confirmed file lists, **any divergence from the four design docs** (code wins; note the correction). Building begins only after `[DISCOVERY]` is emitted.

---

## Scope for this run

> **This is the ONLY section that changes per run.** Everything else is the reusable operating model. Sprint 6 — Hardening, Metering & Admin. Four parts. They ship in order: A → B → C → D. Part A is a hard prerequisite for everything else.

### Part A — Emergency security hardening (the 3 blockers + the 6 high-priority items)

**This part exists because shipped 0.1.2 has live production security holes. It must land first.**

- **Migration `0008_revoke_definer_execute.sql`** — NEW. Re-revokes `EXECUTE` on every `SECURITY DEFINER` function in `agent_core` from `public`, `anon`, `authenticated`. Grants stay only to `service_role`. Specifically targets: `resolve_tenant_secret`, `store_tenant_credential`, `store_tenant_connection`, `resolve_tenant_connection`, `update_tenant_connection_tokens`, `read_tenant_table`, `store_artifact`, `list_artifacts`. Also alters default privileges so future SECURITY DEFINER fns inherit the revoke. Idempotent (every REVOKE is safe to re-run).
- **`handler.ts` — JWT tenant binding.** Parse the JWT from `Authorization: Bearer …` (Supabase Edge already verified the signature; we just decode the payload). Extract `tenant_id` claim. If body `tenantId !== jwt.tenant_id`, return 403. If JWT has no `tenant_id` claim, return 401. Service-role bearer is allowed to override via `x-agent-core-impersonate-tenant: <uuid>` so the existing `verify-*` scripts continue to work.
- **`supabase/functions/oauth/index.ts handleStart` — JWT tenant binding.** Same pattern. URL `tenant_id` must equal JWT `tenant_id`. Optionally require `admin_role` claim (connecting an IdP is admin-only).
- **`handler.ts` — payload caps.** Read body as `arrayBuffer()` first; reject if > 256 KB. Reject `message.length > 100_000`. Reject `model.length > 64`. Return 413 / 400 with helpful body.
- **`handler.ts` — per-run budget caps.** Constants: `MAX_TASKS_PER_GRAPH = 20`, `MAX_TOOL_CALLS_PER_RUN = 30`, `MAX_TOKENS_PER_RUN = 100_000`, `MAX_COST_PER_RUN_USD = 1.00`, `MAX_RUN_WALL_TIME_MS = 45_000`. After each `addUsage` check; on breach emit `{type:"error", message:"run budget exceeded"}`, mark run `failed`, stop. Also enforce `MAX_TASKS_PER_GRAPH` inside the planner.
- **`packages/tools/src/builtins/_connections.ts` — scrub error bodies.** `refreshTokens` and the persist path must not include the IdP response body in thrown errors. `handler.ts` sanitizes `runError` before writing to `agent_runs.error`.
- **`0006_oauth_connections.sql` patch (via `0008` or `0008b`)** — Fix the `store_tenant_connection` vault-name collision: use `gen_random_uuid()::text` suffix; explicitly delete the old vault secret before updating `secret_ref`. Same fix in `update_tenant_connection_tokens` (replace epoch-second suffix with UUID). Same in `store_tenant_credential` (delete old vault row on overwrite).
- **`verify-isolation.ts` — extend with the SECURITY DEFINER assertions.** For each of the 8 SECURITY DEFINER functions, assert an `authenticated`-role client gets `42501`. This is the regression guard for B2.
- **Acceptance.** Direct curl probes against gsvhuzpysxaegoecwjmf:
  - With a regular auth JWT (tenant A), POSTing to `/agent` with `tenantId = <tenant B>` returns 403.
  - Calling `resolve_tenant_secret` via PostgREST as `authenticated` returns 42501.
  - OAuth `?action=start&tenant_id=<other tenant>` returns 403.
  - Run with `message` > 100k chars returns 400.
  - Run that exceeds 100k token budget terminates with `error: run budget exceeded`.

### Part B — Operational hardening (rate limits, audit log, sweeper, quotas)

The named Sprint 6 hardening deliverables, layered on top of the Part A foundation.

- **Migration `0009_rate_limits.sql`** — `agent_core.rate_limit_counters` table keyed `(tenant_id, subject, window_start, window_secs)`; `check_rate_limit(p_tenant, p_subject, p_window_secs, p_limit) → boolean` RPC using atomic `insert ... on conflict do update returning count`; pg_cron job purging expired buckets every 5 minutes.
- **Migration `0010_audit_log.sql`** — `agent_core.audit_log` table (append-only via `revoke update, delete from non-service roles`); `record_audit_event(p_tenant, p_event, p_severity, p_meta) → uuid` RPC; `query_audit_log(...)` RPC for admin reads; `prune_audit_log()` weekly cron.
- **Migration `0011_oauth_states_sweeper.sql`** — `sweep_oauth_states()` function + pg_cron job every 5 minutes deleting rows where `expires_at < now()`. This closes the deferred-from-Remediation-2 gap.
- **Runtime module `packages/runtime/src/rate-limiter.ts`** — NEW. `checkRateLimit(supabase, tenant, subject, window)` → checks 3 buckets in parallel (per-tenant runs/min, per-user runs/min, per-IP runs/min). Returns `{ok: true}` or `{ok: false, retryAfterSec: number}`. Algorithm: sliding-window counter (cheaper than log; lossy but acceptable). Hard-coded limits for Sprint 6: 60 runs/min per tenant, 30 runs/min per user, 100 runs/min per IP.
- **Runtime module `packages/runtime/src/audit.ts`** — NEW. Batching audit-event writer; flushed at the same point as run finalization. Records: rate-limit triggered, budget exceeded, tenant created/deleted, tool toggle changed, OAuth connect/revoke, secret rotated.
- **Runtime module `packages/runtime/src/quota.ts`** — NEW. Reads `tenant_quotas` (new table, migration adds it or it's part of `0009`/`0012`). Soft and hard caps that go BEYOND the per-run constants (cumulative daily/monthly). Sprint 6 ships with hard-coded defaults; per-tenant overrides land in the admin UI in Part D.
- **`handler.ts` — pipeline rewrite per `sprint-6-runtime.md` §2.1.** New order: `parseAndValidateBody` → `extractJwtClaims` → `crossCheckTenant` → `checkRateLimit` → `loadTenantContext + loadQuotas (parallel)` → `enforceQuotaPreflight` → existing planner/executor/synthesizer/critic loop → `finalizeAndFlushAudit`.
- **SSE event additions** (`packages/runtime/src/events.ts`): `event: rate_limited` (with `retry_after_sec`), `event: quota_exceeded` (with `which_quota`, `usage`, `limit`). Additive fields on `final`: `cost_usd`, `tokens_total`, `duration_ms`. Header `x-agent-event-schema: 2` so consumers can opt into the new shape; consumers on schema 1 continue to work.
- **Verify scripts** — NEW `verify-rate-limits.ts`, `verify-audit.ts`. Each follows the existing `[ok]/[fail]/[parked]` shape from `verify-isolation.ts`.
- **Acceptance.**
  - 61st run in 60s from one tenant returns SSE `event: rate_limited` and the run never enters `loadTenantContext`.
  - Each of the 8 audit event types appears in `audit_log` after exercising its trigger.
  - `oauth_states` rows past `expires_at` are gone within 5 minutes of their expiry on a live cron-enabled project.

### Part C — Metering & cost

Capture per-LLM-call detail, attribute cost per tool, expose usage to the admin layer. Per `docs/designs/sprint-6-metering.md`.

- **Migration `0012_metering.sql`** — Three groups:
  - **Pricing** — `agent_core.model_prices` table (provider, model, effective_from, effective_to, input_per_million_tokens_usd, output_per_million_tokens_usd, cache_read_per_million_tokens_usd, cache_write_per_million_tokens_usd). Seed with current Anthropic + OpenAI prices.
  - **Per-call detail** — `agent_core.run_llm_calls` (run_id FK, step_label, provider, model, tokens_in, tokens_out, tokens_cached_read, tokens_cached_write, cost_usd, started_at, finished_at, error). One row per Claude/GPT call. `agent_core.tool_invocations` (run_id FK, tool_key, started_at, finished_at, external_units, external_cost_estimate_usd, ok, error).
  - **Rollups + RPCs** — `usage_rollup_daily` and `tool_usage_rollup_daily` hand-rolled tables (NOT materialized views — billing requires they outlive raw retention); `refresh_usage_rollup_daily()`, `refresh_tool_usage_rollup_daily()`, `usage_summary(tenant, from, to, grain)`, `usage_for_billing(tenant, month)`, `retention_sweep_agent_runs(p_days)`; pg_cron jobs every 15 min for refresh, daily 03:30 UTC for retention.
- **Runtime module `packages/runtime/src/metering.ts`** — NEW. `computeCost(provider, model, tokens, cacheStats?) → {cost_usd, breakdown}`. Pulls rates from `model_prices` (loaded once per cold start; refresh on cache miss). Anthropic prompt-caching discount logic.
- **`packages/runtime/src/model.ts` — minimal change.** Keep `ModelCallResult` shape; populate new fields (cache_read_tokens, cache_write_tokens, finish_reason, provider_metadata). Cost computation moves out — `model.ts` returns raw counts; `metering.ts` computes USD.
- **`persistence.ts` — write run_llm_calls / tool_invocations.** New helpers `recordLlmCall(...)` and `recordToolInvocation(...)`. The existing `finalizeRun` aggregates totals from these rows so `agent_runs.tokens_in/out/cost_estimate` stay populated for back-compat.
- **Tool `ToolContext.meter` callback.** Built-in tools that call external APIs (`web_search` → Brave quota, `hubspot_query` → HubSpot rate-limited, `m365_mail` → Graph) call `ctx.meter({unit_count, unit_cost_usd?})` to record per-invocation external cost.
- **Backfill helper script** — `packages/schema/scripts/backfill-usage-rollups.ts`. Run once per existing tenant after migration; aggregates pre-Sprint-6 `agent_runs` into `usage_rollup_daily` so the admin charts have historical data.
- **Verify script** — NEW `verify-metering.ts`. Asserts: pricing table seeded, rollup function produces correct totals from a fixture run, retention deletes rows older than threshold while preserving rollups.
- **Acceptance.**
  - A test run records ≥1 `run_llm_calls` row and (if a tool was called) ≥1 `tool_invocations` row.
  - `usage_summary` returns non-zero rows for BlackRock after the backfill.
  - `usage_for_billing` for the current month returns a single JSON object suitable for an invoice line item.
  - Manually applying `retention_sweep_agent_runs(90)` deletes raw runs older than 90 days while `usage_rollup_daily` rows for those days remain intact.

### Part D — Admin package

Per `docs/designs/sprint-6-admin-ux.md`. **Option B** chosen: a new package, not an extension to agent-core.

- **NEW package `@blackrock-ai/agent-admin`** — depends on `@blackrock-ai/agent-core` (for shared theme + types) and adds its own React UI dependencies (TanStack Query, recharts, TanStack Table v8, date-fns). Bundle target ~110 KB gzipped. The end-user `<Workspace />` shell stays at ~10 KB.
- **Migration `0013_admin_users.sql`** — `agent_core.admin_users` table (user_id, tenant_id nullable, role in `('superadmin','tenant_admin','tenant_viewer')`, granted_by, granted_at); `agent_core.is_admin(tenant_id, min_role)` helper; `agent_core.current_admin_role()` helper. Extends every existing `tenant_isolation` policy with an `or is_admin(tenant_id, 'tenant_viewer')` escape hatch so admins read across (or within) tenants.
- **NEW Edge Function `supabase/functions/auth-jwt/index.ts`** — `before-token-issued` Supabase Auth Hook. Reads `admin_users` for the authenticating user; merges `tenant_id` + `admin_role` into the JWT custom claims. (Operator step to enable in dashboard: Settings → Authentication → Hooks. install.sh prints the URL.)
- **Admin RPCs (~15)** added in `0013_admin_users.sql` and `0009/0010/0012` extensions:
  - `admin_list_tenants()`, `admin_create_tenant(slug, display_name)`, `admin_update_tenant(id, …)`, `admin_set_tenant_paused(id, paused)`
  - `admin_list_runs(tenant?, status?, from?, to?, limit, offset)`, `admin_get_run(id)` (returns run + plan + messages + llm_calls + tool_invocations)
  - `admin_set_tool_enabled(tenant, tool_key, enabled, config?)`
  - `admin_list_connections(tenant)`, `admin_revoke_connection(connection_id)`
  - `admin_list_credentials(tenant)` (returns provider + meta, NEVER the secret), `admin_rotate_credential(tenant, provider, new_secret)` (proxies through `store_tenant_credential` then deletes the old vault row)
  - `admin_list_admins(tenant?)`, `admin_set_admin(user_id, tenant, role)`, `admin_revoke_admin(user_id, tenant)`
  - `admin_get_usage_summary(tenant, from, to, grain)`, `admin_get_billing(tenant, month)`
  - `admin_get_audit_log(tenant?, severity?, event?, from?, to?, limit)`
  - `admin_reset_rate_limit(tenant, subject)`
  All SECURITY DEFINER with `is_admin` gate checks; service-role bypass for verify scripts.
- **Pages (7) under `packages/admin/src/pages/`:**
  - `Overview.tsx` — at-a-glance: 30-day cost, runs today, error rate, top tools, recent audit events
  - `Usage.tsx` — deep dive: time-series cost chart, by-tool breakdown, by-tenant breakdown (superadmin), filters
  - `Tenants.tsx` — table of tenants with create/edit/pause; superadmin only sees cross-tenant
  - `TenantDetail.tsx` — tabs: Overview / Tools / Connections / Credentials / Admins / Audit / Settings
  - `Runs.tsx` — filterable table of all runs (tenant, status, model, cost, duration)
  - `RunInspector.tsx` — single run drill-down: plan graph, each tool call, each message, total cost
  - `Settings.tsx` — org-wide (rate-limit overrides, retention overrides, branding)
- **Components shared with `<Workspace />`** — extract `BrandHeader`, accent CSS vars, `hexA()`, `Toast` into a new `packages/shell/src/theme.ts` module that both packages import.
- **`packages/admin/src/Admin.tsx`** — the package's main export. `<Admin config={tenantConfig} />`. Host app mounts it on a route (similar to Workspace).
- **Verify script** — NEW `verify-admin.ts`. Asserts admin RLS escape hatch works (superadmin sees all tenants, tenant_admin sees one, end-user denied), `is_admin` gate rejects non-admin RPC calls.
- **Acceptance.**
  - `npm install @blackrock-ai/agent-admin` resolves at 0.2.0.
  - `<Admin />` renders all 7 pages without runtime errors against gsvhuzpysxaegoecwjmf with a JWT carrying `admin_role: 'superadmin'`.
  - A tenant_admin sees only their tenant's data; superadmin sees all.
  - Admin RPCs deny non-admin callers with a clear error.

### Cross-cutting — release & docs

Lands at the end of Part D. The whole sprint ships together as 0.2.0.

- **Lockstep version bump 0.1.2 → 0.2.0** for all packages including the new `@blackrock-ai/agent-admin@0.2.0`.
- **`cli/release.sh` updated** to include the admin package in the publish flow.
- **`cli/install.sh` updated** — installs all 5 packages (incl. admin), prints the auth-hook setup URL, deploys the auth-jwt Edge Function alongside agent, prompts to add the admin route.
- **`docs/install-runbook.md` updated** — new "Sprint 6 — for existing 0.1.2 installs" appendix walking BlackRock-style upgrades through migrations + new env vars + auth hook setup.
- **`docs/architecture.md` updated** — package count is 5, the metering/admin/hardening rows in Section 3's sprint table flip to ✅ Built.
- **Acceptance.** `cli/release.sh` exits 0, pack-verifies 5 tarballs as `blackrock-ai-*`. `cli/install.sh --dry-run` against the fixture prints a complete plan including admin install + auth-jwt deploy.

After all four parts integrate, perform the **merge gate**: this run does NOT merge to `main`. It ends with everything committed on `cc/sprint-6-hardening-metering-admin`, and a `[MERGE GATE]` block giving the exact review diff and merge command.

---

## The build loop — how you operate

1. **Discover.** Emit `[DISCOVERY]` (see above) before anything else. Confirm the three blockers in real code.
2. **Decompose.** State it in a `[DECOMPOSITION]` block — each part and its specialist. Part A is the dependency; B/C/D may parallelize cautiously but A must integrate first.
3. **Dispatch.** A fresh specialist sub-agent per part, briefed completely. Engineer agents.
4. **Integrate.** Review each specialist's actual output — read the diffs, never trust a summary — reconcile against the other parts and the design docs, fix the seams. Commit the integrated part; emit `[PART X COMPLETE]`.
5. **Proof.** When all parts integrate, ask the oracle for a full proof pass over the whole scope with the diff. Pay specific attention to security (this is a hardening sprint — security bar is HIGH).
6. **Fix loop.** Dispatch a focused fix sub-agent per oracle issue, integrate, re-run the oracle. Repeat until `[PROOF PASS — CLEAN]`.
7. **Complete.** Run the final completion gate. Emit `[GOAL COMPLETE]`.

Move from step to step without stopping. Never hand control back until `[GOAL COMPLETE]`.

---

## Completion criteria — the goal is met when ALL of these pass

1. `cc/sprint-6-hardening-metering-admin` is checked out from `main` (post-Sprint-5 at `231e8fb`); a `[DISCOVERY]` block confirms the three blockers in real code and the migration numbering claim; a `[DECOMPOSITION]` block names every part and its specialist.
2. Every part is built by a dedicated specialist sub-agent and integrated by you; each has a `[PART X COMPLETE]` block with what shipped and a commit hash.
3. **Part A:** the three production blockers (B1/B2/B3) are fixed in code + migration; `verify-isolation.ts` extended to assert SECURITY DEFINER denial for `authenticated`; payload caps + budget caps enforced in `handler.ts`; OAuth + credential vault-collision bugs fixed; verify against a live test target (BlackRock-equivalent) passes.
4. **Part B:** `rate_limit_counters` + `audit_log` migrations applied; pg_cron jobs scheduled for rate-limit purge + oauth states sweeper + audit prune; `rate-limiter.ts` + `audit.ts` + `quota.ts` runtime modules ship; `handler.ts` pipeline reordered per design; new SSE events emit correctly; `verify-rate-limits.ts` + `verify-audit.ts` pass.
5. **Part C:** `model_prices` seeded; `run_llm_calls` + `tool_invocations` populated by the runtime per run; `usage_rollup_daily` + `tool_usage_rollup_daily` refresh on cron; `usage_summary` / `usage_for_billing` RPCs return correct shapes; backfill helper produces sane rollups for BlackRock's historical runs; `verify-metering.ts` passes.
6. **Part D:** `@blackrock-ai/agent-admin@0.2.0` package present; `admin_users` migration + `is_admin` helpers extending every RLS policy; `auth-jwt` Edge Function written; ~15 admin RPCs all `is_admin`-gated; all 7 admin pages render against the fixture; `verify-admin.ts` passes.
7. All four packages renamed nowhere (scope stays `@blackrock-ai`); all five packages at version `0.2.0` in lockstep; `release.sh` updated to include admin; `install.sh` updated to install + deploy + scaffold the new pieces; `docs/install-runbook.md` Sprint 6 upgrade appendix written.
8. `bun install`, `bun run build` exits 0, `bun run typecheck` exits 0, `bun test` passes — all output visible in the transcript.
9. Migrations 0008–0013 apply cleanly into a fresh local Supabase (or `[PARKED]` if Docker/CLI unavailable). Against a live target (gsvhuzpysxaegoecwjmf), the migrations apply via `supabase db push` without breaking existing 0.1.2 runtime.
10. The oracle has run a final proof pass over the entire scope with security framing; the transcript shows `[PROOF PASS — CLEAN]` with zero outstanding issues; prior `[PROOF PASS — ISSUES]` was followed by fixes and a re-proof.
11. All work is committed to `cc/sprint-6-hardening-metering-admin`; `git log` is visible. **Nothing is merged to `main`. Nothing is published. No client project is touched live.**
12. Final output contains a `[MERGE GATE]` block — exact review diff + merge command, noted as Brian's to run.
13. `[GOAL COMPLETE]` is emitted in the final turn.

---

## Binding rules — never violate

- **Part A ships first and ships complete.** The three blockers are live security holes in production code right now. Skipping them or partially fixing them is a violation. No part of B/C/D goes to `[PART COMPLETE]` until Part A is integrated and verified.
- **This run does not publish anything.** Even at 0.2.0 — Brian publishes watching after merge. An autoloop `npm publish` is a violation.
- **This run does not touch any client project live.** No `supabase db push` against gsvhuzpysxaegoecwjmf or any other client project. Install + verify is dry-run + fixture only. Brian re-runs the install against BlackRock after merge, watching.
- **This run does not merge to `main`.** It ends on `cc/sprint-6-hardening-metering-admin` with a `[MERGE GATE]` block.
- **Backward compat is binding.** Existing `@blackrock-ai/agent-runtime@0.1.2` running inside BlackRock's Edge Function MUST keep working after migrations 0008–0013 apply. Specifically: schema changes are additive (new tables, new columns where existing rows tolerate null); RPC additions don't remove existing RPCs; SSE event additions are additive (consumers on schema 1 ignore the new events).
- **`agent-schema` stays at the bottom of the stack.** No production dependency on `agent-core`, `agent-runtime`, `agent-tools`, or `agent-admin`. Migrations-only package.
- **No `any` types except where a third-party type forces it; document any such case in one line.**
- **Every new SQL function is schema-qualified `agent_core.*`. Every new RLS policy expression uses `agent_core.current_tenant()` and/or `agent_core.is_admin()` — never an unqualified `current_tenant()` or `is_admin()`. Every new SECURITY DEFINER function sets explicit `search_path` and explicitly `REVOKE EXECUTE FROM public, anon, authenticated` then `GRANT EXECUTE TO service_role` only.**
- **No secret echo.** No secret value (Anthropic key, OAuth token, refresh token) lands in any log, error message, SSE event, response body, or `agent_runs.error`. Error messages strip IdP response bodies.
- **The installer reconciles against live migration state.** Sprint 5 fixed this; Sprint 6 must not regress it.

---

## Autonomy — never stop

- **Decide on your own, never ask:** the decomposition, the specialist split, exactly how each new module is structured, the exact SQL of each migration (within the spec), the precise pages of the admin UI (within the spec). When a specialist returns work that diverges from the design doc in a defensible way, accept the divergence and note it.
- **Never pause to ask a question. Never wait for input. Never stop mid-loop.** If something is ambiguous, choose the most reasonable option consistent with the design docs and the already-built code, note the assumption in one line, continue.
- **A true external blocker does not stop the run.** Emit `[PARKED — <what and why>]`, build everything that does not depend on it, continue. Anticipated parks: Docker/CLI unavailable for the local Supabase verification → emit `[PARKED]`, do every offline check, ship.

---

## Commit cadence

Commit each integrated part on `cc/sprint-6-hardening-metering-admin`:

```
Sprint 6 — Part {A|B|C|D} — {name}

- {what shipped, one line each}
```

Never commit a broken build. Never commit to `main`. Run `bun run build` before each commit.

---

## Progress reporting

```
[DISCOVERY]
Security blockers confirmed in code: B1 {handler.ts:121-130}, B2 {0007:35}, B3 {oauth/index.ts:96-108}
Next free migration number: 0008
Runtime module surface: 14 files matches design assumption
Admin package: does not exist
Divergence from design docs: {none — or the list}
```
```
[DECOMPOSITION]
Part A — Security blockers + hardening -> {specialist}
Part B — Rate limits + audit + sweeper + quotas -> {specialist}
Part C — Metering & cost -> {specialist}
Part D — Admin package -> {specialist}
```
```
[PART X COMPLETE]
Shipped:
- {bullets}
Integrated and committed: {commit hash}
Next: Part {X+1}
```
```
[PROOF PASS — CLEAN]   (or [PROOF PASS — ISSUES])
Oracle reviewed: {scope}
Issues: {none — or the numbered list}
```

---

## Quality bar

Sprint 6 is the sprint that turns Agent Core from "shipped and running" into "shipped, running, and **safe to run a second tenant on**." "Done" means: the three production blockers from the audit are fixed and verified against the live target; rate limits, audit logging, the sweeper, and per-run budget caps prevent the obvious abuse vectors; metering captures every LLM call and external-API invocation with USD attribution, durably, with rollups that survive raw-run retention; the admin package exists and can manage tenants, tools, connections, credentials, and admins without raw SQL — gated by a real RLS-aware role model. If at any point the security work degrades existing behavior, the metering work double-counts or mis-attributes cost, the admin RPCs bypass tenant isolation, or any new SECURITY DEFINER function lands without the explicit REVOKE/GRANT discipline — stop and correct course. That signal matters more than finishing fast.

---

## Final completion gate

Before declaring complete:

1. `bun install`, then `bun run build` — exits 0.
2. `bun run typecheck` — exits 0.
3. `bun test` — passes; includes the new `verify-isolation` SECURITY DEFINER assertions and the four new `verify-*` scripts.
4. Migrations 0008–0013 apply cleanly into a fresh local Supabase and the `agent_core` schema holds every new object, with `verify-*` passing — or `[PARKED]` with reason.
5. `cli/install.sh --dry-run` prints a correct plan including admin install + auth-jwt deploy; `cli/release.sh` pack-verifies 5 packages.
6. The oracle's final proof pass shows `[PROOF PASS — CLEAN]`, with explicit security framing.
7. Self-audit every completion criterion — address each explicitly, PASS per item.

When all gates pass, output:

```
[GOAL COMPLETE]

Sprint 6 — Hardening, Metering & Admin complete on branch cc/sprint-6-hardening-metering-admin.
- Part A — security blockers + hardening: B1/B2/B3 fixed + payload caps + budget caps + vault-collision fixes
- Part B — operational hardening: rate limits + audit log + oauth sweeper + quotas
- Part C — metering & cost: per-call detail + rollups + retention + per-tool attribution
- Part D — admin package: @blackrock-ai/agent-admin@0.2.0 with 7 pages + 15 RPCs + RLS-aware role model
Cross-cutting: all 5 packages at 0.2.0, install.sh + release.sh + runbook updated.
Oracle proof: clean. Nothing published. No client project touched live.

[MERGE GATE — Brian]
Review:  git diff main...cc/sprint-6-hardening-metering-admin
Merge:   git checkout main && git merge cc/sprint-6-hardening-metering-admin && git push
After merge:
  1. Publish the five packages watching: cli/release.sh prints the commands.
  2. Re-run the installer against gsvhuzpysxaegoecwjmf to apply 0008–0013
     and redeploy the agent function with the 0.2.0 runtime bundle:
       cd ~/blackrock-agent-core && ./cli/install.sh --config cli/install.config
  3. Enable the auth-jwt Supabase Auth Hook in the dashboard
     (Settings → Authentication → Hooks → Before-token-issued → select auth-jwt).
  4. Insert your first admin row:
       supabase db query "insert into agent_core.admin_users (user_id, tenant_id, role) values (auth.uid(), null, 'superadmin') on conflict do nothing;" --linked
  5. Mount <Admin /> in command-center/web on a new admin route.
All five are yours, not the loop's.
```

Then stop.
