import { parseSseChunk } from "@blackrock-ai/agent-runtime";
import type { AgentEvent } from "@blackrock-ai/agent-runtime";

/**
 * Inputs for a single agent run.
 *
 * `signal` is optional but recommended in UI code — cancelling it disconnects
 * the SSE stream and signals the host that the user navigated away.
 */
export interface RunInput {
  tenantId: string;
  message: string;
  model?: string;
  signal?: AbortSignal;
}

export interface CreateAgentClientOptions {
  /** The POST endpoint mounted on `createAgentHandler` (full URL). */
  endpoint: string;
  /**
   * Extra headers merged onto every request. The host app injects auth here
   * (e.g. a Supabase session JWT) — agent-core itself never assumes a
   * particular auth scheme.
   */
  headers?: Record<string, string>;
  /**
   * Override fetch — useful for tests and for runtimes that ship a custom
   * fetch (e.g. a server-side proxy that injects auth).
   */
  fetch?: typeof fetch;
}

export interface AgentClient {
  /**
   * Open a streaming agent run. Yields `AgentEvent`s as they arrive. The
   * generator returns naturally when the server closes the stream — or
   * throws if the request fails, the response body is missing, or the
   * caller-supplied `signal` aborts.
   */
  run(input: RunInput): AsyncIterable<AgentEvent>;
}

/**
 * Browser/node-side companion to `createAgentHandler`. Parses the SSE stream
 * one frame at a time and yields strongly typed `AgentEvent`s.
 *
 * Pure data layer — no React imports — so React-free hosts (CLIs, server
 * actions, edge functions) can use it without pulling the workspace UI.
 */
export function createAgentClient(opts: CreateAgentClientOptions): AgentClient {
  const doFetch = opts.fetch ?? fetch;
  const baseHeaders = opts.headers ?? {};

  return {
    run({ tenantId, message, model, signal }) {
      return runStream();

      async function* runStream(): AsyncGenerator<AgentEvent, void, void> {
        const res = await doFetch(opts.endpoint, {
          method: "POST",
          headers: {
            ...baseHeaders,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({ tenantId, message, model }),
          signal,
        });

        if (!res.ok) {
          // Try to surface the server's JSON error body for non-2xx responses.
          let bodyText = "";
          try {
            bodyText = await res.text();
          } catch {
            // ignore — fall back to status code only
          }
          throw new Error(
            `agent-client: ${res.status} ${res.statusText}${
              bodyText ? `: ${bodyText.slice(0, 400)}` : ""
            }`
          );
        }
        if (!res.body) {
          throw new Error("agent-client: response has no body");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { events, remainder } = parseSseChunk(buffer);
            buffer = remainder;
            for (const event of events) {
              yield event;
            }
          }

          // Flush any trailing decoder state + a final frame that didn't end
          // with the SSE blank line. Most well-behaved servers will close
          // cleanly, but be defensive about partial frames.
          buffer += decoder.decode();
          if (buffer.length > 0) {
            const { events } = parseSseChunk(buffer + "\n\n");
            for (const event of events) {
              yield event;
            }
          }
        } finally {
          // Always release the underlying network resource, even on cancel.
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
        }
      }
    },
  };
}
