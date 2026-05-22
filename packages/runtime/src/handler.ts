import { ToolRegistry, builtins } from "@blackrock/agent-tools";
import { plan } from "./planner";
import { execute } from "./executor";
import { synthesize } from "./synthesizer";
import { critique } from "./critic";
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

// SPRINT 1: production resolves per-tenant keys from Supabase Vault. This
// default reads from the Edge Function's own env so the scaffold runs today.
async function defaultLoadContext(
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
 */
export function createAgentHandler(opts: HandlerOptions = {}) {
  const registry = opts.registry ?? defaultRegistry();
  const loadCtx = opts.loadTenantContext ?? defaultLoadContext;

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    try {
      const body: any = await req.json();
      const tenantId = body?.tenantId;
      const message = body?.message;
      const model = body?.model ?? "";
      if (!tenantId || !message) {
        return json({ error: "tenantId and message are required" }, 400);
      }

      const base = await loadCtx(tenantId, model);
      const ctx: RunContext = { ...base, registry };

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
      return json({ error: String(e) }, 500);
    }
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
