import type { AgentResult, TaskGraph, ToolResult } from "./types";

/**
 * The shared streaming event schema. Emitted by `createAgentHandler` as SSE
 * and parsed by `createAgentClient` on the consumer side. Adding a new event
 * type means extending the union here — both producer and consumer get a
 * compile error until they handle it.
 */
export type AgentEvent =
  | { type: "start"; runId: string; tenantId: string }
  | { type: "plan"; graph: TaskGraph }
  | {
      type: "tool_start";
      taskId: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      taskId: string;
      tool: string;
      ok: boolean;
      output: unknown;
      error?: string;
    }
  | { type: "answer"; text: string }
  | { type: "critic"; ok: boolean; notes: string }
  | { type: "final"; result: AgentResult }
  | { type: "error"; message: string };

export type AgentEventType = AgentEvent["type"];

export type ToolStartEvent = Extract<AgentEvent, { type: "tool_start" }>;
export type ToolEndEvent = Extract<AgentEvent, { type: "tool_end" }>;

/**
 * Re-export so callers that only need the executor-emitted result type don't
 * have to import from ./types as well.
 */
export type { ToolResult };

/**
 * Encode an `AgentEvent` as a single SSE frame. Format:
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * `data` is a JSON-encoded copy of the event itself (including the `type`
 * field), which keeps the client trivially decodable without separate
 * dispatch tables.
 */
export function formatSse(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Parse a single SSE frame (one `event:`/`data:` block, with the trailing
 * blank line already stripped) back into an `AgentEvent`. Returns `null` for
 * empty/unparseable frames so the caller can keep streaming.
 *
 * We trust the `data:` payload to contain the full event shape, including
 * `type`; the `event:` line is only used to short-circuit malformed frames.
 */
export function parseSseFrame(block: string): AgentEvent | null {
  if (!block) return null;
  let eventName: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      // SSE allows the value to start with a leading space — strip exactly one.
      const value = line.slice("data:".length);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }

  if (!eventName || dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join("\n"));
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed as AgentEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convenience: split a buffered chunk on the SSE frame delimiter `\n\n` and
 * return `{ events, remainder }`. The remainder is whatever trails the final
 * delimiter — the caller prepends it to the next chunk so a split-mid-frame
 * input never drops data.
 */
export function parseSseChunk(
  buffer: string
): { events: AgentEvent[]; remainder: string } {
  const events: AgentEvent[] = [];
  let rest = buffer;
  let idx = rest.indexOf("\n\n");
  while (idx !== -1) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const ev = parseSseFrame(frame);
    if (ev) events.push(ev);
    idx = rest.indexOf("\n\n");
  }
  return { events, remainder: rest };
}
