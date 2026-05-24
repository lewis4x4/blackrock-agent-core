// SPRINT 4 / Run-persistence remediation: server-only writer that records
// every agent run + its messages into Supabase. Never bundle into a
// browser/UI build — service-role key required.
//
// The handler calls into this module from three points:
//   1. recordRunStart  — INSERT the agent_runs row at the start of the
//      pipeline (so even a run that errors mid-pipeline leaves a trace).
//   2. recordMessage   — APPEND an agent_messages row for plan, each
//      tool result, the draft answer, and the verifier verdict.
//   3. finalizeRun     — UPDATE agent_runs with final tokens/cost/status
//      and completed_at when the pipeline exits.
//
// Failures here are logged but never thrown to the caller — persistence is
// best-effort observability; a Supabase outage must not break an agent run.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TaskGraph, TokenUsage, ToolResult } from "./types";
import { AGENT_CORE_SCHEMA } from "./constants";

function readEnv(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  return g.Deno?.env.get(name) ?? g.process?.env?.[name];
}

// any: Supabase's generated DB types are not available here; the "agent_core"
// string literal still narrows the schema target. The row shape is loose.
let cachedClient: ReturnType<typeof createClient<any, "agent_core">> | null = null;
function getSupabase(): ReturnType<typeof createClient<any, "agent_core">> | null {
  if (cachedClient) return cachedClient;
  const url = readEnv("SUPABASE_URL");
  const key = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  cachedClient = createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: AGENT_CORE_SCHEMA },
  });
  return cachedClient;
}

export type MessageRole = "user" | "assistant" | "tool";

export interface RecordRunStartInput {
  runId: string;
  tenantId: string;
  model: string;
  modelProvider: string;
  userMessage: string;
}

/**
 * Insert the agent_runs row at the start of the pipeline AND record the
 * user's prompt as the first agent_messages row. Returns false on any
 * failure (logged); the caller should not abort the run on a false return.
 */
export async function recordRunStart(input: RecordRunStartInput): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  try {
    const { error: runErr } = await supabase.from("agent_runs").insert({
      id: input.runId,
      tenant_id: input.tenantId,
      model: input.model,
      model_provider: input.modelProvider,
      status: "running",
    });
    if (runErr) {
      console.error("persistence: recordRunStart agent_runs insert failed:", runErr);
      return false;
    }
    await recordMessage({
      runId: input.runId,
      tenantId: input.tenantId,
      role: "user",
      content: { text: input.userMessage },
    });
    return true;
  } catch (e) {
    console.error("persistence: recordRunStart threw:", e);
    return false;
  }
}

export interface RecordMessageInput {
  runId: string;
  tenantId: string;
  role: MessageRole;
  content: Record<string, unknown>;
}

/**
 * Append a single agent_messages row. All persistence is best-effort —
 * Supabase errors are logged but never thrown. Returns true on success.
 */
export async function recordMessage(input: RecordMessageInput): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("agent_messages").insert({
      run_id: input.runId,
      tenant_id: input.tenantId,
      role: input.role,
      content: input.content,
    });
    if (error) {
      console.error("persistence: recordMessage failed:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("persistence: recordMessage threw:", e);
    return false;
  }
}

/**
 * Convenience: persist every ToolResult from one execution wave as
 * role='tool' messages, all sharing the same run. Returns the number
 * of rows actually written (best-effort).
 */
export async function recordToolResults(
  runId: string,
  tenantId: string,
  results: ToolResult[]
): Promise<number> {
  let written = 0;
  for (const r of results) {
    const ok = await recordMessage({
      runId,
      tenantId,
      role: "tool",
      content: {
        tool: r.tool,
        taskId: r.taskId,
        ok: r.ok,
        output: r.output,
        error: r.error,
      },
    });
    if (ok) written += 1;
  }
  return written;
}

export interface FinalizeRunInput {
  runId: string;
  tenantId: string;
  status: "completed" | "failed";
  usage: TokenUsage;
  taskGraph?: TaskGraph;
  error?: string;
}

/**
 * Stamp the agent_runs row with terminal state. The trigger from migration
 * 0005 keeps updated_at honest; we explicitly set completed_at since that's
 * the operational "this run is done" signal.
 */
export async function finalizeRun(input: FinalizeRunInput): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  try {
    const { error } = await supabase
      .from("agent_runs")
      .update({
        status: input.status,
        tokens_in: input.usage.tokensIn,
        tokens_out: input.usage.tokensOut,
        cost_estimate: input.usage.cost,
        task_graph: input.taskGraph ?? null,
        error: input.error ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", input.runId)
      .eq("tenant_id", input.tenantId);
    if (error) {
      console.error("persistence: finalizeRun failed:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("persistence: finalizeRun threw:", e);
    return false;
  }
}
