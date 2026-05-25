# Sprint 6 — Metering & Cost Architecture

**Status:** Design proposal · awaiting orchestrator review
**Author:** JARVIS (design role)
**Date:** 2026-05-24
**Scope:** The "Metering" slice of Sprint 6 (admin and hardening are sibling design tracks)
**Repo:** `blackrock-agent-core`
**Target migrations:** `0008`–`0010` (follows existing `0007_agent_core_grants.sql`)

---

## 0. TL;DR — recommended approach

1. **Three new tables, one materialized view, four RPCs.** Source-of-truth is per-LLM-call granularity; everything else is a rollup.
2. **Move model pricing into the database** (`agent_core.model_prices`, effective-dated) so price changes are a SQL update, not a runtime deploy.
3. **Per-LLM-call detail table** (`agent_core.run_llm_calls`) captures every planner/executor/synthesizer/critic call separately. The existing `agent_runs.tokens_in/out/cost_estimate` columns become a denormalized rollup of that detail.
4. **Per-tool invocation detail** (`agent_core.tool_invocations`) — one row per tool call, with optional `external_units` / `external_cost_estimate`. Solves "how many Brave searches did this tenant run this month?" without parsing `agent_messages.content`.
5. **Daily-grain materialized view** (`agent_core.usage_daily`) refreshed nightly by `pg_cron`; RPCs UNION it with same-day live aggregation for accurate real-time dashboards.
6. **Anthropic cache-discount native support** — `cache_read_tokens` / `cache_write_tokens` columns on both `agent_runs` and `run_llm_calls`, fed by `model.ts` reading `cache_creation_input_tokens` / `cache_read_input_tokens` from Anthropic responses.
7. **Tiered retention**: rollups forever, raw runs 2 years, messages/tool detail 90 days (tenant-overridable). Purge job is its own RPC, run nightly by `pg_cron`.
8. **Three migrations**: `0008_metering_pricing.sql` (prices) → `0009_metering_runs.sql` (per-call + tool detail + new columns) → `0010_metering_rollups.sql` (materialized view, RPCs, cron, purge). Each idempotent, schema-quoted, additive.

The headline opinion: **don't try to bill from `agent_runs` alone**. The per-call detail table is what makes per-step cost ("how expensive is our critic?") and multi-provider runs tractable. The cost is one extra `INSERT` per LLM call (4–8 per run) — negligible.

---

## 1. Data Model Decisions

### 1.1 What's already there (verified against `0001`, `0005`, `0006`, `0007`)

`agent_core.agent_runs` already carries:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | RLS key, FK to `tenants` |
| `user_id` | uuid | nullable — **see open question #3** |
| `status` | text | `planning` / `running` / `completed` / `failed` |
| `task_graph` | jsonb | planner output |
| `model_provider` | text | `anthropic` / `openai` (today) |
| `model` | text | full model ID — added in 0005 |
| `tokens_in` / `tokens_out` | int | accumulated across all LLM calls in the run |
| `cost_estimate` | numeric | rough USD, populated by `finalizeRun` |
| `created_at` / `updated_at` / `completed_at` / `error` | various | lifecycle |

Indexes: `(tenant_id, created_at desc)`, `(tenant_id, completed_at desc) where completed_at is not null`.

`agent_core.agent_messages` carries one row per user/assistant/tool message — the `tool` role rows are the closest thing to per-tool tracking today, but they're JSONB blobs, not normalized.

`agent_core.tenant_tools` already records which tools are enabled per tenant.

### 1.2 What's missing

| Need | Today's gap |
|---|---|
| Per-LLM-step cost ("what does the critic cost us?") | Tokens are summed at the run level only |
| Anthropic cache-discount accounting | No cache columns; discount silently uncaptured |
| Per-tool usage in a queryable shape | Buried in `agent_messages.content` JSONB |
| External-API quota tracking (Brave, HubSpot rate limits) | None |
| Effective-dated pricing | Prices hardcoded in `packages/runtime/src/model.ts` |
| Rollup that doesn't re-scan all of `agent_runs` per dashboard load | None |
| Multi-provider attribution within one run | One `model_provider` column on the run |

### 1.3 New tables — recommended schema

```sql
-- 0008: pricing -----------------------------------------------------------
create table agent_core.model_prices (
  provider                  text        not null,
  model_prefix              text        not null,
  input_per_1m_usd          numeric     not null,
  output_per_1m_usd         numeric     not null,
  cache_write_per_1m_usd    numeric     not null default 0,
  cache_read_per_1m_usd     numeric     not null default 0,
  effective_from            timestamptz not null default now(),
  effective_to              timestamptz,
  notes                     text,
  primary key (provider, model_prefix, effective_from)
);
```

* **Effective-dated.** A price change `INSERT`s a new row with `effective_from = now()` and `UPDATE`s the prior row's `effective_to`. Historical runs cost what they cost on the day they ran. Billing reconciliation never lies because we asked yesterday.
* **Prefix-match lookup** preserves today's `model.ts` semantics (matches `claude-sonnet-4-5-20251022` to the `claude-sonnet-4-5` row). The longest matching prefix wins.
* **Seeded by migration** with the current `PRICE_PER_TOKEN` table from `model.ts`.

```sql
-- 0009: per-LLM-call detail ----------------------------------------------
create table agent_core.run_llm_calls (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references agent_core.agent_runs(id) on delete cascade,
  tenant_id           uuid not null references agent_core.tenants(id)    on delete cascade,
  step                text not null check (step in ('planner','executor','synthesizer','critic','other')),
  provider            text not null,
  model               text not null,
  tokens_in           int  not null default 0,
  tokens_out          int  not null default 0,
  cache_read_tokens   int  not null default 0,
  cache_write_tokens  int  not null default 0,
  cost_estimate       numeric not null default 0,
  latency_ms          int,
  status              text not null default 'ok' check (status in ('ok','error')),
  error               text,
  created_at          timestamptz not null default now()
);
```

* **One row per `callModel()` invocation.** `packages/runtime/src/model.ts` writes a row at the end of every call. `agent_runs.tokens_in/out/cost_estimate` becomes a `SUM` of this table for that `run_id` — written by `finalizeRun` as a denormalized rollup for cheap run-list queries.
* **`step` enum** lets you answer "what % of cost is the critic?" without parsing the task graph.
* **Multi-provider runs** are trivially supported — different rows can carry different `provider` values.

```sql
-- 0009 cont.: per-tool invocation detail ---------------------------------
create table agent_core.tool_invocations (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references agent_core.agent_runs(id) on delete cascade,
  tenant_id              uuid not null references agent_core.tenants(id)    on delete cascade,
  task_id                text,                  -- TaskGraph.task.id
  tool_key               text not null,         -- 'web-search', 'hubspot-query', ...
  ok                     boolean not null,
  external_units         int,                   -- 1 search, 1 API call, 1 message sent
  external_cost_estimate numeric not null default 0,   -- best-effort $ for paid tools
  latency_ms             int,
  error                  text,
  started_at             timestamptz not null default now(),
  completed_at           timestamptz
);
```

* `executor.ts` writes a row in the `try` block of each `registry.run()` call, finalized in either `try` or `catch`.
* `external_units` is integer because most paid tools (Brave, OpenAI embeddings, Gmail send) bill in countable units. Where the unit doesn't map cleanly, leave it `NULL`.
* `external_cost_estimate` is `NUMERIC`, populated only for tools whose pricing is known (Brave Search ≈ $0.005/query); others stay `0`.

### 1.4 New columns on existing tables

```sql
alter table agent_core.agent_runs
  add column if not exists cache_read_tokens  int     not null default 0,
  add column if not exists cache_write_tokens int     not null default 0,
  add column if not exists billable           boolean not null default true;
```

* `cache_read_tokens` / `cache_write_tokens` mirror the per-call table but rolled up to the run for cheap dashboard reads.
* `billable boolean` lets us flag a run as non-billable (e.g., internal smoke tests, retries after a system error). Defaults true; billing RPC respects it.

### 1.5 Rollup grain — **daily**

**Recommendation: daily is the primary rollup grain.** One materialized-view row per `(tenant_id, day, provider, model)`. Monthly / weekly are computed on-the-fly from daily — a year of monthly billing is 12 SUM operations over ~365 daily rows per tenant, which is free.

```sql
-- 0010: the daily rollup -------------------------------------------------
create materialized view agent_core.usage_daily as
select
  r.tenant_id,
  date_trunc('day', coalesce(r.completed_at, r.created_at))::date as day,
  r.model_provider as provider,
  r.model,
  count(*)                                       as runs,
  count(*) filter (where r.status = 'completed') as runs_completed,
  count(*) filter (where r.status = 'failed')    as runs_failed,
  sum(r.tokens_in)                               as tokens_in,
  sum(r.tokens_out)                              as tokens_out,
  sum(r.cache_read_tokens)                       as cache_read_tokens,
  sum(r.cache_write_tokens)                      as cache_write_tokens,
  sum(r.cost_estimate)                           as cost_estimate
from agent_core.agent_runs r
where r.billable
group by 1, 2, 3, 4;

create unique index usage_daily_pk
  on agent_core.usage_daily (tenant_id, day, provider, model);
```

The unique index is mandatory to support `REFRESH MATERIALIZED VIEW CONCURRENTLY` — otherwise dashboard reads block during the nightly refresh.

A parallel `agent_core.tool_usage_daily` rolls up `tool_invocations` by `(tenant_id, day, tool_key)` — identical pattern.

**Alternatives considered and rejected:**

| Alternative | Why rejected |
|---|---|
| Per-month materialized view only | Loses ability to chart trend lines, slow first-loads when a tenant asks for "last 7 days" |
| Per-hour rollup | Adds 24× storage for no business need; dashboards never ask hourly |
| Per-user rollup as a separate matview | `user_id` is sparse and frequently NULL today; better as a runtime `GROUP BY` over raw runs scoped to a day-range |
| Real-time view, no materialization | Linear scan of `agent_runs` per dashboard load; fine at 10 tenants, painful at 100 |
| Event-sourcing with a separate `usage_events` ledger | Massive over-engineering for a system whose source of truth is already a row per run |

### 1.6 Storage strategy — **keep raw forever (with caveats), aggressive on messages**

| Table | Retention | Rationale |
|---|---|---|
| `agent_core.agent_runs` | **Forever** (or tenant-defined cap, e.g., 2 years) | Tiny row size, indexed, anchors all foreign keys; cheap to keep |
| `agent_core.agent_messages` | **90 days** default, tenant-overridable | Largest payload by 100×; JSONB tool outputs can be huge |
| `agent_core.run_llm_calls` | **90 days** default, tenant-overridable | Detail granularity not needed long-term; rollup covers it |
| `agent_core.tool_invocations` | **90 days** default, tenant-overridable | Same reasoning |
| `agent_core.usage_daily` (matview) | **Forever** | Small (one row / tenant / day / model — ~365 × N_models rows / year) |
| `agent_core.tool_usage_daily` (matview) | **Forever** | Same |
| `agent_core.model_prices` | **Forever** | Effective-dated history is the whole point |

Retention is enforced by `agent_core.purge_expired()` — a SECURITY DEFINER function run nightly by `pg_cron`. Tenant override lives on `tenants.retention_days_messages` (new column, default 90, NULL = keep forever).

### 1.7 Indexes

Beyond the existing two on `agent_runs`:

```sql
-- Per-model rollups, per-day windows
create index idx_agent_runs_tenant_model_created
  on agent_core.agent_runs(tenant_id, model, created_at desc);

-- The per-call table — almost always queried by run_id or tenant+day
create index idx_run_llm_calls_run        on agent_core.run_llm_calls(run_id);
create index idx_run_llm_calls_tenant_day on agent_core.run_llm_calls(tenant_id, created_at desc);

-- Tool invocations — same pattern
create index idx_tool_invocations_run            on agent_core.tool_invocations(run_id);
create index idx_tool_invocations_tenant_tool_day
  on agent_core.tool_invocations(tenant_id, tool_key, started_at desc);

-- The matview's unique index doubles as a lookup index for RPCs
-- (already declared in §1.5)
```

### 1.8 Per-tool cost — **yes, track it separately**

Decision: **track per-tool cost in `tool_invocations.external_cost_estimate`.** Most paid external APIs (Brave, OpenAI embeddings, Twilio, etc.) charge by quantifiable units. Where unit cost is unknown, leave the column zero — `tool_usage_daily` still gives the tenant `count(*) per tool_key per day` which answers the rate-limit / quota question even without dollars.

Estimated rollout: seed `model_prices` rows for the LLM providers in 0008; tools that have known external pricing get their unit cost recorded in `packages/tools/src/builtins/<tool>.ts` and the executor multiplies units × unit_cost when persisting the invocation. No new pricing table for tools — they're too heterogeneous (some charge per call, some per token, some per MB).

---

## 2. Cost Calculation

### 2.1 Pricing source — database, not code

Today `packages/runtime/src/model.ts` carries an inline `PRICE_PER_TOKEN` table. **Move it to `agent_core.model_prices`** (see 1.3).

* The runtime loads the table on cold start (single `select * from model_prices where effective_to is null or effective_to > now()`), caches it in-process for 5 minutes, and refreshes on miss.
* Prefix-matching logic stays — `claude-sonnet-4-5-20251022` resolves to the `claude-sonnet-4-5` row by longest match.
* A new model? Insert a row in `model_prices`, runtime picks it up within 5 minutes — no deploy.
* A price change? Insert a new row with `effective_from = now()`, set `effective_to` on the old one. Historical runs keep their original `cost_estimate`; if you need to *re-cost* history, run a backfill RPC (deliberately not auto-run — that's a billing decision, not an upgrade artifact).

**Why effective-dated rather than mutable rows:**

* Anthropic *has* changed prices mid-year (Sonnet, Haiku reshuffles). When that happens we want June's invoices to show June's prices and July's to show July's, without keeping a parallel "historical price archive."
* Idempotent migrations don't have to fight existing rows — new prefix = new row, no `UPSERT` of dollar values.

### 2.2 Cache-discount support (Anthropic)

Anthropic's prompt-caching response shape:

```json
{
  "usage": {
    "input_tokens": 1100,
    "output_tokens": 250,
    "cache_creation_input_tokens": 450,
    "cache_read_input_tokens": 4200
  }
}
```

Pricing model:

| Token class | Multiplier vs base input |
|---|---|
| Standard input | 1.0× |
| Cache write (creation) | 1.25× |
| Cache read | 0.1× |
| Output | (per output_per_1m_usd) |

The cost formula becomes:

```
cost = (input_tokens                * input_per_1m / 1e6)
     + (cache_creation_input_tokens * cache_write_per_1m / 1e6)
     + (cache_read_input_tokens     * cache_read_per_1m / 1e6)
     + (output_tokens               * output_per_1m / 1e6)
```

`model.ts` change: extend `ModelCallResult` with `cacheReadTokens` / `cacheWriteTokens`, capture from the response, and persist into `run_llm_calls` (and roll up to `agent_runs.cache_read_tokens` / `cache_write_tokens`).

### 2.3 Provider differences

| Provider | Response shape | Cache support today |
|---|---|---|
| Anthropic | `usage.input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` | Yes (above) |
| OpenAI | `usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` | Yes — cached input at 0.5× |
| xAI (Grok) | OpenAI-compatible (`usage.prompt_tokens` etc.) | Not yet |
| Google (Gemini) | `usageMetadata.promptTokenCount` / `candidatesTokenCount` / (cached: `cachedContentTokenCount`) | Yes (Context Caching) |

Recommendation: a small **per-provider normalizer** in `model.ts` that returns a uniform shape:

```ts
interface NormalizedUsage {
  tokensIn:        number; // billed at input rate
  tokensOut:       number; // billed at output rate
  cacheReadTokens: number; // billed at cache_read rate
  cacheWriteTokens:number; // billed at cache_write rate
}
```

Each provider branch converts its own field names into that shape; the cost calculator stays provider-agnostic. xAI and Google get added later by extending the `ModelProvider` union in `packages/runtime/src/types.ts` and adding a branch.

### 2.4 Failed runs / partial runs

Three failure modes, three answers:

| Mode | Status | Billable? | Why |
|---|---|---|---|
| Planner LLM call fails before any tokens consumed | `failed`, `tokens_in=0` | No (and rollup excludes it via `where billable`) | We never hit the API |
| Pipeline ran some LLM calls, then died (timeout, OOM, tool crash) | `failed`, `tokens_in > 0` | **Yes** | The provider charged us; we charge the tenant |
| Critic rejected the answer (`verified=false`) | `completed`, `verified=false` | **Yes** | LLM tokens were spent, work product exists |

`billable` defaults true; the runtime flips it to false only for the first case (planner errored before any `run_llm_calls` row was written). Easiest implementation: at `finalizeRun`, if no `run_llm_calls` rows exist for the run, set `billable=false`.

### 2.5 Multi-provider runs

Rare today (we ship one provider per run), but the `run_llm_calls.provider` / `.model` columns make it free to support. The run-level `agent_runs.model_provider` / `.model` columns hold the **primary orchestrator model** (the one the planner used) as a denormalized hint for dashboards — they're not authoritative. Authoritative per-run cost is `sum(run_llm_calls.cost_estimate)`.

This unlocks Sprint 7+ features like "use Haiku for planning, Sonnet for synthesis" without a schema change.

---

## 3. RPC API Surface

All RPCs are `security definer`, schema-quoted `agent_core.*`, granted to `service_role` only (the runtime / Edge Function paths). Authenticated users get to them via the runtime's API, never PostgREST directly — RLS on the underlying tables still applies as a defense in depth.

### 3.1 `usage_summary(tenant_id, from, to, grain)`

```sql
create or replace function agent_core.usage_summary(
  p_tenant uuid,
  p_from   timestamptz,
  p_to     timestamptz,
  p_grain  text default 'day'  -- 'day' | 'month' | 'total'
) returns table (
  bucket             date,
  provider           text,
  model              text,
  runs               bigint,
  runs_completed     bigint,
  runs_failed        bigint,
  tokens_in          bigint,
  tokens_out         bigint,
  cache_read_tokens  bigint,
  cache_write_tokens bigint,
  cost_estimate      numeric
) ...
```

* `p_grain='day'`: UNION of `usage_daily` (for days strictly before today) + same-day live aggregation from `agent_runs` (for today). Real-time accuracy without the cost of re-rolling history every dashboard load.
* `p_grain='month'`: `SUM` over `usage_daily` `GROUP BY date_trunc('month', day)`.
* `p_grain='total'`: a single row, full range.

### 3.2 `usage_for_billing(tenant_id, month)`

```sql
create or replace function agent_core.usage_for_billing(
  p_tenant uuid,
  p_month  date  -- the first day of the month, e.g. '2026-05-01'
) returns table (
  provider           text,
  model              text,
  runs               bigint,
  tokens_in          bigint,
  tokens_out         bigint,
  cache_read_tokens  bigint,
  cache_write_tokens bigint,
  cost_estimate      numeric
) ...
```

* Closed-interval `[p_month, p_month + 1 month)`.
* `where billable` enforced.
* Deterministic: never reads "today's" live aggregate — only the materialized view. If the current month isn't closed, the matview must have caught up to yesterday, which the nightly refresh guarantees. This protects against invoices that shift between two reads on the same day.
* Used by future invoice generation; for now, exposed so admin dashboards can preview an invoice.

### 3.3 `usage_by_tool(tenant_id, from, to)`

```sql
create or replace function agent_core.usage_by_tool(
  p_tenant uuid,
  p_from   timestamptz,
  p_to     timestamptz
) returns table (
  tool_key               text,
  invocations            bigint,
  invocations_ok         bigint,
  invocations_failed     bigint,
  external_units         bigint,
  external_cost_estimate numeric
) ...
```

Reads `tool_usage_daily` + same-day live aggregate from `tool_invocations`. Same pattern as `usage_summary`.

### 3.4 `usage_by_user(tenant_id, from, to)`

```sql
create or replace function agent_core.usage_by_user(
  p_tenant uuid,
  p_from   timestamptz,
  p_to     timestamptz
) returns table (
  user_id            uuid,
  runs               bigint,
  tokens_in          bigint,
  tokens_out         bigint,
  cost_estimate      numeric
) ...
```

This one runs against raw `agent_runs` rather than a materialized view, because:
* `user_id` is sparse — most tenants will have a handful of users, not thousands.
* Maintaining a per-user matview multiplies storage and refresh time.
* Day-windowed scans of `agent_runs` with the existing `(tenant_id, created_at desc)` index are cheap up to millions of rows.

Caveat: requires the runtime to **actually populate `agent_runs.user_id`**, which today's `recordRunStart` doesn't (see open question #3).

### 3.5 Aggregation strategy — **materialized + nightly refresh + same-day live merge**

The pattern across all four RPCs:

```sql
-- closed historical window: cheap matview read
select * from agent_core.usage_daily
where  tenant_id = p_tenant
  and  day >= p_from::date
  and  day <  least(p_to, current_date)::date

union all

-- today (if it's in range): live aggregate
select ...
from   agent_core.agent_runs
where  tenant_id  = p_tenant
  and  billable
  and  created_at >= current_date
  and  created_at <  current_date + interval '1 day'
  and  current_date >= p_from::date
  and  current_date <  p_to::date
```

This is the canonical "lambda architecture-lite" pattern: a long cold table (matview), a short hot table (today's rows), unioned at read time. Refresh cron only touches yesterday-and-earlier — never contends with today's writes.

**Refresh job:**

```sql
-- pg_cron, runs at 00:05 UTC daily
select cron.schedule(
  'agent_core_usage_daily_refresh',
  '5 0 * * *',
  $$refresh materialized view concurrently agent_core.usage_daily;
    refresh materialized view concurrently agent_core.tool_usage_daily;$$
);
```

**Alternatives considered:**

* **Real-time view, no matview**: fine for 10 tenants, becomes an N-month linear scan when a dashboard asks "last 90 days." Rejected.
* **Trigger-based incremental rollup**: writes a `usage_daily` row on every `agent_runs UPDATE`. Higher write contention, harder to reason about reordering / late completions. Rejected; matview refresh is simpler and the freshness window (≤24h for closed days, real-time for today) is good enough.
* **Event-sourced ledger**: every `INSERT/UPDATE` writes a `usage_events` row; rollup is `SUM(amount) GROUP BY day`. Overkill — `agent_runs` already is the ledger. Rejected.

---

## 4. Retention Policy

### 4.1 The defaults

| Object | Default retention | Override location |
|---|---|---|
| `agent_runs` | Forever | (none — too cheap to bother) |
| `agent_messages` | 90 days | `tenants.retention_days_messages` |
| `run_llm_calls` | 90 days | `tenants.retention_days_detail` |
| `tool_invocations` | 90 days | `tenants.retention_days_detail` |
| `usage_daily` (matview) | Forever | (none) |
| `tool_usage_daily` (matview) | Forever | (none) |
| `model_prices` | Forever | (none) |

Two override columns rather than one because messages (heavy, often sensitive — emails, document drafts) commonly need *shorter* retention than detail counters, which are pure operational metadata.

### 4.2 What's deleted vs archived vs kept forever

* **Deleted (by `purge_expired`)**: `agent_messages`, `run_llm_calls`, `tool_invocations` rows older than the tenant's retention window. Hard delete. Source of truth is the matview; raw rows are recreatable in principle from logs.
* **Kept forever**: `agent_runs` rollups (the row stays, just the detail joins go); all matview rows; pricing history.
* **Archived (optional, Sprint 7+)**: pre-purge JSONL dump to Supabase Storage `agent_core_archive/<tenant_id>/<year>/<month>.jsonl.gz`. Not in the initial Sprint 6 cut — explicit decision deferred to keep the surface area small.

### 4.3 Data portability — `export_tenant_runs`

Before any deletion, tenants can export. Recommended RPC (Sprint 6 cut):

```sql
create or replace function agent_core.export_tenant_runs(
  p_tenant uuid,
  p_from   timestamptz,
  p_to     timestamptz
) returns jsonb ...
```

Returns a JSONB array of `{run, messages, llm_calls, tool_invocations}` envelopes for the date range. Capped at, say, 10,000 runs per call to bound memory; pagination via repeated calls. For larger exports, Sprint 7's Storage-archive path is the answer.

### 4.4 The purge job

```sql
create or replace function agent_core.purge_expired() returns void
  security definer
  language plpgsql
  set search_path = agent_core
as $$
begin
  -- messages
  delete from agent_messages m using tenants t
  where  m.tenant_id = t.id
    and  m.created_at < now() - make_interval(
           days => coalesce(t.retention_days_messages, 2147483647)
         );

  -- detail
  delete from run_llm_calls c using tenants t
  where  c.tenant_id = t.id
    and  c.created_at < now() - make_interval(
           days => coalesce(t.retention_days_detail, 2147483647)
         );

  delete from tool_invocations ti using tenants t
  where  ti.tenant_id = t.id
    and  ti.started_at < now() - make_interval(
           days => coalesce(t.retention_days_detail, 2147483647)
         );

  -- expired oauth states (already needed; absorbs the Sprint 4 deferred sweeper)
  delete from oauth_states where expires_at < now();
end;
$$;

select cron.schedule(
  'agent_core_purge_expired',
  '15 0 * * *',  -- 10 min after the matview refresh
  $$select agent_core.purge_expired();$$
);
```

This also absorbs the deferred `oauth_states` sweeper from Sprint 4 Remediation 2 — single nightly job, one place to find it. Sprint 6's hardening track can reference this rather than building a parallel cron.

---

## 5. Concrete Migration Sketch

Three migrations, idempotent, schema-quoted to `agent_core`, additive only. **Order matters** — `0009` depends on `0008` (FK reads pricing for cost backfill option), `0010` depends on both.

### 5.1 `migrations/0008_metering_pricing.sql`

* `create table if not exists agent_core.model_prices (...)` with effective-dated PK.
* Seed rows for every entry in today's `PRICE_PER_TOKEN` from `packages/runtime/src/model.ts`, with cache rates calculated as input × (1.25 / 0.1) where the provider supports caching, else 0.
* `revoke all ... from public, anon, authenticated; grant select on table model_prices to service_role, authenticated` (so the admin shell can read pricing for display).
* No RLS — pricing is global, not tenant-scoped.
* Idempotent seed via `insert ... on conflict (provider, model_prefix, effective_from) do nothing`.

### 5.2 `migrations/0009_metering_runs.sql`

* `alter table agent_core.agent_runs add column if not exists cache_read_tokens int not null default 0` × 3 (cache_read, cache_write, billable).
* `create table if not exists agent_core.run_llm_calls (...)` with FK to `agent_runs.id` and `tenants.id`, indexes, RLS, `tenant_isolation` policy mirroring 0001.
* `create table if not exists agent_core.tool_invocations (...)` — same pattern.
* `alter table agent_core.tenants add column if not exists retention_days_messages int default 90, add column if not exists retention_days_detail int default 90` (NULL means forever — caller's choice).
* New indexes per §1.7.
* Grants follow the 0007 pattern: `service_role` gets ALL, `authenticated` gets `select` (RLS filters to their tenant for the admin dashboard).

### 5.3 `migrations/0010_metering_rollups.sql`

* `create materialized view if not exists agent_core.usage_daily as ...` with unique index.
* `create materialized view if not exists agent_core.tool_usage_daily as ...` with unique index.
* Four RPCs: `usage_summary`, `usage_for_billing`, `usage_by_tool`, `usage_by_user`, each `security definer`, search_path locked to `agent_core`, granted to `service_role` (and `authenticated` for the dashboard surface).
* `export_tenant_runs` RPC (§4.3).
* `purge_expired` RPC (§4.4).
* Two `cron.schedule(...)` calls — the matview refresh and the purge.

### 5.4 Idempotency notes

* **Materialized views** don't have `create materialized view if not exists` in older Postgres; on Supabase's PG 15+ it works. Belt-and-braces alternative: wrap in `do $$ ... $$` with a `pg_matviews` lookup.
* **`cron.schedule`** errors if the job name exists. Wrap with `select cron.unschedule('name') ... ` in a function-style guard, or use `cron.schedule_in_database` with the standard idempotent `on conflict do nothing` pattern.
* **Seed rows** in `model_prices` use `on conflict do nothing` against the (provider, model_prefix, effective_from) PK.
* All `alter table ... add column if not exists` — no `drop` ever in additive migrations.

### 5.5 Dependency order recap

```
0001 ── tables (tenants, agent_runs, agent_messages, current_tenant, RLS)
0002 ── credentials
0003 ── artifacts storage
0004 ── read-only query path
0005 ── run lifecycle (model, completed_at, error) ─────────┐
0006 ── oauth connections                                    │
0007 ── grants                                               │
                                                             │
0008 ── model_prices ◄── needs 0001 (tenants schema exists)  │
0009 ── per-call + tool detail + retention cols ◄── 0001, 0005, 0007 (grants pattern)
0010 ── matviews, RPCs, cron ◄── 0008 (prices), 0009 (tables it aggregates)
```

### 5.6 Runtime / persistence changes that ride alongside

Not in the migrations, but co-shipped:

* **`packages/runtime/src/persistence.ts`** — new `recordLlmCall(...)` writer called by `model.ts`; `finalizeRun` rolls up `SUM(run_llm_calls)` into `agent_runs` and flips `billable=false` if no calls were recorded.
* **`packages/runtime/src/model.ts`** — extend `ModelCallResult` with `cacheReadTokens` / `cacheWriteTokens`; load pricing from DB via a new `loadPricing()` helper with 5-min in-process cache; per-provider normalizer.
* **`packages/runtime/src/executor.ts`** — write a `tool_invocations` row at the start and finalize at the end of each `registry.run()`. Tool implementations that know external unit costs return them in their result shape (small extension to `ToolResult` — optional `meta.externalUnits` / `meta.externalCostEstimate`).
* **`packages/schema/scripts/verify-metering.ts`** (new) — verifies the four RPCs exist, the matview unique index is present, the cron jobs are scheduled, and a synthetic run flows through to `usage_daily` after a manual refresh.

---

## 6. Open Questions / Risks

### 6.1 Questions for Brian (product decisions)

1. **Default retention for `agent_messages`** — is 90 days reasonable? Some tenants (Lewis Insurance, healthcare-adjacent clients later) may need 7 years for compliance. Suggestion: 90 days default, sell longer retention as a paid tier later. Confirm 90.
2. **Billing or just observability?** Are we *charging* tenants per-token (resale model) or just exposing cost so they see what they're spending? If the former, we need invoice-grade precision (and probably a billing-period freeze RPC). If the latter, the current "rough estimate" framing in `model.ts` is honest enough. **My read: observability for now, billing later.** Confirm.
3. **`agent_runs.user_id` capture** — the column exists from 0001 but `recordRunStart` in `persistence.ts` never populates it. Is the runtime supposed to be capturing `auth.uid()` from the JWT? If yes, this is a one-line fix that should ride with 0009; if no, `usage_by_user` should be deferred. **Recommendation: capture it, plumb through `RecordRunStartInput.userId`.**
4. **Per-tool external cost** — for Brave Search, $0.005/query is a published number. For HubSpot, the unit is "API call against quota" but no $/call number maps cleanly. Should `external_cost_estimate` stay zero for HubSpot (track units only), or do we want a "quota cost share" allocation (monthly seat / monthly calls)? **Recommendation: zero $ where unknown, document the quota-tracking story separately. Don't invent dollar figures.**
5. **xAI / Google support timeline** — should the design ship slots for them now (provider rows in `model_prices`, branches in `model.ts` normalizer) or wait until they're actually integrated? **Recommendation: schema supports them (provider is just a text column), but no seed rows / no normalizer branches until they're wired.**

### 6.2 Risks

1. **`pg_cron` availability.** Standard on Supabase but worth verifying with `select * from pg_extension where extname='pg_cron'`. If unavailable on a tenant project, fallback is a Deno Edge Function on a Supabase scheduled cron (less robust, but workable).
2. **Materialized view refresh contention.** `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires a unique index *and* a writable temp table. On very large rollups (hundreds of thousands of daily rows / tenant) this can take seconds to minutes. At 10 tenants × 365 days × a few models, we're at < 50k rows total — refresh is milliseconds. Recheck at 1000 tenants.
3. **Pricing drift between code and DB.** Once pricing moves to the DB, `model.ts` is a consumer. If a price changes in the DB but the runtime's 5-minute cache hasn't expired, a few requests will use the stale price. Acceptable — costs are estimates anyway; rollup at end of month re-reads from the DB. But document the staleness window.
4. **Backfilling `run_llm_calls` for existing data.** All `agent_runs` rows that already exist (the BlackRock tenant's actual usage since 2026-05-24) have no per-call detail. We can either (a) leave them as-is (run-level summary only, no step breakdown), or (b) synthesize one stub `run_llm_calls` row per existing run with `step='other'` so SUM-based queries don't show empty result sets. **Recommendation: (b), in a one-shot backfill INSERT inside 0009.** Trivial cost, eliminates a class of "wait, this run has no calls?" bug.
5. **`agent_runs.billable=false` rows** — the matview's `where billable` filter excludes them. If a tenant later disputes "you charged me for run X" and run X has billable=false, the dashboard correctly shows it as untracked. But that means the rollup is *not* a count of all runs — only of billable ones. The dashboard should expose total-runs and billable-runs as separate columns to avoid confusion.
6. **Cache discount on partial responses.** If an Anthropic streaming response is cut short (network drop), the `usage` object may not arrive at all. Today's code already returns zeros in that case (`numberOr(data?.usage?.input_tokens, 0)`); cache fields will behave the same. The cost ends up understated for that run. Acceptable; flagged for monitoring.
7. **Tool implementation surface.** Per-tool external_units / external_cost_estimate requires every tool to optionally surface that info. The first cut should ship with `web-search` populated (Brave's $/query is known) and others returning NULL. Documenting the optional field in the tool result contract is part of `0009`'s docstring work.
8. **Performance at scale.** Back-of-envelope for the projected ceiling (10 tenants × 100 runs/day × 365 days):
   * `agent_runs`: 365,000 rows. Indexed on `(tenant_id, created_at)`. Single-tenant scans of a month: ~3,000 rows. Negligible.
   * `run_llm_calls`: ~4–6× run count = 1.5–2M rows / year. Still trivial.
   * `tool_invocations`: ~3–5× run count = ~1.5M rows / year. Trivial.
   * `agent_messages`: most rows are tool outputs — could be hundreds of KB each in JSONB. At 90-day retention this is ~90k runs × ~10 messages × maybe 50KB avg = ~45GB. **This is the only table to monitor.** If tenants generate large tool outputs (web scrapes, big docs) the 90-day default may need to come down or storage costs become visible. Default tenant Supabase project has ample headroom but worth surfacing in admin.

---

## 7. Summary of Deliverables (for the orchestrator's Sprint 6 task graph)

| # | Deliverable | Where |
|---|---|---|
| M1 | `migrations/0008_metering_pricing.sql` — `model_prices` table + seed | `packages/schema/migrations/` |
| M2 | `migrations/0009_metering_runs.sql` — per-call + tool detail + retention cols + backfill | `packages/schema/migrations/` |
| M3 | `migrations/0010_metering_rollups.sql` — matviews + RPCs + cron + purge | `packages/schema/migrations/` |
| R1 | `model.ts` — DB-backed pricing, per-provider normalizer, cache fields | `packages/runtime/src/model.ts` |
| R2 | `persistence.ts` — `recordLlmCall`, finalizeRun rollup, billable flag | `packages/runtime/src/persistence.ts` |
| R3 | `executor.ts` — `tool_invocations` writer wrapping each `registry.run()` | `packages/runtime/src/executor.ts` |
| R4 | `types.ts` — extend `TokenUsage` with `cacheReadTokens` / `cacheWriteTokens`; extend `ToolResult` with optional `meta` | `packages/runtime/src/types.ts` |
| V1 | `verify-metering.ts` — end-to-end verification | `packages/schema/scripts/verify-metering.ts` |
| D1 | Update `docs/architecture.md` Sprint 6 row to reference these files | `docs/architecture.md` |

---

## 8. What this design deliberately defers

* **Storage-archive of purged messages.** Pre-delete JSONL dump to Supabase Storage. Useful but not blocking; revisit in Sprint 7.
* **Re-cost backfill RPC.** If a price changes retroactively (Anthropic re-quotes June), we'd want to recompute `cost_estimate` over a date range. Schema supports it (effective-dated `model_prices`); the RPC is one function we can add as soon as it's needed.
* **Per-user matview.** Defer until user counts justify it.
* **Tool-pricing table.** Heterogeneity (Brave by query, embeddings by token, Twilio by message) doesn't justify a unified schema today. Each tool's implementation owns its unit cost.
* **Real-time webhooks.** "Notify when tenant X crosses $50 / month" — Sprint 7+. The matview + RPCs make it trivial to add a poll-based version when needed.
* **Invoice generation.** `usage_for_billing` exposes the data shape an invoice generator would consume; the generator itself (PDF, line items, branding) is downstream of this design.

---

**End of design.** Recommended next step: the orchestrator decomposes M1/M2/M3 into Sprint 6's autoloop tasks, treating questions 6.1.1–6.1.5 as a one-question batch for Brian before kickoff.
