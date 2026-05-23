// Service-role tenant bootstrap. Never import from a browser bundle — this
// script requires SUPABASE_SERVICE_ROLE_KEY and writes secrets into Vault.
//
// Usage:
//   bun packages/schema/scripts/bootstrap-tenant.ts \
//     --slug acme --display-name "Acme, Inc." \
//     --provider anthropic --api-key sk-ant-... \
//     --tools http_request,web_search,doc_generate,data_query

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type Provider = 'anthropic' | 'openai';

interface ParsedArgs {
  slug: string;
  displayName: string;
  provider: Provider;
  apiKey: string;
  tools: string[];
}

const USAGE = `Usage:
  bun packages/schema/scripts/bootstrap-tenant.ts \\
    --slug <text> \\
    --display-name <text> \\
    --provider <anthropic|openai> \\
    --api-key <text> \\
    --tools <comma-separated>

Required env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
`;

function fail(message: string): never {
  process.stderr.write(`[bootstrap] error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function getFlag(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

function isProvider(value: string): value is Provider {
  return value === 'anthropic' || value === 'openai';
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const slug = getFlag(argv, 'slug');
  const displayName = getFlag(argv, 'display-name');
  const providerRaw = getFlag(argv, 'provider');
  const apiKey = getFlag(argv, 'api-key');
  const toolsRaw = getFlag(argv, 'tools');

  if (!slug) fail('missing required flag --slug');
  if (!displayName) fail('missing required flag --display-name');
  if (!providerRaw) fail('missing required flag --provider');
  if (!apiKey) fail('missing required flag --api-key');
  if (!toolsRaw) fail('missing required flag --tools');

  if (!isProvider(providerRaw)) {
    fail(`invalid --provider "${providerRaw}" (expected anthropic|openai)`);
  }

  const tools = toolsRaw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tools.length === 0) fail('--tools must contain at least one tool key');

  return { slug, displayName, provider: providerRaw, apiKey, tools };
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) fail(`missing required env var ${name}`);
  return value;
}

interface TenantRow {
  id: string;
  slug: string;
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

  if (error) fail(`failed to insert tenant: ${error.message}`);
  if (!data) fail('tenant insert returned no row');
  return data;
}

async function storeCredential(
  supabase: SupabaseClient,
  tenantId: string,
  provider: Provider,
  apiKey: string,
): Promise<void> {
  const { error } = await supabase.rpc('store_tenant_credential', {
    p_tenant: tenantId,
    p_provider: provider,
    p_secret: apiKey,
    p_meta: { source: 'bootstrap-tenant' },
  });

  if (error) fail(`failed to store credential in vault: ${error.message}`);
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
    fail(`failed to enable tools: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    process.exit(1);
  }

  const args = parseArgs(argv);
  const supabaseUrl = getEnv('SUPABASE_URL');
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const tenant = await insertTenant(supabase, args.slug, args.displayName);
  await storeCredential(supabase, tenant.id, args.provider, args.apiKey);

  // Tools land in a single batch insert so a failure leaves no partial tool set.
  // If this batch fails after credential storage, the operator must manually
  // `delete from tenants where id = '<id>'` (cascades to credentials and tools).
  await enableTools(supabase, tenant.id, args.tools);

  process.stdout.write(
    `[bootstrap] tenant ${tenant.slug} created with id ${tenant.id}, ` +
      `provider ${args.provider}, tools ${args.tools.join(',')}\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(`unexpected failure: ${message}`);
});
