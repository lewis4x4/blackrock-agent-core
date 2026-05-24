import { ToolRegistry, builtins } from "@blackrock-ai/agent-tools";
import { plan } from "./planner";
import { execute } from "./executor";
import { synthesize } from "./synthesizer";
import { critique } from "./critic";
import { loadTenantContext } from "./context";
import { formatSse } from "./events";
import type { AgentEvent } from "./events";
import {
  finalizeRun,
  recordMessage,
  recordRunStart,
  recordToolResults,
} from "./persistence";
import type { AgentResult, RunContext } from "./types";

// Edge runtime global. The runtime targets Deno (Supabase Edge Functions).
declare const Deno: { env: { get(name: string): string | undefined } };

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const SSE_HEADERS: Record<string, string> = {
  ...CORS,
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Disable nginx-style proxy buffering so frames flush as they're enqueued.
  "x-accel-buffering": "no",
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

function randomRunId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback only — Deno, Bun, and modern Node ship randomUUID, so this
  // path is theoretical. We still generate a v4-shaped UUID so the value
  // is insertable into agent_runs.id (uuid column) without coercion.
  const bytes = new Uint8Array(16);
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Builds the agent HTTP handler. Drop this straight into a Supabase Edge
 * Function:  Deno.serve(createAgentHandler());
 *
 * SPRINT 3: the response is now `text/event-stream`. Each phase of the
 * orchestrator emits a typed event from `./events` — plan, tool_start,
 * tool_end, answer, critic, final, error. Consumers should use
 * `createAgentClient` from `@blackrock-ai/agent-core` (the shell package) to
 * consume it.
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
    if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

    // Validate the request body BEFORE opening the SSE stream so a malformed
    // POST still gets a clean 400 instead of an event-stream that just errors.
    let tenantId: string;
    let message: string;
    let model = "";
    try {
      const body: any = await req.json();
      tenantId = body?.tenantId;
      message = body?.message;
      model = body?.model ?? "";
      if (!tenantId || !message) {
        return jsonResponse(
          { error: "tenantId and message are required" },
          400
        );
      }
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    const runId = randomRunId();
    const encoder = new TextEncoder();
    // Hoisted so the `cancel` callback can flip it on client disconnect —
    // otherwise pending emit() calls would try to enqueue into a cancelled
    // controller until the orchestrator returns naturally.
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: AgentEvent) => {
          if (closed) return;
          controller.enqueue(encoder.encode(formatSse(event)));
        };

        // Per-run state visible to both the try and the finally below.
        let tokensIn = 0;
        let tokensOut = 0;
        let cost = 0;
        let finalGraph: AgentResult["taskGraph"] | undefined;
        let runStatus: "completed" | "failed" = "failed";
        let runError: string | undefined;

        try {
          emit({ type: "start", runId, tenantId });

          // 1. Resolve tenant context.
          let ctx: RunContext;
          if (customLoad) {
            const base = await customLoad(tenantId, model);
            ctx = { ...base, registry };
          } else if (Deno.env.get("AGENT_ENV") === "dev") {
            const base = await devEnvLoadContext(tenantId, model);
            ctx = { ...base, registry };
          } else {
            ctx = await loadTenantContext(tenantId, model);
          }

          // Persist the agent_runs row + the user message before any LLM
          // call. Best-effort: a persistence failure is logged but does not
          // abort the agent run.
          await recordRunStart({
            runId,
            tenantId,
            model: ctx.model,
            modelProvider: ctx.modelProvider,
            userMessage: message,
          });

          // Per-LLM-call token accumulator.
          const addUsage = (u: {
            tokensIn: number;
            tokensOut: number;
            cost: number;
          }) => {
            tokensIn += u.tokensIn;
            tokensOut += u.tokensOut;
            cost += u.cost;
          };

          // 2. Plan.
          const planned = await plan(ctx, message);
          addUsage(planned.usage);
          const graph = planned.graph;
          finalGraph = graph;
          emit({ type: "plan", graph });
          await recordMessage({
            runId,
            tenantId,
            role: "assistant",
            content: { kind: "plan", graph, usage: planned.usage },
          });

          // 3. Execute tools — executor emits tool_start / tool_end per task.
          const results = await execute(ctx, graph, { onEvent: emit });
          await recordToolResults(runId, tenantId, results);

          // 4. Synthesize a draft answer.
          const drafted = await synthesize(ctx, message, results);
          addUsage(drafted.usage);
          let answer = drafted.text;
          emit({ type: "answer", text: answer });
          await recordMessage({
            runId,
            tenantId,
            role: "assistant",
            content: { kind: "draft_answer", text: answer, usage: drafted.usage },
          });

          // 5. Critic pass — optionally correct once against verifier feedback.
          const verdict = await critique(ctx, message, answer, results);
          addUsage(verdict.usage);
          emit({
            type: "critic",
            ok: verdict.ok,
            notes: verdict.notes,
          });
          await recordMessage({
            runId,
            tenantId,
            role: "assistant",
            content: {
              kind: "critic",
              ok: verdict.ok,
              notes: verdict.notes,
              usage: verdict.usage,
            },
          });

          if (!verdict.ok) {
            const corrected = await synthesize(
              ctx,
              `${message}\n\nVerifier feedback to address: ${verdict.notes}`,
              results
            );
            addUsage(corrected.usage);
            answer = corrected.text;
            emit({ type: "answer", text: answer });
            await recordMessage({
              runId,
              tenantId,
              role: "assistant",
              content: {
                kind: "final_answer",
                text: answer,
                usage: corrected.usage,
              },
            });
          }

          const result: AgentResult = {
            answer,
            verified: verdict.ok,
            criticNotes: verdict.notes,
            taskGraph: graph,
            results,
            usage: { tokensIn, tokensOut, cost },
          };
          emit({ type: "final", result });
          runStatus = "completed";
        } catch (e) {
          // Log the full error server-side; emit a sanitized message to the
          // caller. Raw errors from loadTenantContext can include tenant ids,
          // provider names, and Vault/RLS state — never leak that downstream.
          console.error("agent-handler error:", e);
          runStatus = "failed";
          runError = e instanceof Error ? e.message : String(e);
          emit({ type: "error", message: "internal error" });
        } finally {
          // Best-effort terminal update — fires even if the try threw before
          // ctx was resolved, so the agent_runs row always lands in a
          // terminal state instead of being stuck in 'running'.
          await finalizeRun({
            runId,
            tenantId,
            status: runStatus,
            usage: { tokensIn, tokensOut, cost },
            taskGraph: finalGraph,
            error: runError,
          });
          closed = true;
          controller.close();
        }
      },
      cancel() {
        // Client disconnected. Flip `closed` so the orchestrator's pending
        // emit() calls become no-ops until the pipeline returns naturally —
        // we can't synchronously abort the in-flight LLM/tool calls from here.
        closed = true;
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
