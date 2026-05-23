-- Agent Core — migration 0006 — OAuth-backed connected integrations.
-- Adds the tenant_connections table for storing OAuth access/refresh tokens as
-- Vault-pointer refs (never raw token material), plus oauth_states for the
-- CSRF state nonce + PKCE verifier during the authorize → callback round-trip.
-- All RPCs are SECURITY DEFINER and grant-locked to service_role: the browser
-- never touches token material or vault.* directly.

-- Connections --------------------------------------------------------------
-- One row per (tenant, provider, account_label). secret_ref points into
-- vault.secrets and holds the **access** token; refresh_secret_ref holds the
-- **refresh** token. Both are nullable to support providers that don't issue
-- a refresh token, but for hubspot/m365 we always populate both.
create table if not exists tenant_connections (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  provider            text not null,                 -- 'hubspot' | 'm365' | ...
  account_label       text not null default 'default',
  secret_ref          uuid,                          -- access token (vault id)
  refresh_secret_ref  uuid,                          -- refresh token (vault id)
  scopes              text[] not null default '{}',
  expires_at          timestamptz,                   -- access-token expiry
  status              text not null default 'active' check (status in ('active','expired','revoked')),
  meta                jsonb not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, provider, account_label)
);

-- OAuth state nonces -------------------------------------------------------
-- One row per outbound authorize redirect. The state goes to the IdP and comes
-- back on the callback; the code_verifier closes the PKCE round-trip. Rows are
-- short-lived (expires_at default = now()+10min) and cleaned up on callback.
create table if not exists oauth_states (
  state          text primary key,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  provider       text not null,
  account_label  text not null default 'default',
  code_verifier  text not null,                     -- PKCE verifier
  redirect_uri   text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '10 minutes')
);

create index if not exists idx_tenant_connections_tenant
  on tenant_connections(tenant_id, provider);
create index if not exists idx_oauth_states_expires
  on oauth_states(expires_at);

-- RLS ----------------------------------------------------------------------
alter table tenant_connections enable row level security;
alter table oauth_states       enable row level security;

create policy tenant_isolation on tenant_connections
  for all using (tenant_id = current_tenant()) with check (tenant_id = current_tenant());
create policy tenant_isolation on oauth_states
  for all using (tenant_id = current_tenant()) with check (tenant_id = current_tenant());

-- store_tenant_connection ----------------------------------------------------
-- Writes access + refresh tokens into Vault, upserts the pointer row, returns
-- the connection id. Designed to be called from the OAuth callback edge
-- function (as service_role). On conflict (tenant, provider, account_label)
-- we overwrite secret refs and metadata — the previous vault entries are left
-- in place; explicit rotation will land in a later migration.
create or replace function store_tenant_connection(
  p_tenant         uuid,
  p_provider       text,
  p_account_label  text,
  p_access_token   text,
  p_refresh_token  text,
  p_scopes         text[],
  p_expires_at     timestamptz,
  p_meta           jsonb default '{}'::jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = public, vault
as $$
declare
  v_access_name  text;
  v_refresh_name text;
  v_access_ref   uuid;
  v_refresh_ref  uuid;
  v_row_id       uuid;
begin
  v_access_name  := format('agent-core:conn:%s:%s:%s:access',  p_tenant, p_provider, p_account_label);
  v_refresh_name := format('agent-core:conn:%s:%s:%s:refresh', p_tenant, p_provider, p_account_label);

  if p_access_token is not null and length(p_access_token) > 0 then
    v_access_ref := vault.create_secret(p_access_token, v_access_name, '');
  end if;
  if p_refresh_token is not null and length(p_refresh_token) > 0 then
    v_refresh_ref := vault.create_secret(p_refresh_token, v_refresh_name, '');
  end if;

  insert into tenant_connections
    (tenant_id, provider, account_label, secret_ref, refresh_secret_ref,
     scopes, expires_at, status, meta, updated_at)
  values
    (p_tenant, p_provider, p_account_label, v_access_ref, v_refresh_ref,
     coalesce(p_scopes, '{}'), p_expires_at, 'active',
     coalesce(p_meta, '{}'::jsonb), now())
  on conflict (tenant_id, provider, account_label) do update
    set secret_ref         = coalesce(excluded.secret_ref,         tenant_connections.secret_ref),
        refresh_secret_ref = coalesce(excluded.refresh_secret_ref, tenant_connections.refresh_secret_ref),
        scopes             = excluded.scopes,
        expires_at         = excluded.expires_at,
        status             = 'active',
        meta               = excluded.meta,
        updated_at         = now()
  returning id into v_row_id;

  return v_row_id;
end;
$$;

revoke all on function store_tenant_connection(uuid, text, text, text, text, text[], timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function store_tenant_connection(uuid, text, text, text, text, text[], timestamptz, jsonb)
  to service_role;

-- resolve_tenant_connection -------------------------------------------------
-- Returns the decrypted access + refresh tokens (and metadata) for a tenant's
-- connection. Tools call this from the runtime to authenticate API calls.
-- Returning a SETOF row (rather than two scalar functions) keeps the call
-- atomic — no chance of mixing access and refresh tokens from different
-- connections.
create or replace function resolve_tenant_connection(
  p_tenant         uuid,
  p_provider       text,
  p_account_label  text default 'default'
) returns table (
  connection_id   uuid,
  access_token    text,
  refresh_token   text,
  expires_at      timestamptz,
  scopes          text[],
  status          text,
  meta            jsonb
)
  language sql
  security definer
  set search_path = public, vault
as $$
  select
    tc.id,
    a.decrypted_secret as access_token,
    r.decrypted_secret as refresh_token,
    tc.expires_at,
    tc.scopes,
    tc.status,
    tc.meta
  from tenant_connections tc
  left join vault.decrypted_secrets a on a.id = tc.secret_ref
  left join vault.decrypted_secrets r on r.id = tc.refresh_secret_ref
  where tc.tenant_id     = p_tenant
    and tc.provider      = p_provider
    and tc.account_label = p_account_label
  limit 1;
$$;

revoke all on function resolve_tenant_connection(uuid, text, text)
  from public, anon, authenticated;
grant execute on function resolve_tenant_connection(uuid, text, text)
  to service_role;

-- update_tenant_connection_tokens -------------------------------------------
-- After a refresh exchange, write a NEW access-token vault entry and (when
-- the IdP rotates it) a new refresh-token entry, then update the pointer row.
-- Old vault rows are NOT deleted yet — rotation/cleanup is a later migration.
create or replace function update_tenant_connection_tokens(
  p_connection_id   uuid,
  p_access_token    text,
  p_refresh_token   text,            -- pass NULL when the IdP didn't rotate
  p_expires_at      timestamptz
) returns void
  language plpgsql
  security definer
  set search_path = public, vault
as $$
declare
  v_tenant   uuid;
  v_provider text;
  v_label    text;
  v_access_name  text;
  v_refresh_name text;
  v_access_ref   uuid;
  v_refresh_ref  uuid;
begin
  select tenant_id, provider, account_label
    into v_tenant, v_provider, v_label
    from tenant_connections
   where id = p_connection_id;

  if v_tenant is null then
    raise exception 'connection % not found', p_connection_id;
  end if;

  v_access_name  := format('agent-core:conn:%s:%s:%s:access:%s',  v_tenant, v_provider, v_label, extract(epoch from now())::bigint);
  v_refresh_name := format('agent-core:conn:%s:%s:%s:refresh:%s', v_tenant, v_provider, v_label, extract(epoch from now())::bigint);

  if p_access_token is not null and length(p_access_token) > 0 then
    v_access_ref := vault.create_secret(p_access_token, v_access_name, '');
  end if;
  if p_refresh_token is not null and length(p_refresh_token) > 0 then
    v_refresh_ref := vault.create_secret(p_refresh_token, v_refresh_name, '');
  end if;

  update tenant_connections
     set secret_ref         = coalesce(v_access_ref,  secret_ref),
         refresh_secret_ref = coalesce(v_refresh_ref, refresh_secret_ref),
         expires_at         = p_expires_at,
         status             = 'active',
         updated_at         = now()
   where id = p_connection_id;
end;
$$;

revoke all on function update_tenant_connection_tokens(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function update_tenant_connection_tokens(uuid, text, text, timestamptz)
  to service_role;

-- NOTE: tenant_connections stores ONLY secret_ref / refresh_secret_ref (Vault
-- pointers). Raw access/refresh tokens live in vault.secrets and are resolved
-- server-side by the OAuth Edge Function and connected tools via the
-- SECURITY DEFINER RPCs above. They are NEVER exposed to the browser.

-- [PART 1 COMPLETE]
