-- Agent Core — migration 0015 — admin users + admin-aware tenant isolation policies.

create table if not exists agent_core.admin_users (
  user_id uuid not null,
  tenant_id uuid references agent_core.tenants(id) on delete cascade,
  role text not null check (role in ('superadmin', 'tenant_admin', 'tenant_viewer')),
  granted_by uuid,
  granted_at timestamptz not null default now()
);

create unique index if not exists uq_admin_users_user_tenant
  on agent_core.admin_users (user_id, tenant_id)
  where tenant_id is not null;

create unique index if not exists uq_admin_users_superadmin
  on agent_core.admin_users (user_id)
  where tenant_id is null;

create index if not exists idx_admin_users_tenant_role
  on agent_core.admin_users (tenant_id, role);

create index if not exists idx_admin_users_user_id
  on agent_core.admin_users (user_id);

alter table agent_core.admin_users enable row level security;

drop policy if exists tenant_isolation on agent_core.admin_users;
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'admin_users'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.admin_users
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or tenant_id is null
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or tenant_id is null
      );
  end if;
end $$;

revoke all on table agent_core.admin_users from public, anon;
revoke all on table agent_core.admin_users from authenticated;
grant all on table agent_core.admin_users to service_role;
grant select on table agent_core.admin_users to authenticated;

create or replace function agent_core.current_admin_role()
returns text
  language sql
  stable
  set search_path = agent_core, public
as $$
  select nullif(auth.jwt() ->> 'admin_role', '');
$$;

grant execute on function agent_core.current_admin_role() to authenticated, service_role;

create or replace function agent_core.is_admin(
  p_tenant uuid default null,
  p_min_role text default 'tenant_viewer'
) returns boolean
  language plpgsql
  stable
  set search_path = agent_core, public
as $$
declare
  v_role text;
  v_jwt_tenant uuid;
begin
  v_role := agent_core.current_admin_role();

  if v_role is null then
    return false;
  end if;

  if v_role = 'superadmin' then
    return true;
  end if;

  v_jwt_tenant := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;

  if v_role = 'tenant_admin' then
    if p_tenant is null then
      return true;
    end if;

    return (
      p_tenant = v_jwt_tenant
      and p_min_role in ('tenant_viewer', 'tenant_admin')
    );
  end if;

  if v_role = 'tenant_viewer' then
    if p_tenant is null then
      return true;
    end if;

    return (
      p_tenant = v_jwt_tenant
      and p_min_role = 'tenant_viewer'
    );
  end if;

  return false;
end;
$$;

grant execute on function agent_core.is_admin(uuid, text) to authenticated, service_role;

-- Extend tenant-isolation policies with admin escape hatch.

drop policy if exists tenant_isolation on agent_core.tenants;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'tenants'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.tenants
      for all
      using (
        id = agent_core.current_tenant()
        or agent_core.is_admin(id, 'tenant_viewer')
      )
      with check (
        id = agent_core.current_tenant()
        or agent_core.is_admin(id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.tenant_credentials;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'tenant_credentials'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.tenant_credentials
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.tenant_tools;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'tenant_tools'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.tenant_tools
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.agent_runs;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'agent_runs'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.agent_runs
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.agent_messages;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'agent_messages'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.agent_messages
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.artifacts;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'artifacts'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.artifacts
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.tenant_connections;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'tenant_connections'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.tenant_connections
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

-- Keep oauth_states tenant-only (no admin bypass).
drop policy if exists tenant_isolation on agent_core.oauth_states;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'oauth_states'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.oauth_states
      for all
      using (tenant_id = agent_core.current_tenant())
      with check (tenant_id = agent_core.current_tenant());
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.audit_log;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'audit_log'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.audit_log
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or tenant_id is null
        or (tenant_id is not null and agent_core.is_admin(tenant_id, 'tenant_viewer'))
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or tenant_id is null
        or (tenant_id is not null and agent_core.is_admin(tenant_id, 'tenant_viewer'))
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.rate_limit_counters;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'rate_limit_counters'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.rate_limit_counters
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.tenant_quotas;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'tenant_quotas'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.tenant_quotas
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.run_llm_calls;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'run_llm_calls'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.run_llm_calls
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.tool_invocations;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'tool_invocations'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.tool_invocations
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.usage_rollup_daily;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'usage_rollup_daily'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.usage_rollup_daily
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;

drop policy if exists tenant_isolation on agent_core.tool_usage_rollup_daily;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'agent_core'
      and tablename = 'tool_usage_rollup_daily'
      and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on agent_core.tool_usage_rollup_daily
      for all
      using (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      )
      with check (
        tenant_id = agent_core.current_tenant()
        or agent_core.is_admin(tenant_id, 'tenant_viewer')
      );
  end if;
end $$;
