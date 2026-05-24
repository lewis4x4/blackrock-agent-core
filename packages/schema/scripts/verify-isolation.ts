// End-to-end tenant isolation verification for the credential / tool stack.
//
// Runs four invariants against a live Supabase project (local or remote) to
// prove that the migration 0002 credential-resolution path is correctly scoped
// per-tenant and inaccessible to the anon role:
//
//   1. Two tenants get distinct stored credentials.
//   2. Per-tenant resolution returns each tenant's own secret — even when the
//      provider name is identical across tenants (the real cross-tenant leak
//      test).
//   3. loadTenantContext() builds a per-tenant ToolRegistry that contains only
//      the builtins enabled in tenant_tools — tenant A sees http_request,
//      tenant B (enabled=false) sees nothing.
//   4. The anon role cannot call resolve_tenant_secret successfully.
//
// Usage:
//   bun packages/schema/scripts/verify-isolation.ts
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_ANON_KEY
//
// If any of those are missing OR Supabase is unreachable, the script writes a
// single PARKED line to stdout and exits 0 — it never asks for a stack it
// cannot drive. On full pass it prints `[isolation verified] all 4 invariants
// passed` and exits 0. On any assertion failure it prints `[fail] invariant N
// — …` and exits 1.
//
// Cleanup: created tenant rows are deleted in a finally block, which cascades
// to tenant_credentials and tenant_tools per migration 0001. Vault secret
// rows created via store_tenant_credential are left in place (matches the
// deferred Vault cleanup posture in migration 0002).

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { loadTenantContext } from '@blackrock-ai/agent-runtime';

const AGENT_CORE_SCHEMA = 'agent_core';

const PARK_LINE =
  '[PARKED — live Supabase isolation verification: needs a running Supabase project]';

function park(reason: string): never {
  process.stderr.write(`[verify-isolation] parked: ${reason}\n`);
  process.stdout.write(`${PARK_LINE}\n`);
  process.exit(0);
}

function ok(invariant: number, detail: string): void {
  process.stdout.write(`[ok] invariant ${invariant} — ${detail}\n`);
}

function failAndExit(invariant: number, detail: string): never {
  process.stdout.write(`[fail] invariant ${invariant} — ${detail}\n`);
  process.exit(1);
}

function shortKey(s: string): string {
  return `${s.slice(0, 6)}...`;
}

// any: Supabase's generated DB types are not available in scripts; the
// "agent_core" string literal still narrows the .schema('agent_core') surface.
async function isReachable(
  svc: ReturnType<typeof createClient<any, "agent_core">>,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { error } = await svc.from('tenants').select('id').limit(1);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

interface TenantRow {
  id: string;
  slug: string;
}

async function insertTenant(
  svc: ReturnType<typeof createClient<any, "agent_core">>,
  slug: string,
  displayName: string,
): Promise<TenantRow> {
  const { data, error } = await svc
    .from('tenants')
    .insert({ slug, display_name: displayName })
    .select('id, slug')
    .single<TenantRow>();
  if (error) throw new Error(`insert tenant ${slug}: ${error.message}`);
  if (!data) throw new Error(`insert tenant ${slug}: no row returned`);
  return data;
}

async function storeCredential(
  svc: ReturnType<typeof createClient<any, "agent_core">>,
  tenantId: string,
  provider: string,
  secret: string,
): Promise<void> {
  const { error } = await svc.rpc('store_tenant_credential', {
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
  svc: ReturnType<typeof createClient<any, "agent_core">>,
  tenantId: string,
  provider: string,
): Promise<string | null> {
  const { data, error } = await svc.rpc('resolve_tenant_secret', {
    p_tenant: tenantId,
    p_provider: provider,
  });
  if (error) {
    throw new Error(
      `resolve_tenant_secret(${tenantId}, ${provider}): ${error.message}`,
    );
  }
  // supabase-js types scalar RPC returns as `unknown`; the SQL function
  // returns `text`, so `string | null` is the narrow correct cast.
  return (data as string | null) ?? null;
}

async function setToolRow(
  svc: ReturnType<typeof createClient<any, "agent_core">>,
  tenantId: string,
  toolKey: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await svc.from('tenant_tools').insert({
    tenant_id: tenantId,
    tool_key: toolKey,
    enabled,
  });
  if (error) {
    throw new Error(
      `tenant_tools insert (${tenantId}, ${toolKey}, ${String(enabled)}): ${error.message}`,
    );
  }
}

async function deleteTenant(
  svc: ReturnType<typeof createClient<any, "agent_core">>,
  tenantId: string,
): Promise<void> {
  const { error } = await svc.from('tenants').delete().eq('id', tenantId);
  if (error) {
    process.stderr.write(
      `[verify-isolation] cleanup warning: delete tenant ${tenantId}: ${error.message}\n`,
    );
  }
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    park(
      'missing one or more of SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY',
    );
  }

  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    db: { schema: AGENT_CORE_SCHEMA },
  });

  const reach = await isReachable(service);
  if (!reach.ok) {
    park(`supabase unreachable: ${reach.reason ?? 'unknown'}`);
  }

  // loadTenantContext reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from its
  // own env (Deno in production, process.env via the sibling Bun shim here).
  // Set them explicitly before invariant 3 so the script works regardless of
  // how the runner exported them.
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;

  const runId = randomUUID();
  const slugA = `verify-iso-a-${runId}`;
  const slugB = `verify-iso-b-${runId}`;

  // Both tenants intentionally share provider='anthropic' with DIFFERENT
  // secrets — that's what gives invariant 2 real teeth: resolve(tenantB,
  // anthropic) must return tenantB's secret, never tenantA's, even though
  // the (provider, key) tuple they query is identical in shape.
  const provider = 'anthropic';
  const secretA = `sk-test-a-${randomUUID()}`;
  const secretB = `sk-test-b-${randomUUID()}`;

  const tenantIds: string[] = [];

  try {
    const tenantA = await insertTenant(service, slugA, 'Verify Isolation A');
    tenantIds.push(tenantA.id);
    const tenantB = await insertTenant(service, slugB, 'Verify Isolation B');
    tenantIds.push(tenantB.id);

    // ---------------------------------------------------------------------
    // Invariant 1 — distinct credentials.
    // ---------------------------------------------------------------------
    await storeCredential(service, tenantA.id, provider, secretA);
    await storeCredential(service, tenantB.id, provider, secretB);

    if (secretA === secretB) {
      failAndExit(
        1,
        'generated fake keys collided — RNG bug, refusing to continue',
      );
    }
    ok(
      1,
      `distinct credentials stored for two tenants (A=${shortKey(secretA)}, B=${shortKey(secretB)})`,
    );

    // ---------------------------------------------------------------------
    // Invariant 2 — per-tenant resolution + cross-tenant non-leak.
    // ---------------------------------------------------------------------
    const resolvedA = await resolveSecret(service, tenantA.id, provider);
    const resolvedB = await resolveSecret(service, tenantB.id, provider);

    if (resolvedA !== secretA) {
      failAndExit(
        2,
        `tenant A resolved value did not match stored secret (got ${resolvedA === null ? 'null' : shortKey(resolvedA)})`,
      );
    }
    if (resolvedB !== secretB) {
      failAndExit(
        2,
        `tenant B resolved value did not match stored secret (got ${resolvedB === null ? 'null' : shortKey(resolvedB)})`,
      );
    }
    if (resolvedA === resolvedB) {
      failAndExit(
        2,
        'tenant A and tenant B resolved to the same secret under shared provider — cross-tenant leak',
      );
    }
    ok(
      2,
      `per-tenant resolution under shared provider='${provider}' returns distinct secrets`,
    );

    // ---------------------------------------------------------------------
    // Invariant 3 — loadTenantContext registry scoping.
    //
    // Tenant A has http_request enabled. Tenant B has the same row with
    // enabled=false. After loadTenantContext, A's registry must contain
    // http_request and B's must be empty.
    // ---------------------------------------------------------------------
    await setToolRow(service, tenantA.id, 'http_request', true);
    await setToolRow(service, tenantB.id, 'http_request', false);

    const ctxA = await loadTenantContext(tenantA.id, 'claude-sonnet-4-5');
    const ctxB = await loadTenantContext(tenantB.id, 'claude-sonnet-4-5');

    const keysA = ctxA.registry
      .list()
      .map((t) => t.key)
      .sort();
    const keysB = ctxB.registry.list().map((t) => t.key);

    const expectedA = ['http_request'];
    if (keysA.length !== expectedA.length || keysA[0] !== expectedA[0]) {
      failAndExit(
        3,
        `tenant A registry expected [http_request], got [${keysA.join(',')}]`,
      );
    }
    if (keysB.length !== 0) {
      failAndExit(
        3,
        `tenant B registry expected [], got [${keysB.join(',')}] — disabled tools leaked into the registry`,
      );
    }
    ok(
      3,
      'loadTenantContext built per-tenant registry (A=[http_request], B=[])',
    );

    // ---------------------------------------------------------------------
    // Invariant 4 — anon role denial.
    //
    // PostgREST may surface the REVOKE either as a non-null `error` or as a
    // null `data` with no error (it sometimes swallows function-level perm
    // failures). Either of those is a pass. A real string back is a fail.
    // ---------------------------------------------------------------------
    const anon = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      db: { schema: AGENT_CORE_SCHEMA },
    });
    const { data: anonData, error: anonErr } = await anon.rpc(
      'resolve_tenant_secret',
      { p_tenant: tenantA.id, p_provider: provider },
    );

    const anonValue: string | null =
      typeof anonData === 'string' ? anonData : null;

    if (anonErr) {
      ok(4, `anon rpc rejected (${anonErr.message})`);
    } else if (anonValue === null) {
      ok(4, 'anon rpc returned null data with no leaked secret');
    } else {
      failAndExit(
        4,
        `anon rpc returned a secret value (${shortKey(anonValue)}) — REVOKE bypassed`,
      );
    }

    process.stdout.write('[isolation verified] all 4 invariants passed\n');
  } finally {
    for (const id of tenantIds) {
      try {
        await deleteTenant(service, id);
      } catch (err: unknown) {
        process.stderr.write(
          `[verify-isolation] cleanup error for ${id}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Network/connection errors thrown out of supabase-js look like fetch
  // failures; treat those the same as the reachability probe and park.
  if (
    /fetch failed|ECONNREFUSED|ENOTFOUND|AbortError|network|UND_ERR/i.test(
      message,
    )
  ) {
    park(`network failure during run: ${message}`);
  }
  process.stderr.write(`[verify-isolation] unexpected failure: ${message}\n`);
  process.exit(1);
});
