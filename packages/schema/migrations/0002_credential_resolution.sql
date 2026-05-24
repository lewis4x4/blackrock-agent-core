-- Agent Core — migration 0002 — credential resolution via Supabase Vault.
-- Adds two SECURITY DEFINER functions that the Edge Function (running as the
-- service_role) uses to store and resolve per-tenant API keys without ever
-- exposing raw secrets to the browser. tenant_credentials continues to hold
-- only a Vault pointer (secret_ref); raw key material lives in vault.secrets.

-- store_tenant_credential ---------------------------------------------------
-- Creates a Vault secret for (tenant, provider), upserts the pointer row in
-- tenant_credentials, and returns the tenant_credentials.id.
-- NOTE: on conflict we overwrite secret_ref with the new vault id but leave
-- the previous vault secret in place for v1 — explicit rotation/cleanup will
-- come in a later migration.
create or replace function agent_core.store_tenant_credential(
  p_tenant   uuid,
  p_provider text,
  p_secret   text,
  p_meta     jsonb default '{}'::jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = agent_core, vault
as $$
declare
  v_secret_name text := format('agent-core:%s:%s', p_tenant, p_provider);
  v_secret_ref  uuid;
  v_row_id      uuid;
begin
  -- vault.create_secret(secret text, name text, description text) returns uuid
  v_secret_ref := vault.create_secret(p_secret, v_secret_name, '');

  insert into tenant_credentials (tenant_id, provider, secret_ref, meta)
  values (p_tenant, p_provider, v_secret_ref, coalesce(p_meta, '{}'::jsonb))
  on conflict (tenant_id, provider) do update
    set secret_ref = excluded.secret_ref,
        meta       = excluded.meta
  returning id into v_row_id;

  return v_row_id;
end;
$$;

revoke all on function agent_core.store_tenant_credential(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.store_tenant_credential(uuid, text, text, jsonb)
  to service_role;

-- resolve_tenant_secret -----------------------------------------------------
-- Returns the decrypted secret text for (tenant, provider), or NULL if no
-- credential exists. Reads from vault.decrypted_secrets, which is only
-- accessible because this function runs as SECURITY DEFINER (owned by a role
-- with vault access) — callers (service_role only) never touch the vault
-- schema directly.
create or replace function agent_core.resolve_tenant_secret(
  p_tenant   uuid,
  p_provider text
) returns text
  language sql
  security definer
  set search_path = agent_core, vault
as $$
  select ds.decrypted_secret
  from tenant_credentials tc
  join vault.decrypted_secrets ds on ds.id = tc.secret_ref
  where tc.tenant_id = p_tenant
    and tc.provider  = p_provider
  limit 1;
$$;

revoke all on function agent_core.resolve_tenant_secret(uuid, text)
  from public, anon, authenticated;
grant execute on function agent_core.resolve_tenant_secret(uuid, text)
  to service_role;
