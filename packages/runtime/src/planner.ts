import { callModel, extractJson } from "./model";
import type { RunContext, TaskGraph } from "./types";

const SYSTEM = `You are the Agent Core planner. Decompose the user request into a
task graph the executor can run. Respond with STRICT JSON only, no prose:
{"rationale": string, "tasks": [{"id": string, "tool": string, "input": object, "dependsOn": string[]}]}
Use only these tools: {{TOOLS}}.
If the request needs no tool, return {"rationale": "...", "tasks": []}.`;

export async function plan(ctx: RunContext, message: string): Promise<TaskGraph> {
  const tools = ctx.registry
    .list()
    .map((t) => `${t.key} (${t.description})`)
    .join("; ");
  const system = SYSTEM.replace("{{TOOLS}}", tools || "none");

  try {
    const raw = await callModel({
      provider: ctx.modelProvider,
      apiKey: ctx.apiKey,
      model: ctx.model,
      system,
      prompt: message,
    });
    const parsed = extractJson(raw) as any;
    return {
      rationale: parsed.rationale,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch {
    return {
      rationale: "Planner produced no structured graph; answering directly.",
      tasks: [],
    };
  }
}
