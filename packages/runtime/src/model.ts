import type { ModelProvider } from "./types";

/**
 * The single LLM integration point for the whole runtime.
 * Planner, synthesizer and critic all call through here.
 */
export async function callModel(opts: {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
}): Promise<string> {
  if (opts.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 4096,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    return (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/** Pull the first JSON object out of a model response. */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in response");
  return JSON.parse(raw.slice(start, end + 1));
}
