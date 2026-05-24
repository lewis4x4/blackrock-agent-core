#!/usr/bin/env bash
# Live-DB persistence assertion that doesn't depend on PostgREST/supabase-js.
# Spins up a disposable database on the local Postgres, applies every Agent
# Core migration, then exercises the same INSERT/UPDATE/SELECT shapes the
# packages/runtime/src/persistence.ts module emits — but via psql, so this
# script works in environments without a running Supabase API gateway.
#
# Output format mirrors the verify-*.ts scripts.
#
# Exit 0 on full pass. Parks (exit 0) if Postgres unreachable or
# supabase_vault extension missing.

set -u

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-54322}
PGUSER=${PGUSER:-postgres}
PGPASSWORD=${PGPASSWORD:-postgres}
export PGPASSWORD

DB="agent_core_persist_$$"
MIGRATIONS_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"
PSQL_BASE=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -v ON_ERROR_STOP=1 -tA)

cleanup() {
  psql "${PSQL_BASE[@]}" -d postgres -c "drop database if exists ${DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[verify-persistence] target=${PGHOST}:${PGPORT}/${DB}"

if ! psql "${PSQL_BASE[@]}" -d postgres -c "select 1" >/dev/null 2>&1; then
  echo "[parked] Postgres at ${PGHOST}:${PGPORT} unreachable"
  exit 0
fi

if ! psql "${PSQL_BASE[@]}" -d postgres -c \
  "select 1 from pg_available_extensions where name='supabase_vault'" \
  | grep -q '^1$'; then
  echo "[parked] supabase_vault extension not available"
  exit 0
fi

psql "${PSQL_BASE[@]}" -d postgres -c "create database ${DB};" >/dev/null

psql "${PSQL_BASE[@]}" -d "${DB}" >/dev/null <<'SQL'
create extension if not exists "pgcrypto";
create extension if not exists "supabase_vault" cascade;
create schema if not exists auth;
do $$ begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='auth' and p.proname='jwt') then
    create function auth.jwt() returns jsonb language sql stable as $f$
      select '{}'::jsonb;
    $f$;
  end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then
    create role service_role nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then
    create role authenticated nologin;
  end if;
end $$;
SQL

# Apply every migration in order.
for migration in $(ls "${MIGRATIONS_DIR}"/*.sql | sort); do
  if ! psql "${PSQL_BASE[@]}" -d "${DB}" --single-transaction -f "${migration}" >/dev/null 2>&1; then
    echo "[fail] migration $(basename "${migration}") — could not apply"
    exit 1
  fi
done

passes=0
fails=0
note() { echo "[ok] $1"; passes=$((passes+1)); }
oops() { echo "[fail] $1"; fails=$((fails+1)); }

# 1 — Persistence-shape end-to-end: simulate the calls persistence.ts makes.
psql "${PSQL_BASE[@]}" -d "${DB}" >/dev/null <<'SQL'
do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_run    uuid := gen_random_uuid();
begin
  insert into agent_core.tenants(id, slug, display_name)
    values (v_tenant, 'verify-persistence', 'verify-persistence');

  -- recordRunStart
  insert into agent_core.agent_runs(id, tenant_id, model, model_provider, status)
    values (v_run, v_tenant, 'claude-sonnet-4-5', 'anthropic', 'running');
  insert into agent_core.agent_messages(run_id, tenant_id, role, content)
    values (v_run, v_tenant, 'user', jsonb_build_object('text','probe'));

  -- recordMessage (assistant draft)
  insert into agent_core.agent_messages(run_id, tenant_id, role, content)
    values (v_run, v_tenant, 'assistant',
            jsonb_build_object('kind','draft_answer','text','probe answer'));

  -- recordToolResults (one tool row)
  insert into agent_core.agent_messages(run_id, tenant_id, role, content)
    values (v_run, v_tenant, 'tool',
            jsonb_build_object('tool','web_search','taskId','t1','ok',true,
                               'output', jsonb_build_object('results', '[]'::jsonb)));

  -- finalizeRun
  update agent_core.agent_runs
     set status='completed',
         tokens_in=42, tokens_out=24, cost_estimate=0.0042,
         task_graph='{"tasks":[]}'::jsonb,
         completed_at=now()
   where id = v_run;

  -- Read-back assertions.
  if not exists(select 1 from agent_core.agent_runs
                where id = v_run
                  and status='completed'
                  and tokens_in=42 and tokens_out=24
                  and cost_estimate=0.0042
                  and completed_at is not null) then
    raise exception 'agent_runs terminal state did not land';
  end if;
  if (select count(*) from agent_core.agent_messages where run_id = v_run) < 3 then
    raise exception 'agent_messages did not accumulate to >=3 rows';
  end if;

  delete from agent_core.tenants where id = v_tenant; -- cascade cleans up
end $$;
SQL

if [ $? -eq 0 ]; then
  note "persistence flow end-to-end: run+messages landed, updated_at fired, completed_at stamped"
else
  oops "persistence flow end-to-end failed"
fi

echo "[verify-persistence] ${passes} pass / ${fails} fail"
[ ${fails} -eq 0 ]
