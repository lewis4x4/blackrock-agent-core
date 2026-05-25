-- Agent Core — migration 0016 — admin RPC surface.

create or replace function agent_core._log_cross_tenant_if_needed(
  p_actor_user uuid,
  p_target_tenant uuid,
  p_op text,
  p_severity text,
  p_resource text default null
) returns void
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor_tenant uuid;
begin
  if p_target_tenant is null then
    return;
  end if;

  if agent_core.current_admin_role() <> 'superadmin' then
    return;
  end if;

  v_actor_tenant := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;

  if v_actor_tenant is not null and v_actor_tenant = p_target_tenant then
    return;
  end if;

  perform agent_core.record_audit_event(
    p_target_tenant,
    'cross_tenant_access',
    p_severity,
    coalesce(p_resource, p_op),
    jsonb_build_object(
      'actor_user_id', p_actor_user,
      'accessed_tenant_id', p_target_tenant,
      'operation', p_op,
      'resource', p_resource
    )
  );
end;
$$;

revoke execute on function agent_core._log_cross_tenant_if_needed(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function agent_core._log_cross_tenant_if_needed(uuid, uuid, text, text, text)
  to service_role;

create or replace function agent_core.admin_list_tenants()
returns setof agent_core.tenants
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_role text := agent_core.current_admin_role();
  v_tenant uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
begin
  if v_role = 'superadmin' then
    return query
      select t.*
      from agent_core.tenants t
      order by t.created_at desc;
  end if;

  if v_role = 'tenant_admin' and v_tenant is not null then
    return query
      select t.*
      from agent_core.tenants t
      where t.id = v_tenant;
    return;
  end if;

  raise exception 'admin_list_tenants: not authorized';
end;
$$;

revoke execute on function agent_core.admin_list_tenants()
  from public, anon, authenticated;
grant execute on function agent_core.admin_list_tenants()
  to service_role;

create or replace function agent_core.admin_create_tenant(
  p_slug text,
  p_display_name text
) returns agent_core.tenants
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_row agent_core.tenants%rowtype;
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if agent_core.current_admin_role() <> 'superadmin' then
    raise exception 'admin_create_tenant: superadmin required';
  end if;

  insert into agent_core.tenants (slug, display_name)
  values (p_slug, p_display_name)
  returning * into v_row;

  insert into agent_core.tenant_quotas (tenant_id)
  values (v_row.id)
  on conflict (tenant_id) do nothing;

  perform agent_core.record_audit_event(
    v_row.id,
    'tenant_created',
    'warn',
    'tenants',
    jsonb_build_object('actor_user_id', v_actor, 'slug', p_slug)
  );

  return v_row;
end;
$$;

revoke execute on function agent_core.admin_create_tenant(text, text)
  from public, anon, authenticated;
grant execute on function agent_core.admin_create_tenant(text, text)
  to service_role;

create or replace function agent_core.admin_update_tenant(
  p_id uuid,
  p_slug text,
  p_display_name text
) returns agent_core.tenants
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_row agent_core.tenants%rowtype;
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_id, 'tenant_admin') then
    raise exception 'admin_update_tenant: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_id, 'admin_update_tenant', 'warn', 'tenants');

  update agent_core.tenants
     set slug = coalesce(p_slug, slug),
         display_name = coalesce(p_display_name, display_name)
   where id = p_id
   returning * into v_row;

  if v_row.id is null then
    raise exception 'admin_update_tenant: tenant not found';
  end if;

  perform agent_core.record_audit_event(
    p_id,
    'tenant_updated',
    'warn',
    'tenants',
    jsonb_build_object('actor_user_id', v_actor)
  );

  return v_row;
end;
$$;

revoke execute on function agent_core.admin_update_tenant(uuid, text, text)
  from public, anon, authenticated;
grant execute on function agent_core.admin_update_tenant(uuid, text, text)
  to service_role;

create or replace function agent_core.admin_set_tenant_paused(
  p_id uuid,
  p_paused boolean
) returns void
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_id, 'tenant_admin') then
    raise exception 'admin_set_tenant_paused: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_id, 'admin_set_tenant_paused', 'warn', 'tenant_quotas');

  insert into agent_core.tenant_quotas (tenant_id, paused)
  values (p_id, coalesce(p_paused, false))
  on conflict (tenant_id) do update
    set paused = excluded.paused,
        updated_at = now();

  perform agent_core.record_audit_event(
    p_id,
    case when p_paused then 'tenant_paused' else 'tenant_unpaused' end,
    'warn',
    'tenant_quotas',
    jsonb_build_object('actor_user_id', v_actor)
  );
end;
$$;

revoke execute on function agent_core.admin_set_tenant_paused(uuid, boolean)
  from public, anon, authenticated;
grant execute on function agent_core.admin_set_tenant_paused(uuid, boolean)
  to service_role;

create or replace function agent_core.admin_list_runs(
  p_tenant uuid default null,
  p_status text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 100,
  p_offset int default 0
) returns setof agent_core.agent_runs
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
  v_tenant uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_viewer') then
    raise exception 'admin_list_runs: not authorized';
  end if;

  if p_tenant is not null then
    perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_list_runs', 'info', 'agent_runs');
  end if;

  return query
    select r.*
    from agent_core.agent_runs r
    where (
      (p_tenant is null and (agent_core.current_admin_role() = 'superadmin' or r.tenant_id = v_tenant))
      or (p_tenant is not null and r.tenant_id = p_tenant)
    )
      and (p_status is null or r.status = p_status)
      and (p_from is null or r.created_at >= p_from)
      and (p_to is null or r.created_at <= p_to)
    order by r.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke execute on function agent_core.admin_list_runs(uuid, text, timestamptz, timestamptz, int, int)
  from public, anon, authenticated;
grant execute on function agent_core.admin_list_runs(uuid, text, timestamptz, timestamptz, int, int)
  to service_role;

create or replace function agent_core.admin_get_run(
  p_run_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_run agent_core.agent_runs%rowtype;
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
  v_result jsonb;
begin
  select * into v_run
  from agent_core.agent_runs
  where id = p_run_id;

  if v_run.id is null then
    raise exception 'admin_get_run: run not found';
  end if;

  if not agent_core.is_admin(v_run.tenant_id, 'tenant_viewer') then
    raise exception 'admin_get_run: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, v_run.tenant_id, 'admin_get_run', 'info', 'agent_runs');

  select jsonb_build_object(
    'run', to_jsonb(v_run),
    'plan', coalesce(v_run.task_graph, '{}'::jsonb),
    'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at) from agent_core.agent_messages m where m.run_id = v_run.id), '[]'::jsonb),
    'llm_calls', coalesce((select jsonb_agg(to_jsonb(c) order by c.started_at) from agent_core.run_llm_calls c where c.run_id = v_run.id), '[]'::jsonb),
    'tool_invocations', coalesce((select jsonb_agg(to_jsonb(ti) order by ti.started_at) from agent_core.tool_invocations ti where ti.run_id = v_run.id), '[]'::jsonb),
    'cost_summary', jsonb_build_object(
      'run_cost_estimate', coalesce(v_run.cost_estimate, 0),
      'llm_cost_usd', coalesce((select sum(c.cost_usd) from agent_core.run_llm_calls c where c.run_id = v_run.id), 0),
      'tool_cost_usd', coalesce((select sum(ti.external_cost_estimate_usd) from agent_core.tool_invocations ti where ti.run_id = v_run.id), 0)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function agent_core.admin_get_run(uuid)
  from public, anon, authenticated;
grant execute on function agent_core.admin_get_run(uuid)
  to service_role;

create or replace function agent_core.admin_list_tools(
  p_tenant uuid
) returns table(tool_key text, enabled boolean, config jsonb)
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_viewer') then
    raise exception 'admin_list_tools: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_list_tools', 'info', 'tenant_tools');

  return query
    select t.tool_key, t.enabled, t.config
    from agent_core.tenant_tools t
    where t.tenant_id = p_tenant
    order by t.tool_key;
end;
$$;

revoke execute on function agent_core.admin_list_tools(uuid)
  from public, anon, authenticated;
grant execute on function agent_core.admin_list_tools(uuid)
  to service_role;

create or replace function agent_core.admin_set_tool_enabled(
  p_tenant uuid,
  p_tool_key text,
  p_enabled boolean,
  p_config jsonb default null
) returns void
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_admin') then
    raise exception 'admin_set_tool_enabled: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_set_tool_enabled', 'warn', 'tenant_tools');

  insert into agent_core.tenant_tools (tenant_id, tool_key, enabled, config)
  values (p_tenant, p_tool_key, p_enabled, coalesce(p_config, '{}'::jsonb))
  on conflict (tenant_id, tool_key) do update
    set enabled = excluded.enabled,
        config = coalesce(excluded.config, agent_core.tenant_tools.config);

  perform agent_core.record_audit_event(
    p_tenant,
    'tool_toggled',
    'warn',
    p_tool_key,
    jsonb_build_object('actor_user_id', v_actor, 'enabled', p_enabled)
  );
end;
$$;

revoke execute on function agent_core.admin_set_tool_enabled(uuid, text, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.admin_set_tool_enabled(uuid, text, boolean, jsonb)
  to service_role;

create or replace function agent_core.admin_list_connections(
  p_tenant uuid
) returns table(
  id uuid,
  provider text,
  account_label text,
  status text,
  expires_at timestamptz,
  scopes text[],
  created_at timestamptz
)
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_viewer') then
    raise exception 'admin_list_connections: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_list_connections', 'info', 'tenant_connections');

  return query
    select tc.id, tc.provider, tc.account_label, tc.status, tc.expires_at, tc.scopes, tc.created_at
    from agent_core.tenant_connections tc
    where tc.tenant_id = p_tenant
    order by tc.created_at desc;
end;
$$;

revoke execute on function agent_core.admin_list_connections(uuid)
  from public, anon, authenticated;
grant execute on function agent_core.admin_list_connections(uuid)
  to service_role;

create or replace function agent_core.admin_revoke_connection(
  p_connection_id uuid
) returns void
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_row agent_core.tenant_connections%rowtype;
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  select * into v_row
  from agent_core.tenant_connections
  where id = p_connection_id;

  if v_row.id is null then
    raise exception 'admin_revoke_connection: connection not found';
  end if;

  if not agent_core.is_admin(v_row.tenant_id, 'tenant_admin') then
    raise exception 'admin_revoke_connection: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, v_row.tenant_id, 'admin_revoke_connection', 'warn', 'tenant_connections');

  update agent_core.tenant_connections
     set status = 'revoked',
         secret_ref = null,
         refresh_secret_ref = null,
         updated_at = now()
   where id = p_connection_id;

  delete from vault.secrets
   where id in (v_row.secret_ref, v_row.refresh_secret_ref)
     and id is not null;

  perform agent_core.record_audit_event(
    v_row.tenant_id,
    'oauth_revoked',
    'warn',
    v_row.provider,
    jsonb_build_object('actor_user_id', v_actor, 'connection_id', p_connection_id)
  );
end;
$$;

revoke execute on function agent_core.admin_revoke_connection(uuid)
  from public, anon, authenticated;
grant execute on function agent_core.admin_revoke_connection(uuid)
  to service_role;

create or replace function agent_core.admin_list_credentials(
  p_tenant uuid
) returns table(
  id uuid,
  provider text,
  meta jsonb,
  created_at timestamptz
)
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_viewer') then
    raise exception 'admin_list_credentials: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_list_credentials', 'info', 'tenant_credentials');

  return query
    select c.id, c.provider,
      jsonb_build_object(
        'meta', c.meta,
        'secret_exists', c.secret_ref is not null
      ) as meta,
      c.created_at
    from agent_core.tenant_credentials c
    where c.tenant_id = p_tenant
    order by c.created_at desc;
end;
$$;

revoke execute on function agent_core.admin_list_credentials(uuid)
  from public, anon, authenticated;
grant execute on function agent_core.admin_list_credentials(uuid)
  to service_role;

create or replace function agent_core.admin_rotate_credential(
  p_tenant uuid,
  p_provider text,
  p_new_secret text
) returns void
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_admin') then
    raise exception 'admin_rotate_credential: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_rotate_credential', 'warn', 'tenant_credentials');

  perform agent_core.store_tenant_credential(
    p_tenant,
    p_provider,
    p_new_secret,
    jsonb_build_object('rotated_by', v_actor, 'rotated_at', now())
  );

  perform agent_core.record_audit_event(
    p_tenant,
    'secret_rotated',
    'warn',
    p_provider,
    jsonb_build_object('actor_user_id', v_actor, 'provider', p_provider)
  );
end;
$$;

revoke execute on function agent_core.admin_rotate_credential(uuid, text, text)
  from public, anon, authenticated;
grant execute on function agent_core.admin_rotate_credential(uuid, text, text)
  to service_role;

create or replace function agent_core.admin_list_admins(
  p_tenant uuid default null
) returns setof agent_core.admin_users
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_tenant uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if p_tenant is not null then
    perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_list_admins', 'info', 'admin_users');
  end if;

  if agent_core.current_admin_role() = 'superadmin' then
    return query
      select a.*
      from agent_core.admin_users a
      where p_tenant is null or a.tenant_id = p_tenant
      order by a.granted_at desc;
    return;
  end if;

  if agent_core.current_admin_role() = 'tenant_admin' and v_tenant is not null then
    return query
      select a.*
      from agent_core.admin_users a
      where a.tenant_id = v_tenant
      order by a.granted_at desc;
    return;
  end if;

  raise exception 'admin_list_admins: not authorized';
end;
$$;

revoke execute on function agent_core.admin_list_admins(uuid)
  from public, anon, authenticated;
grant execute on function agent_core.admin_list_admins(uuid)
  to service_role;

create or replace function agent_core.admin_set_admin(
  p_user_id uuid,
  p_tenant uuid,
  p_role text
) returns agent_core.admin_users
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_row agent_core.admin_users%rowtype;
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
  v_actor_tenant uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
begin
  if p_tenant is not null then
    perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_set_admin', 'warn', 'admin_users');
  end if;

  if p_role not in ('superadmin', 'tenant_admin', 'tenant_viewer') then
    raise exception 'admin_set_admin: invalid role';
  end if;

  if agent_core.current_admin_role() = 'superadmin' then
    if p_role = 'superadmin' and p_tenant is not null then
      raise exception 'admin_set_admin: superadmin must have null tenant';
    end if;
  elsif agent_core.current_admin_role() = 'tenant_admin' then
    if p_role = 'superadmin' then
      raise exception 'admin_set_admin: tenant_admin cannot grant superadmin';
    end if;
    if p_tenant is distinct from v_actor_tenant then
      raise exception 'admin_set_admin: tenant_admin can only manage own tenant';
    end if;
  else
    raise exception 'admin_set_admin: not authorized';
  end if;

  if p_tenant is null then
    insert into agent_core.admin_users (user_id, tenant_id, role, granted_by)
    values (p_user_id, null, p_role, v_actor)
    on conflict (user_id) where tenant_id is null
    do update set role = excluded.role, granted_by = excluded.granted_by, granted_at = now()
    returning * into v_row;
  else
    insert into agent_core.admin_users (user_id, tenant_id, role, granted_by)
    values (p_user_id, p_tenant, p_role, v_actor)
    on conflict (user_id, tenant_id) where tenant_id is not null
    do update set role = excluded.role, granted_by = excluded.granted_by, granted_at = now()
    returning * into v_row;
  end if;

  perform agent_core.record_audit_event(
    coalesce(p_tenant, null),
    'admin_granted',
    'warn',
    p_role,
    jsonb_build_object('actor_user_id', v_actor, 'grantee_user_id', p_user_id, 'tenant_id', p_tenant, 'role', p_role)
  );

  return v_row;
end;
$$;

revoke execute on function agent_core.admin_set_admin(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function agent_core.admin_set_admin(uuid, uuid, text)
  to service_role;

create or replace function agent_core.admin_revoke_admin(
  p_user_id uuid,
  p_tenant uuid
) returns void
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
  v_actor_tenant uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
  v_target_role text;
  v_superadmin_count int;
begin
  select role into v_target_role
  from agent_core.admin_users
  where user_id = p_user_id
    and ((p_tenant is null and tenant_id is null) or tenant_id = p_tenant)
  limit 1;

  if v_target_role is null then
    raise exception 'admin_revoke_admin: admin row not found';
  end if;

  if agent_core.current_admin_role() = 'superadmin' then
    null;
  elsif agent_core.current_admin_role() = 'tenant_admin' then
    if p_tenant is distinct from v_actor_tenant then
      raise exception 'admin_revoke_admin: tenant_admin can only revoke own tenant';
    end if;
    if v_target_role = 'superadmin' then
      raise exception 'admin_revoke_admin: tenant_admin cannot revoke superadmin';
    end if;
  else
    raise exception 'admin_revoke_admin: not authorized';
  end if;

  if p_tenant is not null then
    perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_revoke_admin', 'warn', 'admin_users');
  end if;

  if v_target_role = 'superadmin' and p_tenant is null then
    select count(*)::int into v_superadmin_count
    from agent_core.admin_users
    where role = 'superadmin'
      and tenant_id is null;

    if v_superadmin_count <= 1 then
      raise exception 'admin_revoke_admin: cannot revoke last superadmin';
    end if;
  end if;

  delete from agent_core.admin_users
  where user_id = p_user_id
    and ((p_tenant is null and tenant_id is null) or tenant_id = p_tenant);

  perform agent_core.record_audit_event(
    coalesce(p_tenant, null),
    'admin_revoked',
    'warn',
    coalesce(v_target_role, 'unknown'),
    jsonb_build_object('actor_user_id', v_actor, 'revoked_user_id', p_user_id, 'tenant_id', p_tenant)
  );
end;
$$;

revoke execute on function agent_core.admin_revoke_admin(uuid, uuid)
  from public, anon, authenticated;
grant execute on function agent_core.admin_revoke_admin(uuid, uuid)
  to service_role;

create or replace function agent_core.admin_get_usage_summary(
  p_tenant uuid,
  p_from date,
  p_to date,
  p_grain text default 'day'
) returns jsonb
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_viewer') then
    raise exception 'admin_get_usage_summary: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_get_usage_summary', 'info', 'usage_rollup_daily');

  return agent_core.usage_summary(p_tenant, p_from, p_to, p_grain, true);
end;
$$;

revoke execute on function agent_core.admin_get_usage_summary(uuid, date, date, text)
  from public, anon, authenticated;
grant execute on function agent_core.admin_get_usage_summary(uuid, date, date, text)
  to service_role;

create or replace function agent_core.admin_get_billing(
  p_tenant uuid,
  p_month date
) returns jsonb
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_viewer') then
    raise exception 'admin_get_billing: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_get_billing', 'info', 'usage_rollup_daily');

  return agent_core.usage_for_billing(p_tenant, p_month);
end;
$$;

revoke execute on function agent_core.admin_get_billing(uuid, date)
  from public, anon, authenticated;
grant execute on function agent_core.admin_get_billing(uuid, date)
  to service_role;

create or replace function agent_core.admin_get_audit_log(
  p_tenant uuid default null,
  p_severity text default null,
  p_event text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 100
) returns setof agent_core.audit_log
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
  v_tenant uuid := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_viewer') then
    raise exception 'admin_get_audit_log: not authorized';
  end if;

  if p_tenant is not null then
    perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_get_audit_log', 'info', 'audit_log');
  end if;

  return query
    select a.*
    from agent_core.audit_log a
    where (
      (p_tenant is null and (agent_core.current_admin_role() = 'superadmin' or a.tenant_id = v_tenant))
      or (p_tenant is not null and a.tenant_id = p_tenant)
    )
      and (p_severity is null or a.severity = p_severity)
      and (p_event is null or a.event = p_event)
      and (p_from is null or a.created_at >= p_from)
      and (p_to is null or a.created_at <= p_to)
    order by a.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 1000));
end;
$$;

revoke execute on function agent_core.admin_get_audit_log(uuid, text, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
grant execute on function agent_core.admin_get_audit_log(uuid, text, text, timestamptz, timestamptz, int)
  to service_role;

create or replace function agent_core.admin_reset_rate_limit(
  p_tenant uuid,
  p_subject text default null
) returns int
  language plpgsql
  security definer
  set search_path = agent_core, public
as $$
declare
  v_actor uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
  v_deleted int := 0;
begin
  if not agent_core.is_admin(p_tenant, 'tenant_admin') then
    raise exception 'admin_reset_rate_limit: not authorized';
  end if;

  perform agent_core._log_cross_tenant_if_needed(v_actor, p_tenant, 'admin_reset_rate_limit', 'warn', 'rate_limit_counters');

  delete from agent_core.rate_limit_counters
   where tenant_id = p_tenant
     and (p_subject is null or subject = p_subject);
  get diagnostics v_deleted = row_count;

  perform agent_core.record_audit_event(
    p_tenant,
    'rate_limit_reset',
    'warn',
    coalesce(p_subject, 'all'),
    jsonb_build_object('actor_user_id', v_actor, 'deleted_rows', v_deleted)
  );

  return v_deleted;
end;
$$;

revoke execute on function agent_core.admin_reset_rate_limit(uuid, text)
  from public, anon, authenticated;
grant execute on function agent_core.admin_reset_rate_limit(uuid, text)
  to service_role;
