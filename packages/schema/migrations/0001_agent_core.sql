-- Agent Core — migration 0001 — multi-tenant foundation.
-- Applied into EACH client's own Supabase project (never a shared database).

create schema if not exists agent_core;
create extension if not exists "pgcrypto";

-- Tenants -------------------------------------------------------------------
create table if not exists agent_core.tenants (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  display_name  text not null,
  created_at    timestamptz not null default now()
);

-- Per-tenant credentials. Stores only a Vault pointer, never a raw key. -----
create table if not exists agent_core.tenant_credentials (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references agent_core.tenants(id) on delete cascade,
  provider    text not null,            -- anthropic | openai | hubspot | m365 ...
  secret_ref  uuid not null,            -- pointer into Supabase Vault
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  unique (tenant_id, provider)
);

-- Which tools are enabled for a tenant. This is the "configure, don't rebuild"
-- layer — the orchestrator is generic, this table makes it tenant-specific. --
create table if not exists agent_core.tenant_tools (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references agent_core.tenants(id) on delete cascade,
  tool_key   text not null,
  enabled    boolean not null default true,
  config     jsonb not null default '{}',
  unique (tenant_id, tool_key)
);

-- Every agent invocation — for metering and audit. -------------------------
create table if not exists agent_core.agent_runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references agent_core.tenants(id) on delete cascade,
  user_id         uuid,
  status          text not null default 'planning',
  task_graph      jsonb,
  model_provider  text,
  tokens_in       int not null default 0,
  tokens_out      int not null default 0,
  cost_estimate   numeric not null default 0,
  created_at      timestamptz not null default now()
);

create table if not exists agent_core.agent_messages (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references agent_core.agent_runs(id) on delete cascade,
  tenant_id   uuid not null references agent_core.tenants(id) on delete cascade,
  role        text not null check (role in ('user','assistant','tool')),
  content     jsonb not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_tenant_credentials_tenant on agent_core.tenant_credentials(tenant_id);
create index if not exists idx_tenant_tools_tenant       on agent_core.tenant_tools(tenant_id);
create index if not exists idx_agent_runs_tenant         on agent_core.agent_runs(tenant_id, created_at desc);
create index if not exists idx_agent_messages_run        on agent_core.agent_messages(run_id);

-- Row Level Security: every table isolated by the tenant_id JWT claim. ------
alter table agent_core.tenants            enable row level security;
alter table agent_core.tenant_credentials enable row level security;
alter table agent_core.tenant_tools       enable row level security;
alter table agent_core.agent_runs         enable row level security;
alter table agent_core.agent_messages     enable row level security;

create or replace function agent_core.current_tenant() returns uuid
  language sql stable
as $$
  select nullif(auth.jwt() ->> 'tenant_id', '')::uuid
$$;

create policy tenant_isolation on agent_core.tenants
  for all using (id = agent_core.current_tenant())        with check (id = agent_core.current_tenant());
create policy tenant_isolation on agent_core.tenant_credentials
  for all using (tenant_id = agent_core.current_tenant()) with check (tenant_id = agent_core.current_tenant());
create policy tenant_isolation on agent_core.tenant_tools
  for all using (tenant_id = agent_core.current_tenant()) with check (tenant_id = agent_core.current_tenant());
create policy tenant_isolation on agent_core.agent_runs
  for all using (tenant_id = agent_core.current_tenant()) with check (tenant_id = agent_core.current_tenant());
create policy tenant_isolation on agent_core.agent_messages
  for all using (tenant_id = agent_core.current_tenant()) with check (tenant_id = agent_core.current_tenant());

-- NOTE: tenant_credentials stores only secret_ref (a Vault pointer). Raw API
-- keys live in Supabase Vault and are resolved server-side by the Edge
-- Function. They are never exposed to the browser.
