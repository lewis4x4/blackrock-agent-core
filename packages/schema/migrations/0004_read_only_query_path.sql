-- Agent Core — migration 0004 — server-side read-only query path.

create or replace function agent_core.read_tenant_table(
  p_tenant   uuid,
  p_table    text,
  p_columns  text[]    default null,
  p_filters  jsonb     default '{}'::jsonb,
  p_limit    int       default 25
) returns setof jsonb
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_columns_runs       text[] := array[
    'id','tenant_id','user_id','status','model_provider',
    'tokens_in','tokens_out','cost_estimate','created_at'
  ];
  v_columns_messages   text[] := array[
    'id','run_id','tenant_id','role','created_at'
  ];
  v_allowed_columns    text[];
  v_select_columns     text[];
  v_filter_key         text;
  v_filter_value       jsonb;
  v_sql                text;
  v_where              text := '';
  v_select_expr        text;
  v_limit              int;
begin
  if p_tenant is null then
    raise exception 'read_tenant_table: tenant is required';
  end if;

  if p_table = 'agent_runs' then
    v_allowed_columns := v_columns_runs;
  elsif p_table = 'agent_messages' then
    v_allowed_columns := v_columns_messages;
  else
    raise exception 'read_tenant_table: table % is not in the allowlist', p_table;
  end if;

  if p_columns is null or array_length(p_columns, 1) is null then
    v_select_columns := v_allowed_columns;
  else
    v_select_columns := p_columns;
    for v_filter_key in select unnest(v_select_columns) loop
      if not (v_filter_key = any(v_allowed_columns)) then
        raise exception
          'read_tenant_table: column % is not allowed on table %',
          v_filter_key, p_table;
      end if;
      if v_filter_key !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' then
        raise exception 'read_tenant_table: invalid column identifier %', v_filter_key;
      end if;
    end loop;
  end if;

  for v_filter_key, v_filter_value in select * from jsonb_each(coalesce(p_filters, '{}'::jsonb)) loop
    if v_filter_key = 'tenant_id' then
      raise exception
        'read_tenant_table: caller may not specify a tenant_id filter — it is injected';
    end if;
    if not (v_filter_key = any(v_allowed_columns)) then
      raise exception
        'read_tenant_table: filter % is not allowed on table %', v_filter_key, p_table;
    end if;
    if v_filter_key !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' then
      raise exception 'read_tenant_table: invalid filter identifier %', v_filter_key;
    end if;
    if jsonb_typeof(v_filter_value) not in ('string','number','boolean') then
      raise exception 'read_tenant_table: filter % must be string|number|boolean', v_filter_key;
    end if;
    v_where := v_where || format(' and %I = %L',
      v_filter_key,
      case jsonb_typeof(v_filter_value)
        when 'string'  then v_filter_value #>> '{}'
        when 'number'  then v_filter_value::text
        when 'boolean' then v_filter_value::text
      end);
  end loop;

  v_limit := greatest(1, least(coalesce(p_limit, 25), 500));

  v_select_expr := (
    select string_agg(format('%I', c), ',')
      from unnest(v_select_columns) c
  );

  v_sql := format(
    'select to_jsonb(r) from (select %s from agent_core.%I where tenant_id = %L %s order by created_at desc limit %s) r',
    v_select_expr,
    p_table,
    p_tenant::text,
    v_where,
    v_limit
  );

  return query execute v_sql;
end;
$$;

revoke all on function agent_core.read_tenant_table(uuid, text, text[], jsonb, int)
  from public, anon, authenticated;
grant execute on function agent_core.read_tenant_table(uuid, text, text[], jsonb, int)
  to service_role;

-- [PART 2 COMPLETE]
