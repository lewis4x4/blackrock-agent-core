import { ToolRegistry, builtins } from "@blackrock/agent-tools";
import { plan } from "./planner";
import { execute } from "./executor";
import { synthesize } from "./synthesizer";
import { critique } from "./critic";
import { loadTenantContext } from "./context";
import type { AgentResult, RunContext } from "./types";

// Edge runtime global. The runtime targets Deno (Supabase Edge Functions).
declare const Deno: { env: { get(name: string): string | undefined } };

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export interface HandlerOptions {
  /**
   * SPRINT 1: replace the default with a Supabase Vault-backed lookup that
   * resolves per-tenant credentials from the `tenant_credentials` table.
   */
  loadTenantContext?: (
    tenantId: string,
    model: string
  ) => Promise<Omit<RunContext, "registry">>;
  registry?: ToolRegistry;
}

function defaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of builtins) r.register(t);
  return r;
}

// SPRINT 1 dev-only fallback. Gated behind AGENT_ENV=dev. Reads keys straight
// from the Edge Function's env so the scaffold runs without a Vault round-trip.
// Production takes the Vault path in `loadTenantContext` (see ./context.ts).
async function devEnvLoadContext(
  tenantId: string,
  model: string
): Promise<Omit<RunContext, "registry">> {
  const provider =
    (Deno.env.get("AGENT_MODEL_PROVIDER") as "anthropic" | "openai") ??
    "anthropic";
  const apiKey =
    Deno.env.get(provider === "anthropic" ? "ANTHROPIC_KEY" : "OPENAI_KEY") ??
    "";
  return {
    tenantId,
    model: model || Deno.env.get("AGENT_MODEL") || "claude-sonnet-4-5",
    modelProvider: provider,
    apiKey,
  };
}

/**
 * Builds the agent HTTP handler. Drop this straight into a Supabase Edge
 * Function:  Deno.serve(createAgentHandler());
 *
 * Context resolution order, per request:
 *   1. Caller-supplied `opts.loadTenantContext` (merged with `opts.registry`).
 *   2. AGENT_ENV=dev: env-var fallback (merged with `opts.registry`).
 *   3. Default (production): `loadTenantContext` from ./context — Vault-backed
 *      keys AND a per-tenant ToolRegistry. The default `opts.registry` is
 *      discarded in this path so tenants only see tools they've enabled.
 */
export function createAgentHandler(opts: HandlerOptions = {}) {
  const customLoad = opts.loadTenantContext;
  const registry = opts.registry ?? defaultRegistry();

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    try {
      // Edge handler reads arbitrary JSON; cast is unavoidable at the boundary.
      const body: any = await req.json();
      const tenantId = body?.tenantId;
      const message = body?.message;
      const model = body?.model ?? "";
      if (!tenantId || !message) {
        return json({ error: "tenantId and message are required" }, 400);
      }

      let ctx: RunContext;
      if (customLoad) {
        const base = await customLoad(tenantId, model);
        ctx = { ...base, registry };
      } else if (Deno.env.get("AGENT_ENV") === "dev") {
        const base = await devEnvLoadContext(tenantId, model);
        ctx = { ...base, registry };
      } else {
        // Production: Vault-backed keys + per-tenant registry from ./context.
        ctx = await loadTenantContext(tenantId, model);
      }

      const graph = await plan(ctx, message);
      const results = await execute(ctx, graph);
      let answer = await synthesize(ctx, message, results);
      const verdict = await critique(ctx, message, answer, results);

      if (!verdict.ok) {
        // one corrective pass against the verifier's feedback
        answer = await synthesize(
          ctx,
          `${message}\n\nVerifier feedback to address: ${verdict.notes}`,
          results
        );
      }

      const result: AgentResult = {
        answer,
        verified: verdict.ok,
        criticNotes: verdict.notes,
        taskGraph: graph,
        results,
      };
      return json(result, 200);
    } catch (e) {
      // Log the full error server-side; return a generic message to the caller.
      // Raw errors from loadTenantContext can include tenant ids, provider
      // names, and Vault/RLS state — never leak that to an unauthenticated POST.
      console.error("agent-handler error:", e);
      return json({ error: "internal error" }, 500);
    }
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
