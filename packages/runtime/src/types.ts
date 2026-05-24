import type { ToolRegistry } from "@blackrock-ai/agent-tools";

export type ModelProvider = "anthropic" | "openai";

/** Everything one agent run needs. Built per request, per tenant. */
export interface RunContext {
  tenantId: string;
  model: string;
  modelProvider: ModelProvider;
  /** Resolved server-side. SPRINT 1: from Supabase Vault, never the browser. */
  apiKey: string;
  registry: ToolRegistry;
}

/** A single planned unit of work. */
export interface Task {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn?: string[];
}

export interface TaskGraph {
  rationale?: string;
  tasks: Task[];
}

export interface ToolResult {
  taskId: string;
  tool: string;
  ok: boolean;
  output: unknown;
  error?: string;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export interface AgentResult {
  answer: string;
  verified: boolean;
  criticNotes?: string;
  taskGraph: TaskGraph;
  results: ToolResult[];
  usage: TokenUsage;
}
