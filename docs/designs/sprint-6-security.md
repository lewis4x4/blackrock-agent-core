# Sprint 6 — Security Hardening Design

**Status:** Design (pre-implementation). Live defects discovered during audit are listed in §1 with file:line refs.
**Author:** Security audit pass
**Scope:** packages/runtime, packages/tools, packages/schema migrations 0001–0007, supabase/functions/oauth, install.sh
**Sprint 6 manifest intent:** "Rate-limiting middleware in handler.ts; the oauth_states sweeper cron (deferred from Remediation 2); a security pass"

---

## TL;DR

The audit surfaced **three blockers, six high-severity defects, and a long tail of mediums/lows.** The most important finding is unrelated to the named Sprint 6 deliverables:

> **BLOCKER-1**: `handler.ts` reads `tenantId` from the request body and never cross-checks it against the authenticated JWT. Any authenticated end-user from tenant A can supply `tenantId: <tenant-B-uuid>` and have the runtime spend tenant B's Anthropic key, write into tenant B's `agent_runs`, and (via tool calls) read/mutate tenant B's data.
>
> **BLOCKER-2**: Migration `0007_agent_core_grants.sql` issues a blanket `grant execute on all functions in schema agent_core to authenticated`. This silently undoes the explicit `revoke … from authenticated` clauses in migrations 0002/0003/0004/0006. End result: every logged-in user of any host app can directly call `resolve_tenant_secret`, `resolve_tenant_connection`, `store_tenant_credential`, etc. against any tenant id — i.e., **plaintext exfiltration of every tenant's Anthropic key and OAuth tokens via supabase-js.rpc()**.
>
> **BLOCKER-3**: The OAuth start endpoint (`supabase/functions/oauth/index.ts handleStart`) accepts `tenant_id` from query parameters with no JWT binding. An unauthenticated attacker can begin an OAuth flow as any tenant and, after completing the IdP dance with their own HubSpot/M365 account, end up with their tokens stored as the victim tenant's connection — poisoning every subsequent `hubspot_query` / `m365_mail` call the victim runs.

All three are pre-existing defects from Sprints 1–5. They must land in Sprint 6 before any rate-limiting work, because rate-limiting is meaningless if the auth boundary is gone. The originally planned Sprint 6 deliverables (rate limits, oauth_states sweeper) are still in scope but they're now §2.B and §3 of a longer list.

---

## 1. Audit findings (defects in existing code)

Severity legend: **blocker** = ship-stopping confidentiality/integrity flaw; **high** = realistic exploit or operational outage; **medium** = degrades posture, fixable post-Sprint-6 if necessary; **low** = polish / hardening.

### 1.1 Tenant identity is not bound to auth context (BLOCKER)

- **File:** `packages/runtime/src/handler.ts:121-130`
- **What's wrong:** The body is parsed and `tenantId = body?.tenantId` is taken at face value. Supabase Edge Functions verify a JWT exists (the deploy command in `install.sh:240` does not pass `--no-verify-jwt`), but `handler.ts` never reads `auth.jwt() ->> 'tenant_id'` and compares it to the requested tenant. An authenticated user from tenant A can spoof a request for tenant B's run and the handler will dutifully resolve tenant B's Anthropic key via the service-role client and execute against tenant B's data.
- **Recommended fix:**
  1. In `handler.ts`, parse the JWT from `Authorization: Bearer <jwt>` (use `jose` or hand-decode the middle segment — we already trust Supabase to have verified the signature) and extract its `tenant_id` claim.
  2. If `body.tenantId !== jwtClaims.tenant_id`, return `403 forbidden tenant mismatch`.
  3. If the JWT lacks a `tenant_id` claim entirely, return `401`. (No claim = no membership to assert.)
  4. For service-role callers (internal scripts), accept a header like `x-agent-core-impersonate-tenant: <uuid>` and allow it only when the bearer is the service role — this preserves the verify-streaming.ts/verify-tools.ts path.
- **Required for Sprint 6.**

### 1.2 Migration 0007 grants EXECUTE on every function to `authenticated` (BLOCKER)

- **File:** `packages/schema/migrations/0007_agent_core_grants.sql:35` (`grant execute on all functions in schema agent_core to authenticated;`) plus the matching `alter default privileges … grant execute on functions to authenticated;` at line 49.
- **What's wrong:** Migrations 0002, 0003, 0004, and 0006 each create a SECURITY DEFINER function, then explicitly `revoke all … from public, anon, authenticated` and `grant execute … to service_role` only. 0007 runs last and re-grants EXECUTE to `authenticated` on every function in the schema, overriding those revokes. Result: any signed-in end-user can call —
  - `agent_core.resolve_tenant_secret(<tenant>, 'anthropic')` → plaintext key from Vault.
  - `agent_core.resolve_tenant_connection(<tenant>, 'hubspot')` → plaintext OAuth access + refresh tokens.
  - `agent_core.store_tenant_credential(<victim>, 'anthropic', '<attacker-controlled>')` → overwrites the victim's API key.
  - `agent_core.store_tenant_connection(<victim>, 'hubspot', 'default', '<attacker-tokens>', …)` → swaps the victim's HubSpot connection.
  - `agent_core.read_tenant_table(<victim>, 'agent_messages')` → reads every tenant's run history (bypasses RLS — SECURITY DEFINER).
  - `agent_core.list_artifacts(<victim>)` → metadata enumeration.
  - `agent_core.update_tenant_connection_tokens(<connection_id>, …)` → arbitrary token swap.
- **Recommended fix:** Add migration `0008_revoke_definer_execute.sql` that re-revokes EXECUTE on each SECURITY DEFINER function from `authenticated` (and `anon`, defensively), then narrows the `alter default privileges` clause from "grant execute on functions" to "grant execute on functions WHERE SECURITY DEFINER = FALSE". PostgreSQL doesn't expose a WHERE clause on default privs, so practically: split functions into two schemas (`agent_core` for tables + INVOKER helpers, `agent_core_internal` for SECURITY DEFINER) and grant EXECUTE on `agent_core_internal` only to `service_role`. Minimum acceptable fix for Sprint 6 is the explicit per-function REVOKE.
- **Test that catches future regressions:** Extend `packages/schema/scripts/verify-isolation.ts` to assert that an `authenticated`-role client gets `42501` from each of the seven SECURITY DEFINER functions.

### 1.3 OAuth start has no auth gate (BLOCKER)

- **File:** `supabase/functions/oauth/index.ts:96-108` (`handleStart`)
- **What's wrong:** `tenant_id` is read straight from the URL with no verification that the caller belongs to that tenant. Combined with the same JWT-binding gap as §1.1, an attacker can: (a) trigger an `oauth_states` insert for any tenant id (mass-insert DoS surface — pairs with §1.6 below), and (b) more dangerously, complete the OAuth dance with their own IdP credentials such that the **victim** tenant's `tenant_connections` row points at the attacker's HubSpot / M365 account. Every subsequent `hubspot_query` or `m365_mail` run on the victim's behalf reads/writes the attacker's resource.
- **Recommended fix:** Same pattern as §1.1 — extract the JWT from the request, compare its `tenant_id` claim to the query param, reject mismatch with 403. Optionally require that the caller's JWT also carries an `admin` role claim, since connecting an IdP is typically an admin-only operation.
- **Required for Sprint 6.**

### 1.4 No payload size limit on agent body (HIGH)

- **File:** `packages/runtime/src/handler.ts:124` (`const body: any = await req.json()`)
- **What's wrong:** Supabase Edge Functions on Deno Deploy have a soft body cap (~6 MB last published, subject to change) but the handler never enforces anything. A malicious caller can stream a 6 MB JSON payload with a multi-megabyte `message` field that becomes the user prompt — driving (a) memory pressure in the Edge Function, (b) a massive prompt token bill from Anthropic, and (c) potentially blowing the Edge Function 50-second timeout before the LLM responds. Even a benign client error (UI sends an entire file as `message`) can cost real dollars.
- **Recommended fix:**
  1. Read the request as `arrayBuffer()` first; reject if `byteLength > MAX_BODY_BYTES` (recommend 256 KB — leaves room for ~50 KB of structured envelope around a 200 KB message).
  2. After JSON parse, validate `typeof message === "string"` and `message.length <= MAX_MESSAGE_CHARS` (recommend 100 000 chars ~25 KB ASCII — fits within Anthropic's context budget without an outsized single-turn token bill).
  3. Same length cap for `model` (max 64 chars; it's a model id, not free text).
- **Required for Sprint 6.** Trivial to implement; high payoff.

### 1.5 No max iterations / max tokens / max tool calls per run (HIGH)

- **Files:** `packages/runtime/src/handler.ts:140-220`, `packages/runtime/src/planner.ts`, `packages/runtime/src/executor.ts`
- **What's wrong:** The handler accumulates `tokensIn`/`tokensOut`/`cost` but never short-circuits when a budget is exceeded. The planner can produce a 200-task graph and the executor will faithfully execute all of them in waves. A jailbroken or pathological prompt that drives the LLM into a re-plan loop (via the verifier feedback path at `handler.ts:212-228`) can run unbounded. Anthropic's per-call latency × token cost makes this a real risk for "agent ran for 3 hours and spent $400 on one tenant."
- **Recommended fix:** Add per-run budget constants (configurable per-tenant via `tenant_tools.config` or a new `tenant_budgets` table):
  - `MAX_TASKS_PER_GRAPH = 20`
  - `MAX_TOOL_CALLS_PER_RUN = 30`
  - `MAX_TOKENS_PER_RUN = 100_000` (sum of in+out across all LLM calls)
  - `MAX_COST_PER_RUN = 1.00` (USD; computed from token counts × model rate card)
  - `MAX_RUN_WALL_TIME_MS = 45_000` (4 s under Supabase's 50 s hard cap so the SSE stream finishes flushing the `error` event)
  After each `addUsage()` call in `handler.ts`, check the running total; if any cap is exceeded, emit `{type: "error", message: "run budget exceeded"}`, mark the run `failed`, and stop. Also pass the task-count cap into `planner.ts` and truncate graphs that exceed it.
- **Required for Sprint 6.** Sub-tasks can defer per-tenant configurability to Sprint 7; ship with hard-coded constants first.

### 1.6 No rate limiting anywhere (HIGH — this is the named Sprint 6 deliverable)

- **Files:** `packages/runtime/src/handler.ts` (no rate limit), `supabase/functions/oauth/index.ts` (no rate limit), the OAuth `?action=start` endpoint is especially exposed because it issues a service-role write per call.
- **What's wrong:** Every POST surface is open. See §2 for the design.
- **Required for Sprint 6.**

### 1.7 `oauth_states` accumulates forever (HIGH — this is the named Sprint 6 deliverable)

- **File:** `packages/schema/migrations/0006_oauth_connections.sql:21-28` defines `expires_at default (now() + interval '10 minutes')` but no sweeper deletes expired rows. Combined with §1.3 + lack of rate-limiting on `?action=start`, an attacker can easily insert tens of millions of `oauth_states` rows.
- **Recommended fix:** See §3.

### 1.8 OAuth refresh token re-issue leaks plaintext into Edge Function logs (HIGH)

- **File:** `packages/tools/src/builtins/_connections.ts:107-114`
- **What's wrong:** `refreshTokens()` throws `new Error(\`${provider}: refresh failed ${res.status}: ${text.slice(0, 400)}\`)` where `text` is the verbatim IdP body. Microsoft's identity platform sometimes returns 400/401 bodies that include `error_description` strings echoing parts of the request (the refresh_token in some misconfigurations). That error propagates up via `getConnectionAccessToken` → the tool's `try/catch` in `executor.ts:88-94` → `console.error("agent-handler error:", e)` at `handler.ts:238`. **The refresh token (or worse, the new access token if `parseTokenResponse` succeeded but `update_tenant_connection_tokens` then failed and re-threw) can land in the Supabase function logs.**
- **Recommended fix:**
  1. In `_connections.ts:107-114`, strip the body. Throw only `${provider}: refresh failed ${res.status}` and log the body to a separate, scrub-controlled channel (or not at all — IdP refresh failures are well-known shapes, the status code is enough).
  2. In the same file at line 142-144 (`throw new Error(\`${provider}: failed to persist refreshed tokens: ${error.message}\`)`), `error.message` from supabase-js can include the parameters that were sent. Drop to `${provider}: failed to persist refreshed tokens`.
  3. Audit every `console.error` in the runtime for the same pattern. The `e instanceof Error ? e.message : String(e)` at `handler.ts:240-241` stores the raw error message into `runError` which gets written to `agent_runs.error` — a Supabase row queryable by anyone with service_role. Sanitize before persisting.
- **Required for Sprint 6.**

### 1.9 `store_tenant_connection` cannot re-connect the same (tenant, provider, label) (HIGH bug, not strictly security)

- **File:** `packages/schema/migrations/0006_oauth_connections.sql:67-74`
- **What's wrong:** On re-connect, the function attempts `vault.create_secret(p_access_token, v_access_name, '')` where `v_access_name = 'agent-core:conn:<t>:<p>:<l>:access'`. Supabase Vault enforces unique names; the second insert raises and aborts the whole RPC. The ON CONFLICT branch never runs because the failure happens before the `insert into tenant_connections`. So if a tenant ever re-authorizes HubSpot, the entire callback errors out — no token rotation possible through the documented path.
- **Recommended fix:** Mirror the pattern from `update_tenant_connection_tokens` (line 162-163) — suffix the vault name with a uniqueness token. Use `gen_random_uuid()::text` rather than `extract(epoch from now())::bigint` to avoid the 1-second collision window (see §1.10). Also: explicitly delete the old vault secret (looked up via `tenant_connections.secret_ref` before update) so this doesn't compound the leak in §1.11.
- **Required for Sprint 6.** (This is also "security hygiene" because the only path the rotation flow exposes today is "manually delete the connection row, then re-connect" — which the host app most likely doesn't surface.)

### 1.10 `update_tenant_connection_tokens` uses epoch-second uniqueness (MEDIUM)

- **File:** `packages/schema/migrations/0006_oauth_connections.sql:162-163`
- **What's wrong:** `extract(epoch from now())::bigint` is collision-prone if two refreshes happen in the same second (concurrent agent runs racing the same expired token). Vault rejects the duplicate name and the RPC errors out. Race window is real for high-throughput tenants.
- **Recommended fix:** Use `gen_random_uuid()::text` for the suffix. Cheap, collision-free.

### 1.11 Old Vault secrets leak forever (MEDIUM)

- **Files:** `packages/schema/migrations/0002_credential_resolution.sql:23-33` (`store_tenant_credential` ON CONFLICT path) and `packages/schema/migrations/0006_oauth_connections.sql` (both `store_tenant_connection` and `update_tenant_connection_tokens`).
- **What's wrong:** Every credential rotation creates a NEW `vault.secrets` row and updates the pointer, but never DELETEs the old row. After 12 months of monthly OAuth refresh × 50 tenants × 2 providers × 2 (access+refresh), that's `12 × 50 × 2 × 2 = 2400` stale, decryptable secrets sitting in vault. The comment at 0002:18-20 even admits "explicit rotation/cleanup will come in a later migration" — that later migration is Sprint 6.
- **Recommended fix:** Before overwriting `secret_ref` (or `refresh_secret_ref`), capture the old uuid and `delete from vault.secrets where id = v_old_id`. Wrap in `if v_old_id is not null then …` so first-time inserts are no-op.

### 1.12 `current_tenant()` lacks explicit `search_path` (LOW)

- **File:** `packages/schema/migrations/0001_agent_core.sql:74-78`
- **What's wrong:** The function does call `auth.jwt()` schema-qualified, so the immediate function-resolution attack isn't possible. But the function itself is `language sql stable` with no `set search_path`. Anything it eventually calls transitively (today, just `nullif`/cast operators — all in `pg_catalog`) inherits the caller's search_path. This is a defense-in-depth gap; not currently exploitable, but cheap to pin.
- **Recommended fix:** Add `set search_path = pg_catalog, auth` to `current_tenant()`. Same hardening pass for any other SQL/PLPGSQL helper without explicit search_path.

### 1.13 Service-role context check missing on read_tenant_table caller (LOW design note)

- **File:** `packages/schema/migrations/0004_read_only_query_path.sql:1-108`
- **What's wrong:** The function is SECURITY DEFINER and trusts `p_tenant` as-passed. Only `service_role` is supposed to call it (revoke/grant lines at 105-107 — though see §1.2!), but the function itself has no `if current_setting('role') != 'service_role' then raise` belt-and-suspenders. So if any future code path hands EXECUTE to a non-service-role caller (as 0007 in fact does today, §1.2), it's a blank check.
- **Recommended fix:** Add a session-role check inside the function: `if not pg_has_role(session_user, 'service_role', 'member') then raise exception 'read_tenant_table: caller must be service_role'; end if;`. Same hardening for `store_tenant_credential`, `resolve_tenant_secret`, `store_tenant_connection`, `resolve_tenant_connection`, `update_tenant_connection_tokens`, `store_artifact`, `list_artifacts`.

### 1.14 `artifacts.storage_path` guard is incomplete (MEDIUM)

- **File:** `packages/schema/migrations/0003_artifacts_storage.sql:57-62`
- **What's wrong:** The guard `if p_storage_path !~ ('^' || p_tenant::text || '/[^/]') then` is good — it pins the path to `<tenant>/<segment>`. The `..` segment check is also good. But:
  1. There's no check on backslash (`\`), URL-encoded traversal (`%2e%2e`), or Unicode normalization tricks. Supabase Storage decodes URL-encoded paths server-side, so `%2e%2e` could become `..` after the regex passes.
  2. There's no leading `/` rejection — Supabase Storage object keys with leading slashes have subtle bucket-routing behaviors.
  3. No length cap beyond the `512`-char column constraint.
- **Recommended fix:**
  ```sql
  if p_storage_path ~ '\\' then raise exception 'storage_path may not contain backslashes'; end if;
  if p_storage_path ~ '%2[eE]' or p_storage_path ~ '%2[fF]' then raise exception 'storage_path may not contain url-encoded path separators'; end if;
  if p_storage_path ~ '․' or p_storage_path ~ '．' then raise exception 'storage_path may not contain unicode lookalike dots'; end if;
  if substr(p_storage_path, 1, 1) = '/' then raise exception 'storage_path may not begin with /'; end if;
  ```
  Wrap the existing checks plus these into a `agent_core._validate_storage_path(uuid, text)` helper so the rules live in one place.

### 1.15 No bucket-level RLS for artifacts is documented (HIGH — verify-in-impl)

- **Files:** `docs/install-runbook.md` (no mention of bucket creation), `cli/install.sh` (no bucket creation step).
- **What's wrong:** Migration 0003 creates the `artifacts` *pointer* table with RLS, but explicitly defers bucket creation + bucket RLS policies to the operator. The installer never creates a bucket; the runbook never tells the operator to create one. Plausible outcomes when an artifact is first written: (a) silent upload failure leaving an orphan row, (b) operator creates a public bucket out of frustration → every tenant's artifacts world-readable.
- **Recommended fix:** Add a `step 8.5` to `install.sh` that creates a private bucket named `agent-core-artifacts` (or `agent-core-${TENANT_SLUG}`) and applies bucket-level RLS policies that mirror the `tenant_isolation` policy on the metadata table: object key must begin with `<tenant_uuid>/` and the caller's JWT must carry the matching `tenant_id`. Document the policy SQL in the runbook so operators can audit it. Mark as **verify-in-impl** — the runtime side that uploads bytes should be inspected (this audit did not find an upload caller in the runtime).

### 1.16 `http_request` tool has no SSRF protection (HIGH if enabled per-tenant)

- **File:** `packages/tools/src/builtins/http-request.ts:1-16`
- **What's wrong:** 16-line tool. It will fetch any URL the planner picks. There's no allowlist, no scheme restriction, no body size cap, no timeout. An LLM-generated input of `http://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS metadata service) or `http://supabase-internal.svc:5432/` (whatever internal service is in the Deno Deploy network) will be hit and the response body returned to the planner. The 8 000-char slice helps, but only as belated mitigation.
- **Recommended fix:**
  1. Drop `http_request` from the default registry shipped via `builtins`. If a tenant needs it, register a tighter variant explicitly.
  2. If kept, add: (a) scheme allowlist (`https:` only), (b) host allowlist or block-list for RFC-1918, loopback, link-local, IPv6 ULA; (c) `AbortSignal.timeout(15_000)`; (d) response-byte cap before `text()`; (e) reject redirects to disallowed hosts.

### 1.17 `m365_mail` send has no per-run / per-tenant send cap (MEDIUM)

- **File:** `packages/tools/src/builtins/m365-mail.ts:139-178`
- **What's wrong:** A planner could decide to send N emails. Combined with no per-run tool-call cap (§1.5), this is an outbound-spam vector. M365's own throttling will catch egregious abuse but only after the cost has been paid in reputation.
- **Recommended fix:** Add `MAX_SEND_PER_RUN = 3` enforced inside the tool, counted via a `ctx`-scoped counter (requires extending `ToolRunContext` with a mutable counter map). Reject the 4th send with a clear error.

### 1.18 Persistence writes the raw user message to `agent_messages.content` (DESIGN NOTE)

- **File:** `packages/runtime/src/persistence.ts:67-75`, called from `handler.ts:165-172`
- **What's wrong:** Not strictly a defect — the system is supposed to remember conversations. But if a user pastes a credit card number, an API key, or HIPAA-regulated content into the chat, it lives in `agent_messages.content` (jsonb) until the row is deleted. There's no retention policy and no redaction layer.
- **Recommended fix:** Out of scope for Sprint 6, but add the design hook: §4 (audit log) should sit alongside a separate `agent_core.retention_policy` table so operators can wipe `agent_messages` older than N days. Sprint 7 candidate.

### 1.19 Persistence writes the JWT-derived `tenantId` and the resolved model into `agent_runs` — no secret echo found (SAFE)

- **Files:** `packages/runtime/src/persistence.ts:61-77`, `packages/runtime/src/handler.ts:159-167`
- **What I checked:** The `recordRunStart` call writes `tenant_id`, `model`, `model_provider`, `status`, plus the user's `userMessage`. Crucially **it does NOT write `ctx.apiKey`** anywhere. Spot-checked: `RunContext.apiKey` is only read by `model.ts` (the LLM caller) and never serialized into events, persistence, or error messages.
- **No fix needed**; explicitly noting this so the orchestrator can confirm.

### 1.20 SSE events do not leak secrets (SAFE)

- **File:** `packages/runtime/src/events.ts:7-29`
- **What I checked:** The `AgentEvent` union includes `tool_start.input`, `tool_end.output`, `tool_end.error`, and `final.result`. `input` and `output` could in theory carry a secret if a tool received one — but the tools that handle secrets (`_connections.ts`, `data-query.ts`, `context.ts`) never accept secrets as input nor return them as output. The `error` field could carry sanitized provider error text; see §1.8 about logging the same.
- **No fix needed at the event-shape level.** Sanitization is per-emitter (§1.8).

### 1.21 `data_query` SQL injection surface — vetted, safe (SAFE)

- **File:** `packages/tools/src/builtins/data-query.ts:117-167`
- **What I checked:**
  1. `table` is matched against `TABLE_COLUMNS` keys (static allowlist) → safe.
  2. `columns` are validated against the `IDENT` regex AND the per-table allowlist → safe.
  3. `filters` keys go through the same two gates → safe.
  4. `filter` values are runtime-typeof'd to `string | number | boolean` → safe (supabase-js URL-encodes them in PostgREST query strings).
  5. `tenant_id` is forbidden as a caller filter and injected from `ctx.tenantId` server-side → safe.
  6. `tenantId = String(ctx?.tenantId ?? "")` — string-cast prevents accidental object injection → safe.
- **No SQL injection.** Excellent existing posture.

### 1.22 `read_tenant_table` (migration 0004) SQL injection — vetted, safe (SAFE)

- **File:** `packages/schema/migrations/0004_read_only_query_path.sql`
- **What I checked:** Uses `format('%I = %L', ident, value)` for filter clauses, IDENT regex on every column, static table allowlist, parameterized tenant via `format('… where tenant_id = %L', p_tenant::text)`. `%I` and `%L` are PostgreSQL's identifier-quoting and literal-quoting format specifiers and are injection-proof when used correctly here. The `created_at` ORDER BY is hardcoded.
- **No SQL injection.**

### 1.23 OAuth state generation/consumption — race-condition vetted (SAFE)

- **Files:** `packages/runtime/src/oauth.ts:73-79` (`generateState` — 32 random bytes, collision-resistant), `supabase/functions/oauth/index.ts:158-171` (`handleCallback`)
- **What I checked:** State is consumed via `delete().eq("state", state).select(…)` which is atomic per-row in Postgres. Concurrent callbacks racing the same state see exactly one win; the loser gets an empty result and a clean "invalid or expired state" 400. No TOCTOU.
- **No fix needed.**

### 1.24 Wildcard CORS on agent and OAuth endpoints (MEDIUM)

- **Files:** `packages/runtime/src/handler.ts:21-25`, `supabase/functions/oauth/index.ts:36-40`
- **What's wrong:** `access-control-allow-origin: *` allows any origin to issue cross-site POSTs. Today Supabase JWT validation gates this — without a valid JWT, the call doesn't reach the handler. But once auth is fixed (§1.1), CORS becomes the next layer; a malicious site embedded in a victim user's browser can issue cross-origin POSTs carrying the victim's JWT cookie.
- **Recommended fix:** Echo an explicit allowlist of origins from a per-tenant `tenant_settings.allowed_origins` array. Reject other origins. Compute the right `access-control-allow-origin` per request rather than the wildcard. (Note: Supabase JWT lives in `Authorization` header, not cookies, so the cross-site cookie attack doesn't directly apply — but this still tightens the perimeter.)

### 1.25 OAuth Edge Function is not deployed by install.sh (HIGH — operational)

- **Files:** `cli/install.sh:230-260` (only deploys `agent`), `supabase/functions/oauth/index.ts` exists but is never copied or deployed.
- **What's wrong:** The OAuth code exists in the agent-core repo but the installer never deploys it into the target Supabase project. The runbook doesn't mention manual deployment either. So no client install currently has a working OAuth function — meaning the connected tools (`hubspot_query`, `m365_mail`) cannot have been used end-to-end on any installed tenant.
- **Recommended fix:** Add a `step 8.5` to `install.sh` that copies `supabase/functions/oauth/index.ts` into the target repo and runs `supabase functions deploy oauth`. Update the runbook accordingly. (This is "scope creep for Sprint 6 hardening" but it touches the OAuth surface area we're securing — worth noting and possibly bundling.)

---

## 2. Rate-limiting design

### 2.A Goals

- Protect the agent endpoint from runaway loops and abusive clients.
- Protect tenant API-key budgets (Anthropic charges per call).
- Protect the database / Vault from OAuth-state spam.
- Surface clear `429` with `Retry-After` so well-behaved clients back off.
- Operator override (kill switch + global bypass) for incident response.

### 2.B Limit dimensions

| Dimension | Limit | Window | Why |
|---|---|---|---|
| Per-tenant runs | 60 | 1 min | Smooths bursty UI usage from a busy office; ~1 run/sec average. |
| Per-tenant runs | 1 000 | 1 hour | Catches sustained abuse before billing damage. |
| Per-tenant runs | 5 000 | 1 day | Final daily safety net. |
| Per-user (JWT sub) runs | 20 | 1 min | Stops one user from monopolizing tenant budget. |
| Per-user runs | 200 | 1 hour | Daily-driver soft cap. |
| Per-IP (CF-Connecting-IP / X-Forwarded-For) | 30 | 1 min | Protects pre-auth surfaces (preflight); secondary defense post-auth. |
| OAuth `?action=start` per-IP | 5 | 1 min | Stops `oauth_states` table-spam DoS (§1.6). |
| OAuth `?action=start` per-tenant | 20 | 1 hour | Operator-side abuse cap. |
| Agent runs in-flight per-tenant | 5 | concurrent | Hard ceiling on simultaneous active SSE streams. |

All numbers configurable per tenant via a new `agent_core.tenant_rate_limits` row; defaults shipped in migration `0009_rate_limits.sql`.

### 2.C Storage backend — decision matrix

| Option | Latency | Ops cost | Multi-instance correctness | Sprint 6 fit |
|---|---|---|---|---|
| Postgres table `agent_core.rate_limit_events` + `delete where created_at < now() - interval '1 day'` cron | 5–15 ms per check (single SELECT count + INSERT) | Free (uses existing DB) | Strong — single source of truth | ✅ Recommended |
| `upstash/redis` over HTTPS (REST) | 10–40 ms (network hop) | $10–40/mo per tenant, plus secret storage | Strong with atomic INCR | ❌ New dependency, new secret to store per install |
| In-memory Map in the Edge Function | <1 ms | Free | **Broken** — Deno Deploy spawns isolates per region; each has its own Map | ❌ Correctness fail |
| Cloudflare Durable Object | <5 ms | New infra (we're Supabase-only today) | Strong | ❌ Out of stack |
| Supabase Realtime Channels for distributed counters | 50+ ms | Already deployed | Brittle (channels weren't designed for counters) | ❌ Wrong tool |

**Recommendation:** **Postgres table.** A library that drops new dependencies on every install repo (CCS-style — install once, never touch) cannot ask operators to provision Redis. Postgres is already there, RLS already there, performance is fine for our run volume (low-thousand RPS sustained on a Supabase Free-tier db is non-trivial).

### 2.D Algorithm — decision matrix

| Algorithm | Pros | Cons | Sprint 6 fit |
|---|---|---|---|
| **Fixed window** | Trivial (one INSERT, one COUNT WHERE bucket = floor(now()/window)). Easy to debug. | Boundary burst — 60 calls at :59 + 60 at :00 = 120 in 1s. | ❌ Burstiness real with our concurrency goals |
| **Sliding window log** | Exact. INSERT one row per call, COUNT in [now-window, now]. | Storage grows with traffic; needs the sweeper. | ✅ Recommended for per-tenant + per-user |
| **Token bucket** | Smooth burst handling. | Needs stateful row with refill_at, refill_rate; more moving parts. | ⚠️ Slight overkill |
| **Leaky bucket** | Smooth output rate. | Same complexity as token bucket. | ⚠️ Slight overkill |
| **Sliding window counter (approximate)** | Tiny storage (2 buckets per window per key). | ~10% approximation error. | ✅ Recommended for per-IP (where exactness doesn't matter) |

**Recommendation:** **Sliding window log** for per-tenant and per-user (we want them exact — billing implications). **Sliding window counter (2-bucket approximation)** for per-IP because IP is just a noisy abuse filter, not a billing key.

### 2.E Schema sketch

```sql
-- 0009_rate_limits.sql
create table agent_core.rate_limit_events (
  id          bigserial primary key,
  tenant_id   uuid,
  user_id     uuid,                            -- nullable (anon flows)
  ip          inet,                            -- nullable (internal calls)
  kind        text not null check (kind in (
                'agent_run','oauth_start','oauth_callback')),
  created_at  timestamptz not null default now()
);

create index idx_rate_limit_tenant_kind_time
  on agent_core.rate_limit_events(tenant_id, kind, created_at desc);
create index idx_rate_limit_user_kind_time
  on agent_core.rate_limit_events(user_id, kind, created_at desc)
  where user_id is not null;
create index idx_rate_limit_ip_kind_time
  on agent_core.rate_limit_events(ip, kind, created_at desc)
  where ip is not null;

-- Concurrent in-flight tracking — separate table because it has lifecycle
-- (insert on run start, delete on run end), not append-and-sweep semantics.
create table agent_core.in_flight_runs (
  run_id     uuid primary key,
  tenant_id  uuid not null,
  user_id    uuid,
  started_at timestamptz not null default now()
);
create index idx_in_flight_runs_tenant on agent_core.in_flight_runs(tenant_id);

create table agent_core.tenant_rate_limits (
  tenant_id        uuid primary key references agent_core.tenants(id) on delete cascade,
  runs_per_minute  int not null default 60,
  runs_per_hour    int not null default 1000,
  runs_per_day     int not null default 5000,
  max_concurrent   int not null default 5,
  paused           boolean not null default false,           -- kill switch
  notes            text
);
```

`rate_limit_events` is high-churn; the sweeper (§3 — reuse same cron mechanism) deletes rows where `created_at < now() - interval '25 hours'` every 5 min.

### 2.F Check function

A single SECURITY DEFINER RPC `agent_core.check_and_record_rate_limit(p_tenant uuid, p_user uuid, p_ip inet, p_kind text)` does all checks atomically (one transaction, advisory lock keyed on tenant_id so concurrent runs don't double-spend the budget), inserts the event if allowed, returns `{allowed: bool, retry_after_seconds: int, limit: text, current: int}`. Grant EXECUTE only to service_role.

### 2.G 429 response shape

```json
{
  "error": "rate_limited",
  "limit": "runs_per_minute",
  "retry_after_seconds": 23,
  "tenant_id": "<uuid>"
}
```

Plus header: `Retry-After: 23` (seconds). For SSE this means: validate rate limit BEFORE opening the stream (same place we validate JSON body) and return JSON 429 — never start a stream we're going to abort.

### 2.H Kill switch / bypass

- **Per-tenant pause:** `tenant_rate_limits.paused = true` → handler returns 503 with `Retry-After: 3600` and `{error: "tenant_paused", reason: <notes>}`. No run cost incurred. (Doubles as the "abuse prevention" pause-toggle in §6.)
- **Global kill switch:** env var `AGENT_CORE_KILL = "1"` checked first in handler → 503 immediately. Set via `supabase secrets set` for incident response.
- **Per-tenant override (raise limits temporarily):** edit `tenant_rate_limits` row directly. Audit-logged via §4.

### 2.I Where it runs

Both `handler.ts` (immediately after JWT validation, before context load) and `supabase/functions/oauth/index.ts handleStart` (immediately after tenant_id extraction). Single helper `checkRateLimit(supabase, key, kind)` shared via a new module `packages/runtime/src/rate-limit.ts`.

### 2.J Test plan

- Unit test the algorithm (fake clock).
- Integration test against a real Supabase: hammer the endpoint with 70 calls/min, assert exactly 10 get 429 with `Retry-After` between 0–60.
- Verify the global kill switch returns 503 before any DB work.

---

## 3. OAuth states sweeper

### 3.A Options matrix

| Option | Pros | Cons | Sprint 6 fit |
|---|---|---|---|
| **pg_cron** (Supabase-supported extension) | Lives in the same DB as the table; no external infra; survives Edge Function restarts; runs even when no traffic; visible to operator via `cron.job` view | Requires extension enable (one-time per project, similar to vault) | ✅ **Recommended** |
| Supabase Scheduled Edge Function | Native to the platform; no extension | Runs as service_role, costs an invocation; ops layer (logs go to Edge Function dashboard, not DB); cron syntax is JSON config | ⚠️ Acceptable fallback |
| External Vercel/GitHub Actions cron hitting an Edge Function | Trivial to set up | Adds a cross-platform dependency that defeats the "library, not service" install model; need to authenticate the cron caller | ❌ Wrong architecture |
| Manual TTL via `delete where expires_at < now()` on every `?action=start` insert | Zero extra infra | Self-throttled (sweeps only when there's traffic); attacker who stops calling stops sweeping — leaves the rows forever | ❌ Reliability fail |

**Recommendation:** **pg_cron.**

### 3.B Frequency

Every **5 minutes**. Window = `expires_at + 1 minute` slack (so an in-flight callback doesn't get its row swept mid-flow):

```sql
delete from agent_core.oauth_states
where expires_at < now() - interval '1 minute';
```

5 min is a good balance:
- Worst-case 5 minutes of accumulation between sweeps × even an attacker hitting `?action=start` at the rate-limited cap (5/IP/min from a single IP, post-§2) = ~25 rows. Trivially manageable.
- 5-minute sweeps mean operators see `pg_cron.job_run_details` activity often enough to notice failures.

Same cron job also sweeps `rate_limit_events` older than 25 hours (one cron, two DELETEs in one transaction).

### 3.C Migration vs install.sh

**Migration.** New `packages/schema/migrations/0010_oauth_sweeper.sql`:

```sql
-- pg_cron is enabled per-project from the dashboard. Detect and no-op if missing
-- so this migration is safe to re-apply (idempotent) even before extension enable.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'agent_core_sweeper',
      '*/5 * * * *',
      $cmd$
        delete from agent_core.oauth_states
         where expires_at < now() - interval '1 minute';
        delete from agent_core.rate_limit_events
         where created_at < now() - interval '25 hours';
        delete from agent_core.in_flight_runs
         where started_at < now() - interval '1 hour';
      $cmd$
    );
  else
    raise notice 'pg_cron not installed; sweeper schedule skipped. Enable extension and re-run.';
  end if;
end $$;
```

Add a preflight check to `install.sh` that warns if `pg_cron` isn't enabled (mirroring the existing `supabase_vault` check at `docs/install-runbook.md` line 8 and `cli/preflight.sh`). Update the runbook with a one-liner: "Enable the `pg_cron` extension in Database > Extensions before running install."

The `in_flight_runs` sweep is a safety net for handler crashes — if the handler dies mid-run, the row would otherwise leak.

---

## 4. Audit logging

### 4.A Yes — add `agent_core.audit_log`

```sql
-- 0011_audit_log.sql
create table agent_core.audit_log (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  tenant_id    uuid,                              -- nullable for cross-tenant ops
  actor_id     uuid,                              -- jwt sub of caller, if known
  actor_role   text,                              -- 'service_role' | 'authenticated' | 'system'
  ip           inet,
  event_kind   text not null,                     -- enum-ish; checked
  target_kind  text,                              -- 'credential', 'connection', 'tool', etc.
  target_id    text,
  details      jsonb not null default '{}',       -- structured event-specific data
  severity     text not null default 'info'       -- 'info' | 'warn' | 'security'
                 check (severity in ('info','warn','security'))
);
create index idx_audit_log_tenant_ts on agent_core.audit_log(tenant_id, ts desc);
create index idx_audit_log_security_ts on agent_core.audit_log(ts desc)
  where severity = 'security';

alter table agent_core.audit_log enable row level security;
-- Tenant admins read their own tenant's events:
create policy audit_log_tenant_read on agent_core.audit_log
  for select using (tenant_id = agent_core.current_tenant());
-- Service role inserts via SECURITY DEFINER agent_core.write_audit_log(...).
```

### 4.B Events to log

| Event kind | Severity | Source |
|---|---|---|
| `credential.rotated` | security | `store_tenant_credential` |
| `credential.read` | info | `resolve_tenant_secret` (sampled — every call is too noisy; log first per minute per tenant) |
| `connection.created` | security | `store_tenant_connection` |
| `connection.refreshed` | info | `update_tenant_connection_tokens` |
| `connection.revoked` | security | new RPC `revoke_tenant_connection` |
| `tool.toggled` | info | new RPC for `tenant_tools.enabled` flip |
| `admin.tenant_paused` | security | `tenant_rate_limits.paused` flip |
| `admin.rate_limit_changed` | security | `tenant_rate_limits` update |
| `rate_limit.triggered` | warn | rate-limit check function — only log denials |
| `rls.denial` | security | difficult — Postgres doesn't natively log RLS denials. Skip for v1; revisit if Sprint 7 adds a JWT-side wrapper |
| `oauth.state_consumed` | info | callback handler |
| `oauth.callback_failed` | warn | callback handler |
| `run.budget_exceeded` | warn | handler when §1.5 kicks in |
| `run.error` | warn | handler `finally` block |

### 4.C Retention

- `security` rows: 365 days.
- `warn` rows: 90 days.
- `info` rows: 30 days.

The sweeper from §3 grows a third DELETE that prunes by severity bucket.

### 4.D Querying surface

Out of scope for Sprint 6 to build a UI, but design with a future admin shell in mind: expose a SECURITY DEFINER RPC `agent_core.read_audit_log(p_tenant uuid, p_since timestamptz, p_severity text default null, p_limit int default 100)` with the same allowlist/parameterization pattern as `read_tenant_table` (§1.22). Grant EXECUTE to `service_role` only — admin UI calls it server-side.

---

## 5. Secret hygiene

### 5.A Vault key rotation (operator's responsibility, not ours)

Supabase Vault encrypts secrets at rest with a project-scoped key managed by the Supabase platform. Rotating that key is a Supabase-side operation (currently undocumented to end users; Supabase manages it transparently for the managed-DB tier). **Operator responsibility:** none day-to-day; if Supabase publishes a key-rotation procedure, follow it. **Our responsibility:** document that the operator must back up their database (Step 1 of the runbook already covers this) before any Vault-related operation.

### 5.B Tenant-level key rotation (e.g., Anthropic key compromise) — design

Today's flow forces overwrite via `store_tenant_credential` and stale Vault rows leak forever (§1.11). New flow:

1. **Operator UI:** "Rotate Anthropic key" button collects new key.
2. **Calls a new RPC** `agent_core.rotate_tenant_credential(p_tenant, p_provider, p_new_secret)`:
   - Begins transaction.
   - Captures `v_old_secret_ref` from `tenant_credentials`.
   - Creates new vault secret.
   - Updates `tenant_credentials.secret_ref`.
   - **Deletes** old `vault.secrets` row.
   - Writes `audit_log: credential.rotated`.
   - Commits.
3. **No downtime:** in-flight runs continue to use whatever key their `loadTenantContext` already resolved (RunContext is captured at handler start). Future runs pick up the new key.
4. **Optional advisory:** emit a notification to all currently-in-flight runs (write to a `pg_notify` channel that the runtime listens on for a "tenant credential rotated" advisory) so they can fail fast on the next LLM call rather than after a 429 from Anthropic when the old key is revoked.

### 5.C Secret echo audit — places a secret could leak

| Location | Status |
|---|---|
| SSE event stream | ✅ Audited — events.ts shape excludes raw secrets; tool inputs/outputs do not carry tenant API keys |
| `agent_runs.error` column | ⚠️ §1.8 — sanitize before `finalizeRun` writes `runError` |
| Edge Function `console.error` calls | ⚠️ §1.8 — three call sites need scrubbing |
| `agent_messages.content` | ✅ Audited — only role/content/usage. No api key fields. |
| `tenant_credentials.meta` | ⚠️ See §5.D below |
| HTML success page after OAuth | ✅ §oauth/index.ts:217 — only `provider` and `account_label` go in, both regex-stripped |
| Vault `name` column | ℹ️ Names include tenant/provider/label (not secret material) — visible to anyone with vault schema access (= service role) — fine |
| Error messages thrown from `loadTenantContext` | ⚠️ The throw at `context.ts:96-98` says `tenant ${tenantId} has no '${desired}' credential for model '${model}'` — fine, no secret. |

### 5.D `tenant_credentials.meta` and `tenant_connections.meta` jsonb risk

Both columns are operator-writable jsonb with no schema enforcement. A future caller could `meta = '{"backup_key": "<plaintext>"}'`. RLS protects from non-service-role reads (post-§1.2 fix), but service-role consumers and any future admin UI would see it.

**Recommendation:** Add a CHECK constraint that rejects any jsonb that contains a key matching `/(?i)(secret|key|token|password|bearer|authorization|credential)/` at the top level. Crude but catches the obvious mistake:

```sql
alter table agent_core.tenant_credentials
  add constraint meta_no_secrets check (
    not (meta::text ~* '(secret|key|token|password|bearer|authorization|credential)'
         and meta::text not in ('{}','null'))
  );
```

Document the constraint and recommend that meta only holds rate-card metadata, scope labels, and provider-side IDs.

### 5.E `oauth_states.code_verifier` lives in plaintext in the table for up to 10 minutes

The code verifier is a PKCE secret; it's not Vault-encrypted. The 10-minute TTL plus RLS plus (post-Sprint-6) per-IP rate limit on `?action=start` are all that protects it. **No action needed for Sprint 6** — the threat model assumes service_role compromise = full game over, and this column isn't the easiest target. Document the risk in §5 of the runbook so anyone who later proposes "let's keep states for an hour" is forced to confront it.

---

## 6. Abuse prevention

Concrete caps to ship in Sprint 6 (all in `packages/runtime/src/constants.ts` or a new `limits.ts`, configurable per-tenant via `tenant_rate_limits.config` jsonb in Sprint 7):

| Cap | Value | Where enforced |
|---|---|---|
| Max request body bytes | **256 KB** | handler.ts before JSON parse |
| Max `message` string length | **100 000 chars** | handler.ts after JSON parse |
| Max `model` string length | **64 chars** | handler.ts after JSON parse |
| Max tokens per run (in+out across all LLM calls) | **100 000** | handler.ts after each `addUsage` |
| Max cost per run (USD) | **$1.00** | same place |
| Max tool calls per run | **30** | executor.ts, increment counter on each `ctx.registry.run` |
| Max tasks per single plan graph | **20** | planner.ts after parsing graph; truncate or fail |
| Max run wall time | **45 000 ms** | handler.ts via `AbortController` + setTimeout |
| Max m365_mail.send per run | **3** | m365-mail.ts via per-run counter |
| Max in-flight runs per tenant | **5** | `in_flight_runs` table from §2.E |
| Per-tenant pause flag | bool | `tenant_rate_limits.paused` → handler returns 503 |
| Global kill switch | env `AGENT_CORE_KILL` | handler returns 503 |

The pause flag doubles as the abuse-response tool: operator sets `paused = true, notes = 'abusive prompt loop detected 2026-05-24'`, and the handler 503s every new request from that tenant. Existing in-flight runs are not interrupted (they'll complete or hit the wall-time cap).

---

## 7. RLS audit

Walked every policy in migrations 0001, 0003, 0006:

### 7.A Policies present

| Table | Policy | USING | WITH CHECK | Notes |
|---|---|---|---|---|
| `tenants` | tenant_isolation | id = current_tenant() | id = current_tenant() | ✅ symmetric |
| `tenant_credentials` | tenant_isolation | tenant_id = current_tenant() | same | ✅ symmetric |
| `tenant_tools` | tenant_isolation | same | same | ✅ symmetric |
| `agent_runs` | tenant_isolation | same | same | ✅ symmetric |
| `agent_messages` | tenant_isolation | same | same | ✅ symmetric |
| `artifacts` | tenant_isolation | same | same | ✅ symmetric |
| `tenant_connections` | tenant_isolation | same | same | ✅ symmetric |
| `oauth_states` | tenant_isolation | same | same | ✅ symmetric |

**Symmetry:** every policy applies `for all` (SELECT/INSERT/UPDATE/DELETE) with matched USING and WITH CHECK. No asymmetry — an attacker can't SELECT freely while WITH CHECK blocks writes.

### 7.B Unqualified-function risk

`current_tenant()` calls `auth.jwt()` schema-qualified → safe. The function itself lacks `set search_path` (§1.12 — LOW, hardening recommended).

### 7.C JWT-claim trust

Policies trust `auth.jwt() ->> 'tenant_id'`. This is only as good as Supabase's JWT signature verification. If a customer misconfigures `JWT_SECRET` (e.g., uses the public anon key as the signing secret, copy-paste error during Supabase project setup), an attacker can forge a JWT with arbitrary `tenant_id` and the RLS layer falls open. **Recommendation:** add a `verify-jwt-integrity.ts` script to `packages/schema/scripts/` that asserts:
- `auth.jwks_url` returns a real JWKS endpoint or that the project uses HS256 with a non-default secret length >32 bytes.
- A forged JWT signed with the documented anon key is rejected by a probe endpoint.

(This is operator-misconfig territory; we can't fix it but we can detect it.)

### 7.D Tests that should exist in CI

`packages/schema/scripts/verify-isolation.ts` already exists. Extend it to cover:

1. **Each SECURITY DEFINER function** must return `42501 permission denied` when called as `anon` or `authenticated`. (Today this would fail because of §1.2 — the test is the regression guard.)
2. **Cross-tenant probe:** spin up two tenants A and B, create a row in each, sign a JWT for tenant A, attempt to SELECT / UPDATE / DELETE rows in tenant B — assert empty/denied for each.
3. **`current_tenant()` returns NULL when the JWT lacks the claim** → policies deny everything.
4. **Vault decryption is impossible** from any non-service-role client (direct `select * from vault.decrypted_secrets` must be `42501`).
5. **OAuth flow round-trip:** start → store fake state → callback with a fixture IdP-response server → verify `tenant_connections` row is created and `oauth_states` is empty.

Add a Sprint 6 CI workflow that runs the verify scripts on every PR against a throwaway Supabase project (or use `supabase test db` locally).

---

## 8. Edge Function limits

### 8.A Supabase Edge Function defaults (as of audit date, subject to platform change)

| Limit | Default | Source |
|---|---|---|
| Wall-clock per request | 50 s on Free / 150 s on Pro+ | Supabase docs |
| Memory | 150 MB hard cap | Supabase docs |
| CPU time | 1 s sustained / bursts allowed | Deno Deploy quota model |
| Outbound HTTP concurrency | ~50 simultaneous fetches | Deno Deploy |
| Request body size | ~6 MB | Deno Deploy / Supabase router |
| Response body size | streaming OK, no hard cap | — |
| Cold start | ~50–200 ms when isolate isn't warm | Deno Deploy |

### 8.B Where our handler can hit them

| Concern | Risk | Mitigation |
|---|---|---|
| 50 s wall-time | A 4-stage agent loop (plan + execute + synthesize + critic + correct) calling Anthropic 5× can easily exceed 50 s on Free | §6 soft cap at 45 s + AbortController; recommend operators run on Pro for production tenants |
| Memory cap | Big tool outputs (web_search snippet sums, hubspot bulk reads) accumulate in `done` map in executor.ts | §6 tool-call cap; truncate tool outputs to 32 KB each before persistence |
| CPU burst | JSON.stringify of a large `final` event | Cap the event size — slice/truncate before `emit({type: 'final', result})` |
| Concurrent fetches | Per-wave parallel `Promise.all` in executor.ts:80 — uncapped fan-out | Cap wave size to MAX(5) — easy patch |
| Request body | Already addressed in §1.4 |
| Outbound fetch hangs | `http_request` has no timeout (§1.16) | Per-tool 30 s `AbortSignal.timeout` |

### 8.C Soft timeout strategy

Add an AbortController in `handler.ts` that fires at `45_000 ms` and:
1. Cancels the in-flight LLM/tool fetches that wired up its signal.
2. Sets `runStatus = 'failed'`, `runError = 'soft timeout'`.
3. Emits a final `{type: 'error', message: 'run exceeded time budget'}`.
4. Lets the `finally` block close the stream cleanly.

This guarantees the SSE consumer sees a terminal event instead of a connection drop at the 50 s Supabase boundary.

---

## 9. Sprint 6 priority ranking

### 9.A Must-do (Sprint 6 blockers — cannot ship without)

These are pre-existing security blockers. Rate-limiting work is meaningless without them.

| # | Item | Why |
|---|---|---|
| B1 | **§1.1** — JWT-bind `tenantId` in handler.ts | Without this, any auth user can spend any tenant's API key. |
| B2 | **§1.2** — Re-revoke EXECUTE from `authenticated` on every SECURITY DEFINER function (new migration 0008) | Without this, any auth user can directly RPC-call `resolve_tenant_secret` and exfiltrate every tenant's Anthropic key. |
| B3 | **§1.3** — JWT-bind `tenant_id` in OAuth start handler | Without this, attackers can hijack OAuth connections. |
| B4 | **§1.4** — Payload + message size limits in handler.ts | Cheap, blocks the easiest DoS / cost-runaway. |
| B5 | **§1.5** — Per-run budget caps (tokens, tool calls, wall time) | Blocks the runaway-loop class outright. |
| B6 | **§2** — Rate limiting design implemented (per-tenant + per-user + per-IP) | The named Sprint 6 deliverable. |
| B7 | **§3** — `oauth_states` sweeper via pg_cron (also sweeps rate_limit_events & in_flight_runs) | The named Sprint 6 deliverable, plus the storage backing for B6. |
| B8 | **§1.8** — Secret-leak scrub in `_connections.ts` refresh path and `handler.ts` error logging | Stops refresh tokens from landing in Edge Function logs. |
| B9 | **§1.9** — Fix `store_tenant_connection` vault-name collision on reconnect | Connected-integration flow is broken without this. |
| B10 | **§7.D** — Extend `verify-isolation.ts` to assert RLS + SECURITY DEFINER posture | Regression guard so B2 stays fixed. |

### 9.B Should-do (Sprint 6 nice-to-have)

| Item | Why |
|---|---|
| §1.11 — Old vault secret cleanup on credential rotation | Operational hygiene; can ship two weeks later if Sprint 6 runs long |
| §1.14 — Tighten `storage_path` guard (backslash, url-encoding, unicode) | Defense-in-depth; medium severity |
| §1.10 — Use UUID suffix instead of epoch second in `update_tenant_connection_tokens` | Easy fix; race window is tight but real |
| §1.13 — Add session-role checks inside SECURITY DEFINER bodies | Defense-in-depth pairing with B2 |
| §1.16 — SSRF guard or removal of `http_request` from default builtins | Only matters if tenants enable it — but the default registry currently does |
| §1.17 — m365_mail per-run send cap | Cheap fix, real abuse vector |
| §1.24 — Per-tenant CORS allowlist | Tightens perimeter; only post-B1 is it the next layer to harden |
| §1.25 — install.sh deploys oauth Edge Function | Operational completeness — without this OAuth literally doesn't work in installs |
| §4 — Audit log table + write_audit_log RPC | Needed for incident response; the read RPC and any UI can wait |
| §1.12 — Pin `search_path` on `current_tenant()` and all SECURITY DEFINER helpers | One-line hardening per function |
| §5.D — Add `meta` constraint forbidding secret-shaped keys | Crude but stops the obvious operator footgun |
| §1.15 — Document/install artifacts bucket with RLS | Once an upload path is built (need to verify whether one exists) |

### 9.C Can-defer (Sprint 7+)

| Item | Why deferring is OK |
|---|---|
| §1.18 — `agent_messages` retention policy | Not a security defect; ops feature |
| §5.B — Tenant-level credential rotation UI/RPC | Currently possible via direct migration; UI not blocking |
| §7.D-1 — JWT-misconfig probe script | Operator-side problem; helpful but not on the critical path |
| §8.C — Soft-timeout AbortController plumbing through model.ts and tool fetches | Coarser run-wall-time cap from B5 covers the worst case |
| §4 read-side admin UI | Storage of audit events is what matters; UI follows |
| Per-tenant configurable rate limits (vs. hard-coded constants) | Hard-coded constants for Sprint 6 are fine; per-tenant override via `tenant_rate_limits.paused` already covers incidents |
| Per-tenant CORS allowlist UI | Per-tenant table can be edited via migration for now |

### 9.D Estimated effort

| Bucket | Engineer-days |
|---|---|
| Must-do (B1–B10) | ~6–8 |
| Should-do | ~4–5 |
| Can-defer | ~6+ |

If Sprint 6 only has 5 engineer-days available, ship Must-do only and roll the Should-do list into a half-sprint at the start of Sprint 7. Do NOT slip B2 — it's a one-migration fix with catastrophic consequences if left.

---

## Appendix A — Files audited

| File | Lines | Outcome |
|---|---|---|
| `packages/runtime/src/handler.ts` | 313 | 5 defects (§1.1, 1.4, 1.5, 1.6, 1.24) |
| `packages/runtime/src/context.ts` | 170 | Clean. No defect. |
| `packages/runtime/src/persistence.ts` | 187 | Clean (§1.19 explicit safe). |
| `packages/runtime/src/oauth.ts` | 246 | Clean (helpers only). |
| `packages/runtime/src/events.ts` | 112 | Clean (§1.20 explicit safe). |
| `packages/runtime/src/executor.ts` | 122 | §1.5 (no cap on wave fan-out or total calls). |
| `packages/runtime/src/planner.ts` | 51 | §1.5 (no cap on graph size). |
| `packages/runtime/src/__tests__/oauth.test.ts` | 211 | Test coverage of helper functions only; no end-to-end OAuth/callback test exists yet (recommendation §7.D-5). |
| `packages/tools/src/builtins/data-query.ts` | 179 | Clean (§1.21 explicit safe). |
| `packages/tools/src/builtins/_connections.ts` | 191 | §1.8 (secret-leak in error paths). |
| `packages/tools/src/builtins/doc-generate.ts` | 68 | Clean. |
| `packages/tools/src/builtins/http-request.ts` | 16 | §1.16 (SSRF + no timeout). |
| `packages/tools/src/builtins/hubspot-query.ts` | 165 | Clean (depends on §1.3 fix for connection integrity). |
| `packages/tools/src/builtins/m365-mail.ts` | 180 | §1.17 (no send cap). |
| `packages/tools/src/builtins/web-search.ts` | 111 | Clean. |
| `packages/schema/migrations/0001_agent_core.sql` | 91 | §1.12 (pin search_path on `current_tenant`). |
| `packages/schema/migrations/0002_credential_resolution.sql` | 72 | §1.11 (vault leak), §1.13 (no role check). |
| `packages/schema/migrations/0003_artifacts_storage.sql` | 119 | §1.14 (storage_path guard), §1.15 (no bucket RLS documented). |
| `packages/schema/migrations/0004_read_only_query_path.sql` | 108 | §1.13 (no role check). SQL injection: §1.22 explicit safe. |
| `packages/schema/migrations/0005_run_lifecycle.sql` | 27 | Clean. |
| `packages/schema/migrations/0006_oauth_connections.sql` | 192 | §1.9 (reconnect bug), §1.10 (epoch suffix race), §1.11 (vault leak), §1.13 (no role check). |
| `packages/schema/migrations/0007_agent_core_grants.sql` | 49 | **§1.2 BLOCKER** (overrides earlier revokes). |
| `supabase/functions/oauth/index.ts` | 271 | §1.3 BLOCKER, §1.24, §1.25. |
| `cli/install.sh` | 508 | §1.25 (doesn't deploy oauth function or create bucket). |
| `docs/install-runbook.md` | 61 | §1.15 (no bucket guidance), §1.25 (no oauth deploy step), §3.C (no `pg_cron` extension enable). |

---

## Appendix B — New files / migrations to be created in Sprint 6

| Path | Purpose |
|---|---|
| `packages/schema/migrations/0008_revoke_definer_execute.sql` | B2 — explicit REVOKE on every SECURITY DEFINER function from authenticated/anon. |
| `packages/schema/migrations/0009_rate_limits.sql` | B6 — rate_limit_events, in_flight_runs, tenant_rate_limits, check_and_record_rate_limit RPC. |
| `packages/schema/migrations/0010_oauth_sweeper.sql` | B7 — pg_cron-scheduled sweeper for oauth_states / rate_limit_events / in_flight_runs. |
| `packages/schema/migrations/0011_audit_log.sql` | §4 — audit_log table + write_audit_log RPC. (Should-do.) |
| `packages/runtime/src/auth.ts` | B1 — JWT decode + tenant claim extraction + assertJwtMatchesTenant helper. |
| `packages/runtime/src/rate-limit.ts` | B6 — checkRateLimit helper shared by handler.ts and oauth/index.ts. |
| `packages/runtime/src/limits.ts` | B4/B5 — exported constants (MAX_BODY_BYTES, MAX_MESSAGE_CHARS, MAX_TOKENS_PER_RUN, etc.). |
| `packages/runtime/src/__tests__/rate-limit.test.ts` | Unit + integration coverage for the sliding window. |
| `packages/runtime/src/__tests__/auth.test.ts` | Coverage for JWT validation paths. |
| `packages/schema/scripts/verify-isolation.ts` (extend existing) | B10 — assert RLS + SECURITY DEFINER posture. |

---

## Appendix C — Notes for the orchestrator

Items marked `[verify-in-impl]`:
- **§1.15** — The audit could not find a runtime upload caller for artifacts. The artifacts table is present and gated correctly; whether bytes are ever written, and where, was not visible from the runtime source. Confirm during implementation that either (a) no upload path exists yet (in which case the bucket question is theoretical and Sprint 6 can defer it), or (b) a path exists and needs the bucket/RLS setup recommended.
- **§1.9** — The "vault rejects duplicate names" behavior is the most likely failure mode based on Vault's column constraints, but I did not run the actual reproducer against Supabase. Worth a 10-minute live test before writing the fix.
- **§8.A** — Edge Function limits drift with Supabase's platform; the numbers cited are correct as of the audit date but should be re-checked against current Supabase docs in implementation week.

Items marked **SAFE** in §1 (1.19, 1.20, 1.21, 1.22, 1.23): explicitly noted to head off a future reviewer questioning why they weren't flagged.
