# Sprint 6 — Migration & DB Engineering Design

**Repo:** `github.com/blackrock-ai/blackrock-agent-core`
**Author:** Sprint 6 DB specialist
**Status:** Design — implementation has not started
**Last updated:** 2026-05-24

This document is the SQL spec for Sprint 6. It is binding on the implementation agents: every migration file, table, index, function, policy and pg_cron job they produce should match the structure, naming and conventions described here. Where ambiguity is intentional (e.g. exact RLS expression on a borderline table), the design says so explicitly; everything else is a directive.

It is written against the **post–Sprint 5** state of the schema: `agent_core` is the only namespace Agent Core touches, every existing object is schema-qualified, and migrations `0001`–`0007` are already merged.

---

## 0. Conventions inherited from `0001`–`0007`

Every Sprint 6 migration MUST adopt the conventions established by the existing seven:

- **Namespace.** Every object lives under `agent_core`. Every cross-reference is schema-qualified. No new object lands in `public`.
- **Idempotency.** `create table if not exists`, `create index if not exists`, `create or replace function`, `drop trigger if exists` before `create trigger`. `alter table ... add column if not exists`. RLS policies use the `create policy` pattern; we DO NOT have `create policy if not exists` in PG15, so every new policy is wrapped in a `do $$ ... $$` guard or `drop policy if exists` first (see §2 for the template).
- **RLS.** Every new `agent_core.*` table that holds tenant data:
  1. `alter table ... enable row level security`
  2. `create policy tenant_isolation on ... for all using (tenant_id = agent_core.current_tenant()) with check (tenant_id = agent_core.current_tenant())`
  3. The `current_tenant()` reference is always schema-qualified.
- **SECURITY DEFINER functions.** Always set `search_path = agent_core` (or `agent_core, vault` when Vault is involved). Always `revoke all ... from public, anon, authenticated` and `grant execute ... to service_role` (and `authenticated` only when the RPC is intentionally end-user callable from the shell). The grant pattern from `0007` will pick up newly-created objects via `alter default privileges`, but each new RPC still explicitly REVOKES from `public`/`anon`/`authenticated` if it needs to be service-role-only — default privileges don't override a function-level REVOKE.
- **Run-once SQL inside `do $$ ... $$`.** Used for one-off DDL that lacks an `IF NOT EXISTS` form (policies, pg_cron unschedule).
- **No `any` mistakes from SQL side.** All RPC inputs are typed; jsonb parameters validate `jsonb_typeof()` before use.

The `0007_agent_core_grants.sql` default privileges already cover newly created tables, functions, and sequences in `agent_core`, so Sprint 6 migrations do **not** need to repeat the grant blocks — only the per-function REVOKE/GRANT for SECURITY DEFINER tightening.

---

## 1. Migration file plan

Five new migration files, in number order. Each is independently idempotent so `verify-migrations.sh` keeps passing on re-apply.

| # | File | Purpose | Objects created | Depends on |
|---|------|---------|-----------------|------------|
| 0008 | `0008_metering.sql` | Hand-rolled usage rollup tables, refresh RPCs, billing RPCs, **pg_cron extension bootstrap** (first migration to need it) | `extension pg_cron` (if not already enabled by Supabase), `usage_rollup_daily`, `tool_usage_rollup_daily`, `refresh_usage_rollup_daily()`, `refresh_tool_usage_rollup_daily()`, `usage_summary()`, `usage_for_billing()`, `retention_sweep_agent_runs()`, **+ 3 pg_cron jobs (rollup refresh ×2, retention)** | `0001`, `0005` |
| 0009 | `0009_rate_limits.sql` | Tenant-scoped rate-limit counters table and atomic `check_rate_limit()` RPC, plus a purge job | `rate_limit_counters`, `check_rate_limit()`, `purge_rate_limit_counters()`, **+ pg_cron purge job** | `0001`, `0008` (pg_cron) |
| 0010 | `0010_audit_log.sql` | Append-only audit log table, `record_audit_event()` RPC, `query_audit_log()` admin-readable RPC | `audit_log`, `record_audit_event()`, `query_audit_log()`, `prune_audit_log()`, **+ pg_cron prune job** | `0001`, `0008` (pg_cron) |
| 0011 | `0011_oauth_states_sweeper.sql` | The sweeper deferred from Remediation 2 — purges expired `oauth_states` rows on a cron | `sweep_oauth_states()`, **+ pg_cron sweeper job** | `0006`, `0008` (pg_cron) |
| 0012 | `0012_admin_users.sql` | `admin_users` table + `is_admin()` gate function + admin-facing RPCs (`admin_list_tenants`, `admin_list_runs`, `admin_set_tool`, `admin_reset_rate_limit`, `admin_set_admin`) | `admin_users`, `is_admin()`, `admin_list_tenants()`, `admin_list_runs()`, `admin_set_tool()`, `admin_reset_rate_limit()`, `admin_set_admin()` | `0001`, `0009`, `0010` |

### Why this split

- **0008 owns pg_cron bootstrap** because it is the first sprint-6 migration that needs to schedule a job. Putting it in its own `0008_pg_cron_bootstrap.sql` file would mean an extra file whose only payload is `create extension if not exists pg_cron;` — not worth it. Subsequent files assume the extension is loaded.
- **Rate limits, audit log, oauth sweeper** are split because each owns one table or function family and re-applying any one of them in isolation is a normal operator action. Combining them would force readers to scan a long file for the bit they care about.
- **Admin users last** so the admin RPCs can reference rate-limit counters (`admin_reset_rate_limit`) and audit-log writes (every admin action emits an audit event).
- **No standalone `0008_pg_cron_bootstrap.sql`.** Per the brief — don't add unnecessary files.

### Idempotency strategy per file

| File | Mechanism |
|------|-----------|
| 0008 | `create table if not exists`, `create or replace function`, policy guards via `do $$ ... $$ if not exists in pg_policies ...`, pg_cron jobs via `cron.unschedule(jobname)` + `cron.schedule(jobname, ...)` inside a `do` block that ignores the unschedule's "not found" error. |
| 0009 | Same patterns as 0008. The counters table is intentionally created without `unique` on `(tenant_id, subject, window_start)` — see §2 for the reasoning around UPSERT vs INSERT-then-UPDATE. |
| 0010 | Same patterns. Audit log is append-only — no UPSERT semantics needed. |
| 0011 | Function-only migration. `create or replace function` + the same cron-idempotency pattern. |
| 0012 | `create table if not exists`, RPC `create or replace function`, policy guard pattern. |

---

## 2. Per-migration SQL spec

### Shared policy-idempotency template

PG15 has no `create policy if not exists`, and Supabase's migration tool re-runs files on push. Every Sprint 6 migration uses this guard for new policies:

```sql
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename  = '<table>'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.<table>
      for all using (tenant_id = agent_core.current_tenant())
                with check (tenant_id = agent_core.current_tenant());
  end if;
end $$;
```

### Shared pg_cron job idempotency template

```sql
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'agent_core:<job-name>';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end $$;

select cron.schedule(
  'agent_core:<job-name>',
  '<cron-spec>',
  $cron$ select agent_core.<function>(...); $cron$
);
```

All Sprint 6 cron jobs are prefixed `agent_core:` so a `select * from cron.job where jobname like 'agent_core:%'` reads them out cleanly.

---

### 0008 — `0008_metering.sql`

#### A. pg_cron bootstrap

```sql
create extension if not exists pg_cron;
-- On Supabase, pg_cron lives in the `cron` schema and the `postgres` role
-- has membership in `pg_monitor` / direct access by default. No grant needed
-- for our SECURITY DEFINER functions to call cron.schedule, because the
-- migration runs as the project owner.
```

If pg_cron is NOT available (rare; some self-hosted Supabase installs disable it), this migration must NOT hard-fail — wrap the extension and schedule blocks in a `do $$ ... $$` that catches `undefined_object` / `feature_not_supported` and emits a `raise notice 'pg_cron unavailable; rollup refresh must be run manually'`. The rollup tables and refresh functions still install — only the scheduling is skipped. `verify-metering.ts` (see §9) detects this and parks.

#### B. `usage_rollup_daily` table

```sql
create table if not exists agent_core.usage_rollup_daily (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references agent_core.tenants(id) on delete cascade,
  day             date not null,
  model           text not null default '',           -- '' means "all models bucketed together"
  model_provider  text not null default '',
  run_count       int    not null default 0 check (run_count >= 0),
  success_count   int    not null default 0 check (success_count >= 0),
  fail_count      int    not null default 0 check (fail_count >= 0),
  tokens_in       bigint not null default 0 check (tokens_in >= 0),
  tokens_out      bigint not null default 0 check (tokens_out >= 0),
  cost_estimate   numeric(14,6) not null default 0,
  computed_at     timestamptz not null default now(),
  unique (tenant_id, day, model, model_provider)
);
```

**Why hand-rolled, not a view:** see §4. Short version: rollups must outlive raw `agent_runs` retention (90 days), they need to be cheap to read for the admin dashboard, and incremental refresh of "today + yesterday" is the only operation that scales.

**Why model + model_provider columns:** billing breaks the bill out by model (Sonnet vs Opus vs Haiku). Carrying them in the rollup avoids re-joining to `agent_runs` after raw rows are pruned.

#### C. `tool_usage_rollup_daily` table

```sql
create table if not exists agent_core.tool_usage_rollup_daily (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references agent_core.tenants(id) on delete cascade,
  day            date not null,
  tool_key       text not null,
  call_count     int  not null default 0 check (call_count >= 0),
  success_count  int  not null default 0 check (success_count >= 0),
  fail_count     int  not null default 0 check (fail_count >= 0),
  computed_at    timestamptz not null default now(),
  unique (tenant_id, day, tool_key)
);
```

Source data: `agent_messages` rows where `role='tool'`. `content->>'tool'` is the tool_key, `(content->>'ok')::boolean` is the success/fail bit. This survives `agent_runs` retention because we either (a) preserve `agent_messages` longer than runs (NOT recommended — cascades complicate it) or (b) refresh rollups before the retention sweep deletes anything. We go with (b) — see §5.

#### D. Indexes

```sql
create index if not exists idx_usage_rollup_daily_tenant_day
  on agent_core.usage_rollup_daily (tenant_id, day desc);

create index if not exists idx_tool_usage_rollup_daily_tenant_day
  on agent_core.tool_usage_rollup_daily (tenant_id, day desc);

-- Used by retention sweep on agent_runs (see §5):
create index if not exists idx_agent_runs_status_completed_at
  on agent_core.agent_runs (status, completed_at)
  where status in ('completed','failed');
```

The two `(tenant_id, day desc)` composites cover every admin-dashboard query: "give me this tenant's last 30 days of usage." Partial index on `agent_runs.status` keeps the retention sweep's `delete ... where status in ('completed','failed') and completed_at < now() - interval '90 days'` from scanning the whole table.

The existing `idx_agent_runs_tenant (tenant_id, created_at desc)` from `0001` already covers the refresh function's read path.

#### E. RLS

Both rollup tables enable RLS and use the shared `tenant_isolation` template above. Service-role bypasses RLS (it's the writer); end-users in the shell read their own tenant's rollups via the policy.

#### F. Functions

##### `refresh_usage_rollup_daily(p_day date, p_lookback_days int)`

```sql
create or replace function agent_core.refresh_usage_rollup_daily(
  p_day            date default current_date,
  p_lookback_days  int  default 1
) returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_start date := p_day - greatest(0, p_lookback_days);
  v_end   date := p_day;
  v_rows  int  := 0;
begin
  delete from usage_rollup_daily
   where day between v_start and v_end;

  with agg as (
    select
      tenant_id,
      ((created_at at time zone 'UTC')::date) as day,
      coalesce(model, '')          as model,
      coalesce(model_provider, '') as model_provider,
      count(*)                                              as run_count,
      count(*) filter (where status = 'completed')          as success_count,
      count(*) filter (where status = 'failed')             as fail_count,
      coalesce(sum(tokens_in),  0)::bigint                  as tokens_in,
      coalesce(sum(tokens_out), 0)::bigint                  as tokens_out,
      coalesce(sum(cost_estimate), 0)::numeric(14,6)        as cost_estimate
    from agent_runs
    where ((created_at at time zone 'UTC')::date) between v_start and v_end
    group by 1, 2, 3, 4
  )
  insert into usage_rollup_daily
    (tenant_id, day, model, model_provider, run_count, success_count, fail_count,
     tokens_in, tokens_out, cost_estimate)
  select * from agg;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function agent_core.refresh_usage_rollup_daily(date, int)
  from public, anon, authenticated;
grant execute on function agent_core.refresh_usage_rollup_daily(date, int)
  to service_role;
```

- **`security definer`** — service-role calls it from cron; SECURITY DEFINER lets us tighten the explicit `revoke` from the supabase roles.
- **Day arithmetic in UTC** — all billing math is UTC. The admin UI can render in tenant-local TZ.
- **Delete-then-reinsert** — handles backfill correctly. The lookback default of 1 means a 15-minute cron always re-aggregates today + yesterday, catching late-arriving rows.
- **Lookback is bounded** — operators can backfill any window by calling `refresh_usage_rollup_daily(some_date, 30)` from psql / an admin RPC.

##### `refresh_tool_usage_rollup_daily(p_day date, p_lookback_days int)`

Mirrors the above but aggregates over `agent_messages` joined to `agent_runs` for the day filter:

```sql
create or replace function agent_core.refresh_tool_usage_rollup_daily(
  p_day            date default current_date,
  p_lookback_days  int  default 1
) returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_start date := p_day - greatest(0, p_lookback_days);
  v_end   date := p_day;
  v_rows  int  := 0;
begin
  delete from tool_usage_rollup_daily where day between v_start and v_end;

  with tool_msgs as (
    select
      m.tenant_id,
      ((m.created_at at time zone 'UTC')::date) as day,
      coalesce(m.content ->> 'tool', 'unknown') as tool_key,
      ((m.content ->> 'ok')::boolean)           as ok
    from agent_messages m
    where m.role = 'tool'
      and ((m.created_at at time zone 'UTC')::date) between v_start and v_end
  ),
  agg as (
    select tenant_id, day, tool_key,
      count(*)                                  as call_count,
      count(*) filter (where ok is true)        as success_count,
      count(*) filter (where ok is false)       as fail_count
    from tool_msgs
    group by 1, 2, 3
  )
  insert into tool_usage_rollup_daily
    (tenant_id, day, tool_key, call_count, success_count, fail_count)
  select * from agg;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Same revoke/grant pattern.
```

`agent_messages.created_at` does not exist on the rollup yet — confirm in `0001` and `0005`: yes, it does (`agent_messages.created_at timestamptz not null default now()` from `0001`).

##### `usage_summary(p_tenant uuid, p_from timestamptz, p_to timestamptz, p_grain text)`

Returns `setof jsonb` so the admin UI gets one bucket per row, no awkward `table (...)` shape to keep in sync.

```sql
create or replace function agent_core.usage_summary(
  p_tenant  uuid,
  p_from    timestamptz,
  p_to      timestamptz,
  p_grain   text default 'day'  -- 'day' | 'week' | 'month'
) returns setof jsonb
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_trunc text;
begin
  if p_tenant is null then
    raise exception 'usage_summary: tenant is required';
  end if;
  if p_grain not in ('day','week','month') then
    raise exception 'usage_summary: grain must be day|week|month';
  end if;
  v_trunc := p_grain;

  return query
  with rolled as (
    select
      date_trunc(v_trunc, day::timestamptz) as bucket,
      run_count, success_count, fail_count,
      tokens_in, tokens_out, cost_estimate,
      model, model_provider
    from usage_rollup_daily
    where tenant_id = p_tenant
      and day >= (p_from at time zone 'UTC')::date
      and day <= (p_to   at time zone 'UTC')::date
  )
  select to_jsonb(t) from (
    select
      bucket,
      sum(run_count)::int      as run_count,
      sum(success_count)::int  as success_count,
      sum(fail_count)::int     as fail_count,
      sum(tokens_in)::bigint   as tokens_in,
      sum(tokens_out)::bigint  as tokens_out,
      sum(cost_estimate)::numeric(14,6) as cost_estimate,
      jsonb_agg(distinct jsonb_build_object('model', model, 'provider', model_provider))
        filter (where model <> '') as models
    from rolled
    group by bucket
    order by bucket
  ) t;
end;
$$;

revoke all on function agent_core.usage_summary(uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function agent_core.usage_summary(uuid, timestamptz, timestamptz, text)
  to service_role, authenticated;
```

- `authenticated` keeps `execute` because end-users will hit this from the shell to render their own usage dashboard. The function does NOT check tenant ownership — the caller passes their tenant_id and the SECURITY DEFINER body trusts it. **That is wrong for end-user calls.** Real implementation: add a guard near the top:

```sql
if p_tenant <> agent_core.current_tenant() and not agent_core.is_admin() then
  raise exception 'usage_summary: tenant_id does not match caller';
end if;
```

(`is_admin()` comes from migration 0012 — so this guard goes in 0012 as a `create or replace function` re-declaration, since 0008 can't reference functions that don't yet exist. Note this dependency in the implementation order.)

##### `usage_for_billing(p_tenant uuid, p_month date)`

Returns one jsonb row — easy to consume from a billing job:

```sql
create or replace function agent_core.usage_for_billing(
  p_tenant uuid,
  p_month  date
) returns jsonb
  language sql
  security definer
  set search_path = agent_core
as $$
  with month_window as (
    select
      date_trunc('month', p_month::timestamptz)::date                 as month_start,
      (date_trunc('month', p_month::timestamptz) + interval '1 month' - interval '1 day')::date
                                                                      as month_end
  ),
  usage as (
    select r.*
      from usage_rollup_daily r
      join month_window mw on r.day between mw.month_start and mw.month_end
     where r.tenant_id = p_tenant
  ),
  by_model as (
    select model, model_provider,
      sum(run_count)::int      as run_count,
      sum(tokens_in)::bigint   as tokens_in,
      sum(tokens_out)::bigint  as tokens_out,
      sum(cost_estimate)::numeric(14,6) as cost
    from usage
    group by 1, 2
  ),
  by_tool as (
    select tool_key,
      sum(call_count)::int     as call_count,
      sum(success_count)::int  as success_count,
      sum(fail_count)::int     as fail_count
    from tool_usage_rollup_daily t
    join month_window mw on t.day between mw.month_start and mw.month_end
    where t.tenant_id = p_tenant
    group by 1
  )
  select jsonb_build_object(
    'tenant_id',         p_tenant,
    'month',             to_char(p_month, 'YYYY-MM'),
    'total_runs',        coalesce((select sum(run_count) from usage), 0)::int,
    'total_tokens_in',   coalesce((select sum(tokens_in) from usage), 0)::bigint,
    'total_tokens_out',  coalesce((select sum(tokens_out) from usage), 0)::bigint,
    'total_cost',        coalesce((select sum(cost_estimate) from usage), 0)::numeric(14,6),
    'by_model',          coalesce((select jsonb_agg(by_model) from by_model),  '[]'::jsonb),
    'by_tool',           coalesce((select jsonb_agg(by_tool)  from by_tool),   '[]'::jsonb)
  );
$$;

revoke all on function agent_core.usage_for_billing(uuid, date)
  from public, anon, authenticated;
grant execute on function agent_core.usage_for_billing(uuid, date)
  to service_role;
```

Service-role only (no `authenticated`) — billing is a back-office concern, not a shell concern.

##### `retention_sweep_agent_runs(p_days int)`

```sql
create or replace function agent_core.retention_sweep_agent_runs(
  p_days int default 90
) returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare v_deleted int := 0;
begin
  if p_days is null or p_days < 7 then
    raise exception 'retention_sweep_agent_runs: refusing p_days < 7 (got %)', p_days;
  end if;

  -- IMPORTANT: refresh rollups BEFORE deleting so we never lose unaggregated runs.
  perform agent_core.refresh_usage_rollup_daily(current_date, greatest(p_days + 1, 30));
  perform agent_core.refresh_tool_usage_rollup_daily(current_date, greatest(p_days + 1, 30));

  delete from agent_runs
   where status in ('completed','failed')
     and coalesce(completed_at, created_at) < (now() - make_interval(days => p_days));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
```

The bounded-lookback rollup call is the safety belt: it re-aggregates the entire retention window first, so any rows that were never picked up by the 15-minute cron (e.g. clock skew, missed refresh) get rolled up before they're deleted. `agent_messages` cascades on `agent_runs` deletion (per `0001`), so we don't need a separate sweep.

The `>= 7` floor stops a thumb-fingered `retention_sweep_agent_runs(0)` from wiping the whole table.

#### G. pg_cron jobs (3)

```sql
-- Rollup refresh — every 15 minutes, last two days.
-- (Run twice per quarter-hour to keep dashboards fresh; lookback=1 covers 24h.)
do $$ declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'agent_core:rollup_refresh_runs';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;
select cron.schedule(
  'agent_core:rollup_refresh_runs',
  '*/15 * * * *',
  $cron$ select agent_core.refresh_usage_rollup_daily(current_date, 1); $cron$
);

do $$ declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'agent_core:rollup_refresh_tools';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;
select cron.schedule(
  'agent_core:rollup_refresh_tools',
  '*/15 * * * *',
  $cron$ select agent_core.refresh_tool_usage_rollup_daily(current_date, 1); $cron$
);

-- Retention sweep — 03:30 UTC daily.
do $$ declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'agent_core:retention_runs';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;
select cron.schedule(
  'agent_core:retention_runs',
  '30 3 * * *',
  $cron$ select agent_core.retention_sweep_agent_runs(90); $cron$
);
```

---

### 0009 — `0009_rate_limits.sql`

#### A. `rate_limit_counters` table

```sql
create table if not exists agent_core.rate_limit_counters (
  tenant_id     uuid not null references agent_core.tenants(id) on delete cascade,
  subject       text not null,            -- e.g. 'runs', 'tool:web_search', 'oauth_refresh'
  window_start  timestamptz not null,     -- floor(now / window) — pre-computed by the RPC
  window_secs   int  not null check (window_secs > 0 and window_secs <= 86400),
  count         int  not null default 0,
  expires_at    timestamptz not null,
  primary key (tenant_id, subject, window_start, window_secs)
);
```

- Composite PK avoids a separate `id` — every counter is uniquely keyed by `(tenant, subject, window_start, window_secs)`. That's also the natural UPSERT target.
- `window_secs` is on the row so the same `subject` can have multiple windows (e.g. 60s burst + 3600s sustained) without collision.
- `expires_at = window_start + (window_secs + 60s grace) * interval` — used by the purge job.

#### B. Indexes

```sql
-- The PK already covers the UPSERT lookup. Add one more for purge:
create index if not exists idx_rate_limit_counters_expires
  on agent_core.rate_limit_counters (expires_at);
```

#### C. RLS

Enable RLS, tenant_isolation policy via the shared template. End-users have no business reading this; only service_role writes/reads — but the policy still belongs there in case the table is ever queried from the shell admin surface (filtered to admin's own tenant).

#### D. `check_rate_limit()` RPC

```sql
create or replace function agent_core.check_rate_limit(
  p_tenant      uuid,
  p_subject     text,
  p_window_secs int,
  p_limit       int
) returns boolean
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_window_start timestamptz;
  v_new_count    int;
begin
  if p_tenant      is null then raise exception 'check_rate_limit: tenant required'; end if;
  if p_subject     is null or length(p_subject) = 0 then raise exception 'check_rate_limit: subject required'; end if;
  if p_window_secs is null or p_window_secs <= 0   then raise exception 'check_rate_limit: window_secs > 0 required'; end if;
  if p_limit       is null or p_limit       <= 0   then raise exception 'check_rate_limit: limit > 0 required'; end if;

  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);

  insert into rate_limit_counters
    (tenant_id, subject, window_start, window_secs, count, expires_at)
  values
    (p_tenant, p_subject, v_window_start, p_window_secs, 1,
     v_window_start + make_interval(secs => p_window_secs + 60))
  on conflict (tenant_id, subject, window_start, window_secs) do update
    set count = rate_limit_counters.count + 1
  returning count into v_new_count;

  return v_new_count <= p_limit;
end;
$$;

revoke all on function agent_core.check_rate_limit(uuid, text, int, int)
  from public, anon, authenticated;
grant execute on function agent_core.check_rate_limit(uuid, text, int, int)
  to service_role;
```

- **Atomicity:** the `insert ... on conflict do update returning count` is a single statement; concurrent calls always increment monotonically.
- **Return semantics:** `true` = allowed, `false` = exceeded. Returning bool keeps the runtime call site small: `if (!await check_rate_limit(...)) throw new RateLimitedError(...)`.
- **No "consume on success" semantics:** every call increments. If the runtime wants "decrement on tool failure" it can call a separate `decrement_rate_limit` (NOT in v1 — keeping it simple).

#### E. `purge_rate_limit_counters()` and pg_cron

```sql
create or replace function agent_core.purge_rate_limit_counters() returns int
  language plpgsql security definer set search_path = agent_core
as $$
declare v_deleted int := 0;
begin
  delete from rate_limit_counters where expires_at < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function agent_core.purge_rate_limit_counters()
  from public, anon, authenticated;
grant execute on function agent_core.purge_rate_limit_counters()
  to service_role;

-- pg_cron job — every 5 minutes, low cost.
do $$ declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'agent_core:rate_limit_purge';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;
select cron.schedule(
  'agent_core:rate_limit_purge',
  '*/5 * * * *',
  $cron$ select agent_core.purge_rate_limit_counters(); $cron$
);
```

---

### 0010 — `0010_audit_log.sql`

#### A. `audit_log` table

```sql
create table if not exists agent_core.audit_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references agent_core.tenants(id) on delete cascade,
  actor       uuid,                              -- auth.uid() or NULL for system events
  actor_kind  text not null default 'user'
              check (actor_kind in ('user','system','admin','service')),
  event       text not null check (length(event) between 1 and 128),
  target      text,                              -- free-form, e.g. 'tool:web_search'
  meta        jsonb not null default '{}',
  ip          inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);
```

#### B. Indexes

```sql
create index if not exists idx_audit_log_tenant_created
  on agent_core.audit_log (tenant_id, created_at desc);

create index if not exists idx_audit_log_event_created
  on agent_core.audit_log (tenant_id, event, created_at desc);

-- For retention sweep:
create index if not exists idx_audit_log_created
  on agent_core.audit_log (created_at);
```

#### C. RLS

```sql
alter table agent_core.audit_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='agent_core' and tablename='audit_log' and policyname='tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.audit_log
      for all using (tenant_id = agent_core.current_tenant())
                with check (tenant_id = agent_core.current_tenant());
  end if;
end $$;

-- Plus: prohibit UPDATE/DELETE for everyone except service_role.
-- Append-only semantics for tamper resistance.
revoke update, delete on agent_core.audit_log from authenticated, anon, public;
```

The `revoke update, delete` is the append-only guarantee. The `0007` default privileges granted everything to `authenticated`; this migration takes the destructive verbs back. Service-role retains UPDATE/DELETE for retention.

#### D. RPCs

```sql
create or replace function agent_core.record_audit_event(
  p_tenant      uuid,
  p_event       text,
  p_target      text default null,
  p_meta        jsonb default '{}'::jsonb,
  p_actor       uuid default null,
  p_actor_kind  text default 'user',
  p_ip          inet default null,
  p_user_agent  text default null
) returns uuid
  language plpgsql security definer set search_path = agent_core
as $$
declare v_id uuid;
begin
  insert into audit_log (tenant_id, actor, actor_kind, event, target, meta, ip, user_agent)
  values (p_tenant, coalesce(p_actor, nullif(auth.jwt() ->> 'sub','')::uuid),
          p_actor_kind, p_event, p_target, coalesce(p_meta, '{}'::jsonb),
          p_ip, p_user_agent)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function agent_core.record_audit_event(uuid, text, text, jsonb, uuid, text, inet, text)
  from public, anon, authenticated;
grant execute on function agent_core.record_audit_event(uuid, text, text, jsonb, uuid, text, inet, text)
  to service_role;

create or replace function agent_core.query_audit_log(
  p_tenant uuid,
  p_event  text default null,
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_limit  int default 200
) returns setof jsonb
  language sql security definer set search_path = agent_core
as $$
  select to_jsonb(a) from (
    select id, tenant_id, actor, actor_kind, event, target, meta, ip, user_agent, created_at
      from audit_log
     where tenant_id = p_tenant
       and (p_event is null or event = p_event)
       and (p_from  is null or created_at >= p_from)
       and (p_to    is null or created_at <= p_to)
     order by created_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  ) a;
$$;

revoke all on function agent_core.query_audit_log(uuid, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
grant execute on function agent_core.query_audit_log(uuid, text, timestamptz, timestamptz, int)
  to service_role;
```

`query_audit_log` does NOT grant to `authenticated` — the admin UI calls it via the admin RPC layer (0012), which checks `is_admin()` first.

#### E. `prune_audit_log()` and pg_cron

```sql
create or replace function agent_core.prune_audit_log(p_days int default 365) returns int
  language plpgsql security definer set search_path = agent_core
as $$
declare v_deleted int := 0;
begin
  if p_days is null or p_days < 30 then
    raise exception 'prune_audit_log: refusing p_days < 30';
  end if;
  delete from audit_log where created_at < now() - make_interval(days => p_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- pg_cron — Sundays 04:00 UTC, weekly is fine.
do $$ declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'agent_core:audit_prune';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;
select cron.schedule(
  'agent_core:audit_prune',
  '0 4 * * 0',
  $cron$ select agent_core.prune_audit_log(365); $cron$
);
```

---

### 0011 — `0011_oauth_states_sweeper.sql`

This is the sweeper deferred from Remediation 2. Function + cron, no new tables.

```sql
create or replace function agent_core.sweep_oauth_states() returns int
  language plpgsql security definer set search_path = agent_core
as $$
declare v_deleted int := 0;
begin
  delete from oauth_states where expires_at < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function agent_core.sweep_oauth_states()
  from public, anon, authenticated;
grant execute on function agent_core.sweep_oauth_states()
  to service_role;

-- pg_cron — every 5 minutes. oauth_states.expires_at is "now() + 10 minutes"
-- so a 5-minute cadence guarantees <15min before stale states are gone.
do $$ declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'agent_core:oauth_states_sweep';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;
select cron.schedule(
  'agent_core:oauth_states_sweep',
  '*/5 * * * *',
  $cron$ select agent_core.sweep_oauth_states(); $cron$
);
```

---

### 0012 — `0012_admin_users.sql`

The admin layer is intentionally minimal — Sprint 6 ships the gate and the RPCs; the Admin UX specialist's React work talks to these RPCs.

#### A. `admin_users` table

```sql
create table if not exists agent_core.admin_users (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,                                       -- auth.users.id
  tenant_id   uuid references agent_core.tenants(id) on delete cascade,
  role        text not null check (role in ('tenant_admin','super_admin')),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  unique (user_id, tenant_id)
);

-- super_admin rows have tenant_id IS NULL; one super_admin per user_id max:
create unique index if not exists uq_admin_users_super
  on agent_core.admin_users (user_id) where tenant_id is null;

create index if not exists idx_admin_users_user on agent_core.admin_users (user_id);
```

Why not a `tenants.admin_user_id` column or a Supabase `role` JWT claim? Two reasons: (a) we want to support multiple admins per tenant, and (b) editing JWT claims requires hooking Supabase's auth gen — out of scope. A table is simpler and tests cleanly.

#### B. RLS

```sql
alter table agent_core.admin_users enable row level security;

-- Admin can see their own admin row (and other admin rows in their tenant).
-- Super-admin sees everything (handled by service_role bypass + RPCs).
do $$ begin
  if not exists (select 1 from pg_policies
    where schemaname='agent_core' and tablename='admin_users' and policyname='admin_self_or_tenant') then
    create policy admin_self_or_tenant on agent_core.admin_users
      for select using (
        user_id = nullif(auth.jwt() ->> 'sub','')::uuid
        or tenant_id = agent_core.current_tenant()
      );
  end if;
end $$;

-- No insert/update/delete for end-users; admin management is service-role only.
revoke insert, update, delete on agent_core.admin_users from authenticated, anon, public;
```

#### C. `is_admin()` gate

```sql
create or replace function agent_core.is_admin(
  p_user   uuid default null,
  p_tenant uuid default null  -- null = "anywhere"
) returns boolean
  language sql stable security definer set search_path = agent_core
as $$
  select exists (
    select 1
      from admin_users a
     where a.user_id = coalesce(p_user, nullif(auth.jwt() ->> 'sub','')::uuid)
       and (
         a.role = 'super_admin'
         or (p_tenant is not null and a.tenant_id = p_tenant)
       )
  );
$$;

grant execute on function agent_core.is_admin(uuid, uuid) to authenticated, service_role;
```

`stable` because two calls inside the same statement see consistent results. Grant to `authenticated` so RLS expressions and other functions can call it.

#### D. Admin RPCs

All admin RPCs check `is_admin()` at the top, write a `record_audit_event()` for the action, then perform the work.

```sql
create or replace function agent_core.admin_list_tenants() returns setof jsonb
  language plpgsql security definer set search_path = agent_core
as $$
begin
  if not agent_core.is_admin() then
    raise exception 'admin_list_tenants: not authorized';
  end if;
  return query select to_jsonb(t) from (
    select t.id, t.slug, t.display_name, t.created_at,
      (select count(*) from agent_runs r where r.tenant_id = t.id) as run_count
      from tenants t
     where exists (
       select 1 from admin_users a
        where a.user_id = nullif(auth.jwt() ->> 'sub','')::uuid
          and (a.role = 'super_admin' or a.tenant_id = t.id)
     )
     order by t.created_at desc
  ) t;
end;
$$;

create or replace function agent_core.admin_list_runs(
  p_tenant uuid default null,
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_limit  int default 100
) returns setof jsonb
  language plpgsql security definer set search_path = agent_core
as $$
begin
  if not agent_core.is_admin(null, p_tenant) then
    raise exception 'admin_list_runs: not authorized for tenant %', p_tenant;
  end if;
  return query select to_jsonb(r) from (
    select id, tenant_id, status, model, model_provider,
           tokens_in, tokens_out, cost_estimate, created_at, completed_at, error
      from agent_runs
     where (p_tenant is null or tenant_id = p_tenant)
       and (p_from   is null or created_at >= p_from)
       and (p_to     is null or created_at <= p_to)
     order by created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) r;
end;
$$;

create or replace function agent_core.admin_set_tool(
  p_tenant  uuid,
  p_tool    text,
  p_enabled boolean,
  p_config  jsonb default '{}'::jsonb
) returns void
  language plpgsql security definer set search_path = agent_core
as $$
begin
  if not agent_core.is_admin(null, p_tenant) then
    raise exception 'admin_set_tool: not authorized for tenant %', p_tenant;
  end if;

  insert into tenant_tools (tenant_id, tool_key, enabled, config)
  values (p_tenant, p_tool, p_enabled, coalesce(p_config, '{}'::jsonb))
  on conflict (tenant_id, tool_key) do update
    set enabled = excluded.enabled,
        config  = excluded.config;

  perform agent_core.record_audit_event(
    p_tenant, 'admin.tool.set', p_tool,
    jsonb_build_object('enabled', p_enabled, 'config', p_config),
    null, 'admin', null, null
  );
end;
$$;

create or replace function agent_core.admin_reset_rate_limit(
  p_tenant  uuid,
  p_subject text default null  -- null = all subjects for tenant
) returns int
  language plpgsql security definer set search_path = agent_core
as $$
declare v_deleted int := 0;
begin
  if not agent_core.is_admin(null, p_tenant) then
    raise exception 'admin_reset_rate_limit: not authorized';
  end if;
  delete from rate_limit_counters
   where tenant_id = p_tenant
     and (p_subject is null or subject = p_subject);
  get diagnostics v_deleted = row_count;
  perform agent_core.record_audit_event(
    p_tenant, 'admin.rate_limit.reset', p_subject,
    jsonb_build_object('deleted', v_deleted), null, 'admin', null, null
  );
  return v_deleted;
end;
$$;

create or replace function agent_core.admin_set_admin(
  p_user_id  uuid,
  p_tenant   uuid,         -- pass NULL to grant super_admin
  p_role     text          -- 'tenant_admin' | 'super_admin'
) returns uuid
  language plpgsql security definer set search_path = agent_core
as $$
declare v_id uuid;
begin
  -- Only super_admin can mint other admins.
  if not agent_core.is_admin() then
    raise exception 'admin_set_admin: not authorized';
  end if;
  if not exists (
    select 1 from admin_users
     where user_id = nullif(auth.jwt() ->> 'sub','')::uuid
       and role = 'super_admin'
  ) then
    raise exception 'admin_set_admin: super_admin role required';
  end if;
  if p_role = 'super_admin' and p_tenant is not null then
    raise exception 'admin_set_admin: super_admin must have null tenant';
  end if;
  if p_role = 'tenant_admin' and p_tenant is null then
    raise exception 'admin_set_admin: tenant_admin requires p_tenant';
  end if;

  insert into admin_users (user_id, tenant_id, role, created_by)
  values (p_user_id, p_tenant, p_role, nullif(auth.jwt() ->> 'sub','')::uuid)
  on conflict (user_id, tenant_id) do update set role = excluded.role
  returning id into v_id;

  perform agent_core.record_audit_event(
    coalesce(p_tenant, '00000000-0000-0000-0000-000000000000'::uuid),
    'admin.grant', p_user_id::text,
    jsonb_build_object('role', p_role, 'tenant', p_tenant),
    null, 'admin', null, null
  );

  return v_id;
end;
$$;
```

Grants for all admin RPCs:
```sql
revoke all on function agent_core.admin_list_tenants()                          from public, anon, authenticated;
revoke all on function agent_core.admin_list_runs(uuid, timestamptz, timestamptz, int) from public, anon, authenticated;
revoke all on function agent_core.admin_set_tool(uuid, text, boolean, jsonb)    from public, anon, authenticated;
revoke all on function agent_core.admin_reset_rate_limit(uuid, text)            from public, anon, authenticated;
revoke all on function agent_core.admin_set_admin(uuid, uuid, text)             from public, anon, authenticated;

grant execute on function agent_core.admin_list_tenants()                          to authenticated, service_role;
grant execute on function agent_core.admin_list_runs(uuid, timestamptz, timestamptz, int) to authenticated, service_role;
grant execute on function agent_core.admin_set_tool(uuid, text, boolean, jsonb)    to authenticated, service_role;
grant execute on function agent_core.admin_reset_rate_limit(uuid, text)            to authenticated, service_role;
grant execute on function agent_core.admin_set_admin(uuid, uuid, text)             to authenticated, service_role;
```

End-users may call these from the shell; the gate inside each function does the authorization.

#### E. Re-declare `usage_summary` with the tenant-ownership guard

Per §2/0008-F, the guard in `usage_summary` requires `is_admin()`, which doesn't exist in 0008. The simplest fix is to **re-`create or replace`** `usage_summary` here in 0012 with the guard added:

```sql
create or replace function agent_core.usage_summary(
  p_tenant uuid, p_from timestamptz, p_to timestamptz, p_grain text default 'day'
) returns setof jsonb
  language plpgsql security definer set search_path = agent_core
as $$
begin
  if p_tenant is null then
    raise exception 'usage_summary: tenant required';
  end if;
  if p_tenant <> agent_core.current_tenant() and not agent_core.is_admin(null, p_tenant) then
    raise exception 'usage_summary: tenant mismatch';
  end if;
  ... (rest as in 0008)
end;
$$;
```

This is a valid migration pattern — `create or replace function` replaces the body without dropping permissions or breaking callers.

---

## 3. Index strategy

| Table | Index | Why |
|-------|-------|-----|
| `usage_rollup_daily` | `(tenant_id, day desc)` | Every admin dashboard query is "this tenant, last N days." |
| `tool_usage_rollup_daily` | `(tenant_id, day desc)` | Same. |
| `agent_runs` (ALTER) | `(status, completed_at) WHERE status in ('completed','failed')` | Retention sweep predicate. Partial keeps it small — `running`/`planning` rows never enter the index. |
| `rate_limit_counters` | PK `(tenant_id, subject, window_start, window_secs)` | Covers the UPSERT lookup. No other index needed except… |
| `rate_limit_counters` | `(expires_at)` | …purge job scans by expiry. |
| `audit_log` | `(tenant_id, created_at desc)` | Default admin "show me recent events" query. |
| `audit_log` | `(tenant_id, event, created_at desc)` | Filtered "show me all admin.tool.set events." |
| `audit_log` | `(created_at)` | Retention prune. |
| `admin_users` | `(user_id)` | `is_admin()` lookup. |
| `admin_users` | Unique `(user_id) WHERE tenant_id IS NULL` | Enforces "one super_admin row per user." |

**No covering indexes.** PG planners on these volumes don't need them; the partial + composite indexes above cover every Sprint 6 access pattern.

**No HASH or BRIN indexes.** Volumes are too low to justify; btree covers everything.

---

## 4. Rollup view strategy — recommendation

Three options compared against the same workload assumption: ~50 tenants, peak ~10k runs/day per tenant, dashboard polled every 30s, billing job runs monthly.

| | A — Live view | B — Materialized view | C — Hand-rolled rollup table (recommended) |
|---|---|---|---|
| **Freshness** | Always live | Lag = refresh interval | Lag = refresh interval (same as B) |
| **Read cost** | High — full scan of `agent_runs` filtered to window per query | Low — index scan on a smaller table | Low — index scan on a smaller table |
| **Write cost** | Zero | High — `REFRESH MATERIALIZED VIEW` rebuilds everything; `CONCURRENTLY` requires a UNIQUE index AND a full table scan | Low — incremental refresh of "today + yesterday" only (~10–20k rows) |
| **Storage** | Zero | ~1 row per (tenant, day, model) ≈ 50 × 365 × 5 = ~91k rows/year | Same as B |
| **Survives retention** | No (data lives in agent_runs only) | No (REFRESH would erase pre-retention buckets) | **Yes** — rollup rows are independent records, retention only sweeps `agent_runs` |
| **Backfill** | N/A | Hard — REFRESH does everything or nothing | Easy — `refresh_usage_rollup_daily(some_date, 365)` recomputes any window |
| **Implementation complexity** | Low | Low | Moderate (one refresh function + cron) |
| **Billing reliability** | Poor — billing for last month requires rows older than retention | Poor — REFRESH may have wiped them | **Excellent** — rollups are the system of record for billing |

**Recommendation: C — hand-rolled `usage_rollup_daily` + `tool_usage_rollup_daily`.**

The decisive factor is billing. If we retain raw `agent_runs` for 90 days (the recommended sweep horizon), then on day 91 the previous month's billing source data is gone. A materialized view doesn't help: a REFRESH on day 91 reads the same retained rows, so the bucket for day 1 ends up empty. The only solution is to **persist the aggregate independently** — which is exactly Option C.

Trade-off accepted: 15-minute freshness lag on the dashboard. If a tenant wants real-time, they can call `usage_summary` with their dashboard's date range and PostgreSQL will read from the rollup; "now() bucket" will be stale by up to 15 minutes. This is acceptable for billing-grade observability.

---

## 5. Retention SQL

### Rule

- `agent_runs` (and cascaded `agent_messages`): **delete `status in ('completed','failed')` rows older than 90 days.** `planning` / `running` rows never expire — those are live state.
- `audit_log`: **delete rows older than 365 days.** Audit window is regulatory; one year is a defensible default. Operators can change `p_days`.
- `oauth_states`: **delete `expires_at < now()`** — minute-by-minute, no age threshold.
- `rate_limit_counters`: **delete `expires_at < now()`** — same.
- `tenant_credentials`, `tenant_connections`: NEVER auto-deleted. Manual rotation only.
- `tenants`: NEVER auto-deleted. Operator action via admin RPC.

### Cascade behavior on tenant deletion

`delete from agent_core.tenants where id = X` cascades to (per existing FKs):
- `tenant_credentials` (0001)
- `tenant_tools` (0001)
- `agent_runs` → `agent_messages` (0001)
- `artifacts` (0003) — but rows are deleted, **bytes in storage remain orphaned** (need a separate manual sweep — out of scope for Sprint 6)
- `tenant_connections` → Vault secrets remain (matches existing posture)
- `oauth_states` (0006)
- `usage_rollup_daily` (NEW, 0008)
- `tool_usage_rollup_daily` (NEW, 0008)
- `rate_limit_counters` (NEW, 0009)
- `audit_log` (NEW, 0010)
- `admin_users` rows for that tenant (NEW, 0012)

Every Sprint 6 table includes `references agent_core.tenants(id) on delete cascade` to preserve this property.

### Rollup preservation across raw-run retention

This is the most important design constraint. `retention_sweep_agent_runs(p_days)` ALWAYS calls `refresh_usage_rollup_daily(current_date, p_days+1)` and `refresh_tool_usage_rollup_daily(current_date, p_days+1)` BEFORE the delete. The lookback is `p_days+1` not `p_days` to ensure no edge bucket is missed. Rollups outlive raw runs by design.

### pg_cron jobs for retention (recap, scheduled in their owning migrations)

| Job | Schedule | Owning migration |
|-----|----------|------------------|
| `agent_core:retention_runs` | `30 3 * * *` (03:30 UTC daily) | 0008 |
| `agent_core:audit_prune` | `0 4 * * 0` (Sun 04:00 UTC) | 0010 |
| `agent_core:oauth_states_sweep` | `*/5 * * * *` | 0011 |
| `agent_core:rate_limit_purge` | `*/5 * * * *` | 0009 |

---

## 6. pg_cron setup

### Is pg_cron enabled on Supabase by default?

`pg_cron` is **available** on all Supabase hosted projects but **not enabled** by default. Per Supabase docs, an operator (or a migration) needs to run `create extension pg_cron;` in the `postgres` database. There is no per-database charge.

For self-hosted Supabase / local stacks, `pg_cron` may not be available at all — typically it's in `pg_available_extensions` but not yet installed. The migration handles this with the safe-create pattern in §2/0008-A.

### The exact `cron.schedule` calls

Already shown inline in §2. For convenience, the full list:

```
0008:  agent_core:rollup_refresh_runs    */15 * * * *
0008:  agent_core:rollup_refresh_tools   */15 * * * *
0008:  agent_core:retention_runs         30 3 * * *
0009:  agent_core:rate_limit_purge       */5 * * * *
0010:  agent_core:audit_prune            0 4 * * 0
0011:  agent_core:oauth_states_sweep     */5 * * * *
```

### Idempotency: unschedule-before-schedule

The shared template in §2 does `select jobid from cron.job where jobname = '<name>'` → if found, `perform cron.unschedule(jobid)` → then `cron.schedule(name, ...)`. This makes every cron block safe to re-run.

### Permissions on `cron`

`cron.schedule` and `cron.unschedule` are owned by the `postgres` role on Supabase. Migrations run as `postgres`, so direct calls work. Our SECURITY DEFINER functions never call `cron.*` — they only do the work the cron job invokes.

If we ever need a runtime-side admin RPC to schedule/unschedule (we don't in Sprint 6), it would need `grant usage on schema cron to <role>` and `grant select, insert, update, delete on cron.job to <role>` — explicitly out of scope.

---

## 7. RPC surface drafted (Sprint 6)

Complete list of RPCs added or re-defined by Sprint 6. All are `agent_core.*`.

| RPC | Defined in | Language | SECURITY DEFINER | `search_path` | Service role | Authenticated | Notes |
|---|---|---|---|---|---|---|---|
| `refresh_usage_rollup_daily(date, int) → int` | 0008 | plpgsql | yes | `agent_core` | ✅ execute | ❌ | Called by cron and ad-hoc backfill. |
| `refresh_tool_usage_rollup_daily(date, int) → int` | 0008 | plpgsql | yes | `agent_core` | ✅ execute | ❌ | Same. |
| `usage_summary(uuid, timestamptz, timestamptz, text) → setof jsonb` | 0008 (re-decl in 0012 with auth guard) | plpgsql | yes | `agent_core` | ✅ execute | ✅ execute | End-user safe via internal tenant/admin check. |
| `usage_for_billing(uuid, date) → jsonb` | 0008 | sql | yes | `agent_core` | ✅ execute | ❌ | Back-office only. |
| `retention_sweep_agent_runs(int) → int` | 0008 | plpgsql | yes | `agent_core` | ✅ execute | ❌ | Refuses `p_days < 7`. |
| `check_rate_limit(uuid, text, int, int) → boolean` | 0009 | plpgsql | yes | `agent_core` | ✅ execute | ❌ | Runtime-only. |
| `purge_rate_limit_counters() → int` | 0009 | plpgsql | yes | `agent_core` | ✅ execute | ❌ | Cron-driven. |
| `record_audit_event(uuid, text, text, jsonb, uuid, text, inet, text) → uuid` | 0010 | plpgsql | yes | `agent_core` | ✅ execute | ❌ | Runtime + admin RPCs call this. |
| `query_audit_log(uuid, text, timestamptz, timestamptz, int) → setof jsonb` | 0010 | sql | yes | `agent_core` | ✅ execute | ❌ | Wrapped by admin RPC. |
| `prune_audit_log(int) → int` | 0010 | plpgsql | yes | `agent_core` | ✅ execute | ❌ | Refuses `p_days < 30`. |
| `sweep_oauth_states() → int` | 0011 | plpgsql | yes | `agent_core` | ✅ execute | ❌ | Cron-driven. |
| `is_admin(uuid, uuid) → boolean` | 0012 | sql stable | yes | `agent_core` | ✅ execute | ✅ execute | Pure gate function. |
| `admin_list_tenants() → setof jsonb` | 0012 | plpgsql | yes | `agent_core` | ✅ execute | ✅ execute | Internal auth check via `is_admin`. |
| `admin_list_runs(uuid, timestamptz, timestamptz, int) → setof jsonb` | 0012 | plpgsql | yes | `agent_core` | ✅ execute | ✅ execute | Same. |
| `admin_set_tool(uuid, text, boolean, jsonb) → void` | 0012 | plpgsql | yes | `agent_core` | ✅ execute | ✅ execute | Same. |
| `admin_reset_rate_limit(uuid, text) → int` | 0012 | plpgsql | yes | `agent_core` | ✅ execute | ✅ execute | Same. |
| `admin_set_admin(uuid, uuid, text) → uuid` | 0012 | plpgsql | yes | `agent_core` | ✅ execute | ✅ execute | Super-admin only (checked inside). |

Pattern: every RPC starts with `revoke all ... from public, anon, authenticated;` then re-grants only the roles in the table above. The default-privileges block from `0007` is **not** sufficient on its own — it grants `execute` to `authenticated` by default, and a SECURITY DEFINER function exposed to `authenticated` without an internal tenant check is a privilege escalation. The per-function revoke is non-negotiable.

---

## 8. Backward compat & migration risk

### Will any change break existing 0.1.2 runtime clients?

**No.** Every Sprint 6 migration is additive:
- New tables (`usage_rollup_daily`, `tool_usage_rollup_daily`, `rate_limit_counters`, `audit_log`, `admin_users`).
- New functions (everything in §7).
- One ALTER on `agent_runs`: adds a partial index — **non-blocking** (`create index if not exists` runs without `concurrently` and acquires a SHARE lock; on Supabase the existing volumes are small enough that this completes in under a second).
- No column adds or type changes on existing tables.

The 0.1.2 runtime makes no reference to any of the new objects, so deploying the migrations without redeploying the runtime is safe. The runtime will gain rate-limit middleware in its own PR — until that PR lands, `check_rate_limit` is just an unused function.

### ALTERs on existing tables

Only one: the partial index on `agent_runs(status, completed_at)`. Build time on the live BlackRock project (`gsvhuzpysxaegoecwjmf`) is expected to be sub-second given current volumes. If we ever push into a tenant with >1M `agent_runs`, the implementation agent should switch this to `create index concurrently` and accept the resulting migration cannot run in a transaction (which means hoisting it into its own pre-migration step).

For now: keep it as `create index if not exists` and document the future-concurrent escape hatch in the migration file's comment block.

### Order of `supabase db push` against a live tenant

The live BlackRock project at `gsvhuzpysxaegoecwjmf` already has migrations 0001–0007 applied. Sprint 6 applies in numeric order via `supabase db push`. Recommended sequence:

1. **Backup first.** `supabase db dump --db-url <prod-url> > backup-before-sprint6-$(date +%F).sql`. The migrations are reversible in principle but the rollup-table populate from a 90-day backfill is non-trivial to undo — a dump is the safety net.
2. **Verify pg_cron availability.** `select * from pg_available_extensions where name = 'pg_cron';` — on Supabase hosted this returns one row. If empty, the operator opens a Supabase ticket; Sprint 6 partially regresses (rollups + retention still work via manual psql).
3. **Apply migrations.** `supabase db push` runs them in order. The first one (`0008`) takes the longest because it does the initial `refresh_usage_rollup_daily(current_date, 90)` if we choose to seed it (recommended — done as a manual `select agent_core.refresh_usage_rollup_daily(current_date, 90);` after the migration, NOT inside it, to keep the migration transaction-bounded).
4. **Verify.** `bun run packages/schema/scripts/verify-metering.ts` and `verify-rate-limits.ts` (see §9).
5. **Schedule check.** `select jobname, schedule, active from cron.job where jobname like 'agent_core:%';` should list six jobs.

Nothing in Sprint 6 affects the runtime's existing queries — there is no need to coordinate a runtime redeploy with the migration push. They can ship in either order.

---

## 9. Verify scripts to update

### Existing scripts that need updating

| Script | Update |
|--------|--------|
| `verify-migrations.sh` | Already iterates `*.sql` in lexicographic order — picks up `0008`–`0012` automatically. No code change needed. Verify it still parks cleanly when `pg_cron` is absent on the local stack (it will — the safe-create pattern). Add a smoke test that `select count(*) from cron.job where jobname like 'agent_core:%'` returns 6 when pg_cron IS available. |
| `verify-isolation.ts` | Add two new invariants: (5) new tables (`usage_rollup_daily`, `audit_log`, `admin_users`) all have RLS enabled and a tenant_isolation policy, by querying `pg_policies`; (6) anon role cannot call `usage_summary`, `query_audit_log`, `record_audit_event`. |
| `verify-connections.ts` | No change — unrelated surface. |
| `verify-streaming.ts` | No change — unrelated surface. |
| `verify-tools.ts` | No change — unrelated surface. |
| `verify-persistence-live.sh` | Optionally add a step that exercises rate-limit + audit RPCs end-to-end if the schema is live. Not required. |

### New scripts to add

| Script | Purpose | Assertions |
|--------|---------|------------|
| `packages/schema/scripts/verify-metering.ts` | Prove the rollup pipeline works on a live Supabase. | (1) Seed N agent_runs across 3 days. (2) Call `refresh_usage_rollup_daily(today, 5)`. (3) Read `usage_rollup_daily` for that tenant and assert sums match. (4) Call `usage_summary(tenant, today-2, today, 'day')` and assert 3 buckets. (5) Call `usage_for_billing(tenant, current_month)` and assert keys present. Park if pg_cron unavailable, but the manual refresh path must still work. |
| `packages/schema/scripts/verify-rate-limits.ts` | Prove the counter is atomic and bounded. | (1) Call `check_rate_limit(t, 'test', 60, 3)` four times in a row. First three return true, fourth returns false. (2) Fire 100 concurrent calls (via `Promise.all`) and assert exactly `limit` calls returned true. (3) Wait 70s, assert window rolls over and a new call returns true. (Park the time-based assertion with a `SKIP_SLOW` env knob.) |
| `packages/schema/scripts/verify-audit.ts` | Prove audit_log is append-only, RPC-queryable, gated correctly. | (1) `record_audit_event` writes a row. (2) `authenticated` role can SELECT only their tenant's audit rows. (3) `authenticated` cannot UPDATE/DELETE — confirms the targeted REVOKE landed. (4) `prune_audit_log(30)` raises (refuses < 30 days). |
| `packages/schema/scripts/verify-admin.ts` | Prove the admin gate works and admin RPCs respect tenant scoping. | (1) Non-admin call to `admin_list_tenants` raises. (2) Tenant-admin sees only their tenant via `admin_list_tenants`. (3) Super-admin sees everything. (4) `admin_set_tool` writes through to `tenant_tools` and emits an audit event. (5) `admin_set_admin` requires super-admin. |

All new scripts follow the existing `verify-*.ts` shape: `park` on missing env or unreachable Supabase, `[ok] invariant N` / `[fail] invariant N`, exit-code-clean.

### Update to root `package.json` scripts

Add (in the schema package's `package.json`):
```json
"verify:metering":     "bun packages/schema/scripts/verify-metering.ts",
"verify:rate-limits":  "bun packages/schema/scripts/verify-rate-limits.ts",
"verify:audit":        "bun packages/schema/scripts/verify-audit.ts",
"verify:admin":        "bun packages/schema/scripts/verify-admin.ts"
```

And a roll-up `verify:all` script that fans them out.

---

## 10. Implementation order (recommended)

The migrations must be implemented in number order (0008 → 0009 → 0010 → 0011 → 0012), but **within each, the implementation agent should land the table + indexes + RLS first, get `verify-migrations.sh` green, then layer in the functions and cron jobs.** That preserves a clean bisect path if a later commit breaks one of the verify scripts.

For 0012 specifically: implement `admin_users` + `is_admin` + the admin RPCs first; the re-decl of `usage_summary` to add the tenant guard happens last in the same file. Reordering is fine — there's no SQL dependency, only narrative dependency in this doc.

---

## 11. Open questions / explicitly out of scope

These are decisions deferred to a later sprint, called out so the implementation agent doesn't accidentally solve them:

1. **Vault secret cleanup on `tenant_credentials` delete.** Migration 0002's TODO is still open — not Sprint 6's job.
2. **Storage bytes orphaned by `tenants` cascade.** Mentioned in §5 — Sprint 6 doesn't add a sweep.
3. **`agent_messages` retention independent of `agent_runs`.** Out of scope; messages cascade with runs.
4. **Real-time rollups (< 15-minute lag).** If the dashboard later requires real-time, the answer is "extend `usage_summary` to UNION the rollup table with a live aggregate over the current quarter-hour window." Not in Sprint 6.
5. **Tenant-level configurable retention (`p_days` per tenant).** The cron uses a hard-coded 90/365; if tenants need different windows, add a `tenants.retention_days` column and a wrapper RPC. Not in Sprint 6.
6. **Per-IP rate limiting.** Sprint 6 rate-limits per tenant + subject only. IP-based limiting (e.g. for the OAuth callback) needs a different schema (no tenant_id) and is deferred.

---

## 12. Summary for implementation agents

Five migration files, in `packages/schema/migrations/`:
- `0008_metering.sql` — enables pg_cron; adds `usage_rollup_daily`, `tool_usage_rollup_daily`, two refresh RPCs, `usage_summary`, `usage_for_billing`, `retention_sweep_agent_runs`; schedules 3 cron jobs.
- `0009_rate_limits.sql` — adds `rate_limit_counters`, `check_rate_limit`, `purge_rate_limit_counters`; schedules 1 cron job.
- `0010_audit_log.sql` — adds `audit_log`, `record_audit_event`, `query_audit_log`, `prune_audit_log`; schedules 1 cron job.
- `0011_oauth_states_sweeper.sql` — adds `sweep_oauth_states`; schedules 1 cron job.
- `0012_admin_users.sql` — adds `admin_users`, `is_admin`, 5 admin RPCs; re-declares `usage_summary` with tenant guard.

Four new verify scripts under `packages/schema/scripts/`: `verify-metering.ts`, `verify-rate-limits.ts`, `verify-audit.ts`, `verify-admin.ts`. Plus a small expansion to `verify-isolation.ts` for the new tables.

Every object lives in `agent_core`. Every function is `security definer` with `search_path = agent_core`. Every tenant-data table has RLS with `tenant_id = agent_core.current_tenant()`. Every cron job is namespaced `agent_core:*` and uses the unschedule-before-schedule idempotency pattern. Every RPC explicitly revokes from `public, anon, authenticated` and grants to `service_role` (and `authenticated` only when the function has an internal tenant/admin check).

Nothing in Sprint 6 alters the runtime's existing query surface — the migrations can ship before, during, or after the runtime PR that adds rate-limiting middleware.
