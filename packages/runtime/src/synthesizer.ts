import { callModel } from "./model";
import type { RunContext, ToolResult } from "./types";

const SYSTEM = `You are Agent Core's writer. Using only the tool evidence,
answer the user clearly and concisely. Do not claim anything the evidence does
not support. Write like a knowledgeable operator — never like a chatbot.`;

export async function synthesize(
  ctx: RunContext,
  message: string,
  results: ToolResult[]
): Promise<string> {
  const evidence = results
    .map(
      (r) =>
        `[${r.tool}] ${r.ok ? JSON.stringify(r.output) : "ERROR: " + r.error}`
    )
    .join("\n");

  const prompt = `User request:\n${message}\n\nTool evidence:\n${
    evidence || "(no tools were run)"
  }\n\nWrite the answer.`;

  return callModel({
    provider: ctx.modelProvider,
    apiKey: ctx.apiKey,
    model: ctx.model,
    system: SYSTEM,
    prompt,
  });
}
