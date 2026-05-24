-- Agent Core — migration 0005 — agent_runs lifecycle columns.

alter table agent_core.agent_runs
  add column if not exists model         text,
  add column if not exists updated_at    timestamptz not null default now(),
  add column if not exists completed_at  timestamptz,
  add column if not exists error         text;

create or replace function agent_core.agent_runs_touch_updated_at() returns trigger
  language plpgsql
  set search_path = agent_core
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists agent_runs_touch_updated_at on agent_core.agent_runs;
create trigger agent_runs_touch_updated_at
  before update on agent_core.agent_runs
  for each row execute function agent_core.agent_runs_touch_updated_at();

create index if not exists idx_agent_runs_tenant_completed
  on agent_core.agent_runs(tenant_id, completed_at desc) where completed_at is not null;

-- [PART 1 COMPLETE]
