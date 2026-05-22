// End-to-end tenant isolation verification. Runs four checks against a live
// Supabase project (local or remote) to prove the migration 0002 credential
// resolution path is correctly scoped per-tenant and inaccessible to anon /
// authenticated callers. Service-role only — never bundle for the browser.
//
// Usage:
//   bun packages/schema/scripts/verify-isolation.ts
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_ANON_KEY
// Optional:
//   SUPABASE_TEST_AUTHENTICATED_JWT  (signed JWT with role=authenticated)
//
// Cleanup note: tenant rows are deleted in a finally block, which cascades to
// tenant_credentials and tenant_tools (per the on-delete-cascade in migration
// 0001). The Vault secret rows created via store_tenant_credential are left in
// place — explicit Vault cleanup/rotation is deferred (matches migration 0002).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const USAGE = `Usage:
  bun packages/schema/scripts/verify-isolation.ts

Required env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_ANON_KEY
Optional env vars:
  SUPABASE_TEST_AUTHENTICATED_JWT
`;

function fail(message: string): never {
  process.stderr.write(`[verify-isolation] error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) fail(`missing required env var ${name}`);
  return value;
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.length === 0) return undefined;
  return value;
}

interface TenantRow {
  id: string;
  slug: string;
}

interface ToolRow {
  tool_key: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? '[ok]' : '[fail]';
  process.stdout.write(`${tag} ${name}: ${detail}\n`);
}

function skip(name: string, detail: string): void {
  process.stdout.write(`[skip] ${name}: ${detail}\n`);
}

async function insertTenant(
  supabase: SupabaseClient,
  slug: string,
  displayName: string,
): Promise<TenantRow> {
  const { data, error } = await supabase
    .from('tenants')
    .insert({ slug, display_name: displayName })
    .select('id, slug')
    .single<TenantRow>();

  if (error) throw new Error(`insert tenant ${slug}: ${error.message}`);
  if (!data) throw new Error(`insert tenant ${slug}: no row returned`);
  return data;
}

async function storeCredential(
  supabase: SupabaseClient,
  tenantId: string,
  provider: string,
  secret: string,
): Promise<void> {
  const { error } = await supabase.rpc('store_tenant_credential', {
    p_tenant: tenantId,
    p_provider: provider,
    p_secret: secret,
    p_meta: { source: 'verify-isolation' },
  });

  if (error) {
    throw new Error(
      `store_tenant_credential(${tenantId}, ${provider}): ${error.message}`,
    );
  }
}

async function resolveSecret(
  supabase: SupabaseClient,
  tenantId: string,
  provider: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('resolve_tenant_secret', {
    p_tenant: tenantId,
    p_provider: provider,
  });

  if (error) {
    throw new Error(
      `resolve_tenant_secret(${tenantId}, ${provider}): ${error.message}`,
    );
  }

  // supabase-js infers `unknown` for scalar RPC returns; the SQL function
  // returns `text`, so a string|null cast is the narrow correct type.
  return (data as string | null) ?? null;
}

async function enableTools(
  supabase: SupabaseClient,
  tenantId: string,
  toolKeys: readonly string[],
): Promise<void> {
  const rows = toolKeys.map((tool_key) => ({
    tenant_id: tenantId,
    tool_key,
    enabled: true,
  }));
  const { error } = await supabase.from('tenant_tools').insert(rows);
  if (error) {
    throw new Error(`enable tools for ${tenantId}: ${error.message}`);
  }
}

async function listEnabledTools(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('tenant_tools')
    .select('tool_key')
    .eq('tenant_id', tenantId)
    .eq('enabled', true);

  if (error) throw new Error(`list tools for ${tenantId}: ${error.message}`);
  if (!data) return [];
  return (data as ToolRow[]).map((row) => row.tool_key);
}

async function deleteTenant(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<void> {
  const { error } = await supabase
    .from('tenants')
    .delete()
    .eq('id', tenantId);
  if (error) {
    process.stderr.write(
      `[verify-isolation] cleanup warning: failed to delete tenant ${tenantId}: ${error.message}\n`,
    );
  }
}

async function checkCredentialIsolation(
  service: SupabaseClient,
  tenantAId: string,
  providerA: string,
  secretA: string,
  tenantBId: string,
  providerB: string,
  secretB: string,
): Promise<void> {
  const checkName = 'credential-isolation';
  try {
    const resolvedA = await resolveSecret(service, tenantAId, providerA);
    const resolvedB = await resolveSecret(service, tenantBId, providerB);

    if (resolvedA !== secretA) {
      record(
        checkName,
        false,
        'tenant A resolved value did not match stored secret',
      );
      return;
    }
    if (resolvedB !== secretB) {
      record(
        checkName,
        false,
        'tenant B resolved value did not match stored secret',
      );
      return;
    }
    if (resolvedA === resolvedB) {
      record(checkName, false, 'tenant A and B resolved to the same secret');
      return;
    }

    // Cross-tenant sanity: A's provider key, scoped to B's tenant, must not
    // leak A's secret. Providers differ here so the function returns null,
    // but assert explicitly to guard against an accidental cross-tenant match.
    const cross = await resolveSecret(service, tenantBId, providerA);
    if (cross === secretA) {
      record(
        checkName,
        false,
        'cross-tenant resolution leaked tenant A secret to tenant B',
      );
      return;
    }

    record(
      checkName,
      true,
      'tenant A and B each resolve their own distinct secret',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(checkName, false, message);
  }
}

async function checkToolScoping(
  service: SupabaseClient,
  tenantAId: string,
  tenantBId: string,
  toolsA: readonly string[],
  toolsB: readonly string[],
): Promise<void> {
  const checkName = 'tool-scoping';
  try {
    const enabledA = new Set(await listEnabledTools(service, tenantAId));
    const enabledB = new Set(await listEnabledTools(service, tenantBId));

    for (const tool of toolsA) {
      if (!enabledA.has(tool)) {
        record(checkName, false, `tenant A missing expected tool ${tool}`);
        return;
      }
    }
    for (const tool of toolsB) {
      if (!enabledB.has(tool)) {
        record(checkName, false, `tenant B missing expected tool ${tool}`);
        return;
      }
    }

    // A must be a strict subset of B.
    for (const tool of enabledA) {
      if (!enabledB.has(tool)) {
        record(
          checkName,
          false,
          `tenant A has tool ${tool} not enabled for tenant B`,
        );
        return;
      }
    }

    const extra: string[] = [];
    for (const tool of enabledB) {
      if (!enabledA.has(tool)) extra.push(tool);
    }
    if (extra.length === 0) {
      record(
        checkName,
        false,
        'tenant B has no extra tools beyond tenant A — expected strict superset',
      );
      return;
    }

    record(
      checkName,
      true,
      `A=[${[...enabledA].sort().join(',')}] is strict subset of B=[${[...enabledB].sort().join(',')}] (extra: ${extra.sort().join(',')})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(checkName, false, message);
  }
}

async function checkAnonCannotResolve(
  supabaseUrl: string,
  anonKey: string,
  tenantId: string,
  provider: string,
): Promise<void> {
  const checkName = 'anon-cannot-resolve';
  try {
    const anon = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await anon.rpc('resolve_tenant_secret', {
      p_tenant: tenantId,
      p_provider: provider,
    });

    if (error) {
      record(
        checkName,
        true,
        `anon RPC rejected as expected (${error.message})`,
      );
      return;
    }
    if (data === null || data === undefined) {
      record(
        checkName,
        false,
        'anon RPC returned no error but also returned no data — expected explicit denial from REVOKE',
      );
      return;
    }
    record(
      checkName,
      false,
      `anon RPC unexpectedly returned a value (${typeof data})`,
    );
  } catch (err) {
    // A thrown error from the client is also acceptable proof of rejection.
    const message = err instanceof Error ? err.message : String(err);
    record(checkName, true, `anon RPC threw as expected (${message})`);
  }
}

async function checkAuthenticatedCannotResolve(
  supabaseUrl: string,
  anonKey: string,
  jwt: string,
  tenantId: string,
  provider: string,
): Promise<void> {
  const checkName = 'authenticated-cannot-resolve';
  try {
    // supabase-js attaches a custom JWT for RPCs via global headers; we keep
    // the anon key as the apikey so PostgREST accepts the request, while the
    // Authorization bearer drives the auth.role() PostgREST runs the call as.
    const authed = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data, error } = await authed.rpc('resolve_tenant_secret', {
      p_tenant: tenantId,
      p_provider: provider,
    });

    if (error) {
      record(
        checkName,
        true,
        `authenticated RPC rejected as expected (${error.message})`,
      );
      return;
    }
    if (data === null || data === undefined) {
      record(
        checkName,
        false,
        'authenticated RPC returned no error but also returned no data — expected explicit denial from REVOKE',
      );
      return;
    }
    record(
      checkName,
      false,
      `authenticated RPC unexpectedly returned a value (${typeof data})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(checkName, true, `authenticated RPC threw as expected (${message})`);
  }
}

async function main(): Promise<void> {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const authenticatedJwt = getOptionalEnv('SUPABASE_TEST_AUTHENTICATED_JWT');

  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const runId = randomUUID();
  const slugA = `verify-isolation-a-${runId}`;
  const slugB = `verify-isolation-b-${runId}`;
  const providerA = 'anthropic';
  const providerB = 'openai';
  const secretA = `sk-test-a-${randomUUID()}`;
  const secretB = `sk-test-b-${randomUUID()}`;
  const toolsA: readonly string[] = ['http_request'];
  const toolsB: readonly string[] = ['http_request', 'web_search'];

  let tenantA: TenantRow | undefined;
  let tenantB: TenantRow | undefined;
  let expectedChecks = 0;

  try {
    tenantA = await insertTenant(service, slugA, 'Verify Isolation A');
    tenantB = await insertTenant(service, slugB, 'Verify Isolation B');

    await storeCredential(service, tenantA.id, providerA, secretA);
    await storeCredential(service, tenantB.id, providerB, secretB);

    await enableTools(service, tenantA.id, toolsA);
    await enableTools(service, tenantB.id, toolsB);

    await checkCredentialIsolation(
      service,
      tenantA.id,
      providerA,
      secretA,
      tenantB.id,
      providerB,
      secretB,
    );
    expectedChecks += 1;

    await checkToolScoping(service, tenantA.id, tenantB.id, toolsA, toolsB);
    expectedChecks += 1;

    await checkAnonCannotResolve(supabaseUrl, anonKey, tenantA.id, providerA);
    expectedChecks += 1;

    if (authenticatedJwt) {
      await checkAuthenticatedCannotResolve(
        supabaseUrl,
        anonKey,
        authenticatedJwt,
        tenantA.id,
        providerA,
      );
      expectedChecks += 1;
    } else {
      skip(
        'authenticated-role check',
        'SUPABASE_TEST_AUTHENTICATED_JWT not set',
      );
    }
  } finally {
    if (tenantA) await deleteTenant(service, tenantA.id);
    if (tenantB) await deleteTenant(service, tenantB.id);
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  process.stdout.write(
    `verify-isolation: ${passed}/${total} checks passed\n`,
  );
  const allOk = total === expectedChecks && passed === total && total > 0;
  process.exit(allOk ? 0 : 1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[verify-isolation] unexpected failure: ${message}\n`);
  process.exit(1);
});
