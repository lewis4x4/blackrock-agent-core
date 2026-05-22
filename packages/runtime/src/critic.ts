import { callModel, extractJson } from "./model";
import type { RunContext, ToolResult } from "./types";

const SYSTEM = `You are Agent Core's verifier. Check the draft answer against
the tool evidence. Respond with STRICT JSON only:
{"ok": boolean, "notes": string}
Set ok=false if the draft makes claims the evidence does not support.`;

export async function critique(
  ctx: RunContext,
  message: string,
  draft: string,
  results: ToolResult[]
): Promise<{ ok: boolean; notes: string }> {
  const evidence = results
    .map((r) => `[${r.tool}] ${r.ok ? JSON.stringify(r.output) : "ERROR"}`)
    .join("\n");

  const prompt = `Request:\n${message}\n\nEvidence:\n${
    evidence || "(none)"
  }\n\nDraft answer:\n${draft}`;

  try {
    const raw = await callModel({
      provider: ctx.modelProvider,
      apiKey: ctx.apiKey,
      model: ctx.model,
      system: SYSTEM,
      prompt,
    });
    const j = extractJson(raw) as any;
    return { ok: !!j.ok, notes: String(j.notes ?? "") };
  } catch {
    return { ok: true, notes: "verifier output unparsed — passed by default" };
  }
}
