-- Agent Core — migration 0007 — schema/table grants for PostgREST roles.
--
-- Sprint 5 namespaced everything into `agent_core` but did NOT grant any
-- privileges to the Supabase PostgREST roles (service_role, authenticated,
-- anon). Default Postgres behavior: only the schema owner can use the schema,
-- so every supabase-js call returned 42501 "permission denied for schema
-- agent_core" — even from the runtime's service-role client.
--
-- This migration grants:
--   * USAGE on the schema to all four Supabase roles (so they can SEE
--     agent_core via PostgREST).
--   * Full ALL on tables/functions/sequences to service_role (the runtime's
--     identity — it must bypass RLS by virtue of being service_role and
--     read/write every tenant's rows server-side).
--   * SELECT/INSERT/UPDATE/DELETE on tables to authenticated (a logged-in
--     end-user via the shell). RLS layer then filters them to their own
--     tenant_id, so the grant + the RLS policy together produce per-tenant
--     row isolation.
--   * Nothing to anon. The shell never talks to agent_core directly as anon
--     (the agent Edge Function is the only path), so anon needs no grants.
--     verify-isolation.ts already proves anon is denied — leaving anon with
--     no schema USAGE makes the denial happen one layer earlier, which is
--     equivalent and slightly stricter.
--   * Default privileges so future objects (created by later migrations) get
--     the same grants automatically without needing this migration to be
--     repeated.

grant usage on schema agent_core to postgres, authenticated, service_role;

grant all on all tables    in schema agent_core to postgres, service_role;
grant all on all functions in schema agent_core to postgres, service_role;
grant all on all sequences in schema agent_core to postgres, service_role;

grant select, insert, update, delete on all tables    in schema agent_core to authenticated;
grant usage,  select                  on all sequences in schema agent_core to authenticated;
grant execute                         on all functions in schema agent_core to authenticated;

alter default privileges in schema agent_core
  grant all on tables to postgres, service_role;
alter default privileges in schema agent_core
  grant all on functions to postgres, service_role;
alter default privileges in schema agent_core
  grant all on sequences to postgres, service_role;
alter default privileges in schema agent_core
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema agent_core
  grant usage, select on sequences to authenticated;
alter default privileges in schema agent_core
  grant execute on functions to authenticated;
