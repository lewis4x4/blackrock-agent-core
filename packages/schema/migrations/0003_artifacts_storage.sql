-- Agent Core — migration 0003 — artifact storage pointer table.
-- Establishes the `artifacts` table: one row per object stored in Supabase
-- Storage (or any blob backend). The table holds only metadata + a storage
-- path; raw bytes never live in the relational tables.
--
-- An artifact is anything the agent produces or consumes that has byte
-- payload: synthesized docs, screenshots, tool outputs that don't fit in
-- jsonb, ingested files, etc.

create table if not exists agent_core.artifacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references agent_core.tenants(id) on delete cascade,
  -- Optional run linkage. Artifacts produced inside an agent run carry the
  -- run id; user-uploaded artifacts can leave it NULL.
  run_id        uuid references agent_core.agent_runs(id) on delete set null,
  kind          text not null check (length(kind) between 1 and 64),
  label         text not null check (length(label) between 1 and 256),
  content_type  text not null check (length(content_type) between 1 and 128),
  byte_size     bigint not null check (byte_size >= 0),
  -- Object key inside the storage bucket. Convention: `<tenant_id>/<uuid>`.
  storage_path  text not null check (length(storage_path) between 1 and 512),
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists idx_artifacts_tenant_created
  on agent_core.artifacts(tenant_id, created_at desc);
create index if not exists idx_artifacts_run
  on agent_core.artifacts(run_id) where run_id is not null;

alter table agent_core.artifacts enable row level security;

create policy tenant_isolation on agent_core.artifacts
  for all using (tenant_id = agent_core.current_tenant()) with check (tenant_id = agent_core.current_tenant());

-- store_artifact ------------------------------------------------------------
-- Inserts the metadata pointer row. Designed to be called from the runtime
-- AFTER the bytes have been uploaded to storage — the function does NOT
-- itself write blob data. Returns the artifact id.
create or replace function agent_core.store_artifact(
  p_tenant        uuid,
  p_run           uuid,
  p_kind          text,
  p_label         text,
  p_content_type  text,
  p_byte_size     bigint,
  p_storage_path  text,
  p_meta          jsonb default '{}'::jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_row_id uuid;
begin
  if p_storage_path !~ ('^' || p_tenant::text || '/[^/]') then
    raise exception 'storage_path must begin with tenant_id/<segment> (got %)', p_storage_path;
  end if;
  if p_storage_path ~ '(^|/)\.\.(/|$)' then
    raise exception 'storage_path may not contain a .. segment (got %)', p_storage_path;
  end if;

  insert into artifacts
    (tenant_id, run_id, kind, label, content_type, byte_size, storage_path, meta)
  values
    (p_tenant, p_run, p_kind, p_label, p_content_type, p_byte_size, p_storage_path,
     coalesce(p_meta, '{}'::jsonb))
  returning id into v_row_id;

  return v_row_id;
end;
$$;

revoke all on function agent_core.store_artifact(uuid, uuid, text, text, text, bigint, text, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.store_artifact(uuid, uuid, text, text, text, bigint, text, jsonb)
  to service_role;

-- list_artifacts ------------------------------------------------------------
create or replace function agent_core.list_artifacts(
  p_tenant   uuid,
  p_run      uuid default null,
  p_limit    int  default 50
) returns table (
  id            uuid,
  run_id        uuid,
  kind          text,
  label         text,
  content_type  text,
  byte_size     bigint,
  storage_path  text,
  meta          jsonb,
  created_at    timestamptz
)
  language sql
  security definer
  set search_path = agent_core
as $$
  select a.id, a.run_id, a.kind, a.label, a.content_type, a.byte_size,
         a.storage_path, a.meta, a.created_at
    from artifacts a
   where a.tenant_id = p_tenant
     and (p_run is null or a.run_id = p_run)
   order by a.created_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 500));
$$;

revoke all on function agent_core.list_artifacts(uuid, uuid, int)
  from public, anon, authenticated;
grant execute on function agent_core.list_artifacts(uuid, uuid, int)
  to service_role;

-- NOTE: bytes live in Supabase Storage. The artifacts table only holds
-- pointer metadata. Storage bucket creation + bucket-level RLS policies are
-- managed in `supabase/config.toml` / the Storage admin UI rather than in
-- migrations — Supabase Storage policies are not portable across projects.

-- [PART 1 COMPLETE]
