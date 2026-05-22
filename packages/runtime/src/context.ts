// SPRINT 1: server-only. Never import into UI/browser code — pulls service-role keys.
import { createClient } from "@supabase/supabase-js";
import { ToolRegistry, builtins } from "@blackrock/agent-tools";
import type { ModelProvider, RunContext } from "./types";

// Edge runtime global. Mirrors handler.ts — we target Deno (Supabase Edge Functions).
declare const Deno: { env: { get(name: string): string | undefined } };

const MODEL_PROVIDERS: ReadonlySet<ModelProvider> = new Set<ModelProvider>([
  "anthropic",
  "openai",
]);

/**
 * Resolve everything a per-request agent run needs, server-side:
 *   1. Look up the tenant's model provider in `tenant_credentials`.
 *   2. Decrypt the matching secret via the `resolve_tenant_secret` RPC.
 *   3. Assemble a per-tenant ToolRegistry from `tenant_tools` (only enabled tools).
 *
 * Returns the FULL `RunContext` (registry included) — the handler uses this
 * directly, bypassing the default registry, so a tenant only ever sees the
 * tools that have been explicitly enabled for them.
 */
export async function loadTenantContext(
  tenantId: string,
  model: string
): Promise<RunContext> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "loadTenantContext: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // 1. Find the model credential row for this tenant.
  const { data: credRows, error: credErr } = await supabase
    .from("tenant_credentials")
    .select("provider")
    .eq("tenant_id", tenantId)
    .in("provider", ["anthropic", "openai"]);

  if (credErr) {
    throw new Error(
      `loadTenantContext: failed to read tenant_credentials: ${credErr.message}`
    );
  }
  if (!credRows || credRows.length === 0) {
    throw new Error(
      `loadTenantContext: no model credential (anthropic|openai) for tenant ${tenantId}`
    );
  }

  // `provider` column is typed as `unknown` coming back from the generic client; narrow it.
  const rawProvider = (credRows[0] as { provider: string }).provider;
  if (!MODEL_PROVIDERS.has(rawProvider as ModelProvider)) {
    throw new Error(
      `loadTenantContext: unexpected provider '${rawProvider}' for tenant ${tenantId}`
    );
  }
  const provider = rawProvider as ModelProvider;

  // 2. Decrypt the secret via RPC.
  const { data: secretData, error: secretErr } = await supabase.rpc(
    "resolve_tenant_secret",
    { p_tenant: tenantId, p_provider: provider }
  );
  if (secretErr) {
    throw new Error(
      `loadTenantContext: resolve_tenant_secret failed: ${secretErr.message}`
    );
  }
  // RPC returns `text`; supabase-js types it as `unknown` for generic RPCs.
  const apiKey = typeof secretData === "string" ? secretData : "";
  if (!apiKey) {
    throw new Error(
      `loadTenantContext: empty secret returned for tenant ${tenantId}/${provider}`
    );
  }

  // 3. Build a per-tenant registry from enabled tool rows.
  const { data: toolRows, error: toolErr } = await supabase
    .from("tenant_tools")
    .select("tool_key")
    .eq("tenant_id", tenantId)
    .eq("enabled", true);

  if (toolErr) {
    throw new Error(
      `loadTenantContext: failed to read tenant_tools: ${toolErr.message}`
    );
  }

  const enabledKeys = new Set<string>(
    (toolRows ?? []).map((r) => (r as { tool_key: string }).tool_key)
  );
  const registry = new ToolRegistry();
  for (const tool of builtins) {
    if (enabledKeys.has(tool.key)) registry.register(tool);
  }

  const finalModel =
    model || Deno.env.get("AGENT_MODEL") || "claude-sonnet-4-5";

  return {
    tenantId,
    model: finalModel,
    modelProvider: provider,
    apiKey,
    registry,
  };
}
