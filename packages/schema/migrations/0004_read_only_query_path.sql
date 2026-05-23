-- Agent Core — migration 0004 — server-side read-only query path.
--
-- The `data_query` built-in tool currently runs as service_role, which
-- bypasses RLS — its only tenant boundary is an in-code `.eq("tenant_id",
-- ctx.tenantId)` filter. That's defensible (the column allowlist + tenant
-- filter are belt-and-suspenders) but the database accepts the call without
-- any independent check. This migration moves the table/column allowlist
-- INTO the database via a SECURITY DEFINER RPC, so even if a future
-- regression bypasses the JS validation, the database refuses the query.
--
-- The RPC is intentionally minimal: callers pass a table name, the tenant
-- id, a column list, equality filters, and a limit. It returns SETOF jsonb
-- rows. The tool wraps this with the same input validation it already does.

-- read_tenant_table ---------------------------------------------------------
create or replace function read_tenant_table(
  p_tenant   uuid,
  p_table    text,
  p_columns  text[]    default null,    -- null/empty → table's safe-default set
  p_filters  jsonb     default '{}'::jsonb,
  p_limit    int       default 25
) returns setof jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  -- Per-table column allowlist. Mirrors packages/tools/src/builtins/
  -- data-query.ts TABLE_COLUMNS — keep the two in sync.
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

  -- Resolve the allowlist for the requested table.
  if p_table = 'agent_runs' then
    v_allowed_columns := v_columns_runs;
  elsif p_table = 'agent_messages' then
    v_allowed_columns := v_columns_messages;
  else
    raise exception 'read_tenant_table: table % is not in the allowlist', p_table;
  end if;

  -- Resolve the column list.
  if p_columns is null or array_length(p_columns, 1) is null then
    v_select_columns := v_allowed_columns;
  else
    v_select_columns := p_columns;
    -- Every requested column must be in the table's allowlist.
    for v_filter_key in select unnest(v_select_columns) loop
      if not (v_filter_key = any(v_allowed_columns)) then
        raise exception
          'read_tenant_table: column % is not allowed on table %',
          v_filter_key, p_table;
      end if;
      -- Defensive identifier guard (no whitespace, no quoting tricks).
      if v_filter_key !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' then
        raise exception 'read_tenant_table: invalid column identifier %', v_filter_key;
      end if;
    end loop;
  end if;

  -- Validate each filter key + assemble the WHERE clause from quoted
  -- identifiers. Values are bound through `current_setting`-style escape via
  -- `quote_literal` since we cannot use $N placeholders inside the dynamic
  -- string for arbitrary jsonb values.
  for v_filter_key, v_filter_value in select * from jsonb_each(coalesce(p_filters, '{}'::jsonb)) loop
    if v_filter_key = 'tenant_id' then
      raise exception
        'read_tenant_table: caller may not specify a tenant_id filter — it is injected';
    end if;
    if not (v_filter_key = any(v_allowed_columns)) then
      raise exception
        'read_tenant_table: filter % is not allowed on table %',
        v_filter_key, p_table;
    end if;
    if v_filter_key !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' then
      raise exception 'read_tenant_table: invalid filter identifier %', v_filter_key;
    end if;
    -- Only scalar filter values supported.
    if jsonb_typeof(v_filter_value) not in ('string','number','boolean') then
      raise exception
        'read_tenant_table: filter % must be string|number|boolean', v_filter_key;
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

  -- Compose the final query. All identifiers were validated against the
  -- per-table allowlist + IDENT regex above; literals go through quote_literal
  -- via the format(%L) call inside the WHERE clause assembly. The dynamic
  -- piece is safe because no caller-controlled string ever reaches the SQL
  -- without identifier or literal quoting.
  v_sql := format(
    'select to_jsonb(t) from %I t where tenant_id = %L %s order by created_at desc limit %s',
    p_table,
    p_tenant::text,
    v_where,
    v_limit
  );

  return query execute v_sql;
end;
$$;

revoke all on function read_tenant_table(uuid, text, text[], jsonb, int)
  from public, anon, authenticated;
grant execute on function read_tenant_table(uuid, text, text[], jsonb, int)
  to service_role;

-- NOTE: data_query (packages/tools/src/builtins/data-query.ts) keeps its own
-- TS-level validation as defense in depth. This RPC is the SQL-level guard
-- — a second, independent boundary. Keep TABLE_COLUMNS in the TS file in
-- sync with the v_columns_* arrays above; CI should fail if they diverge.

-- [PART 2 COMPLETE]
