import { afterEach, describe, expect, mock, test } from "bun:test";
import { formatSse } from "@blackrock-ai/agent-runtime";
import type { AgentEvent } from "@blackrock-ai/agent-runtime";
import { createAgentClient } from "../client";

const ENDPOINT = "https://example.test/agent";

function sseStream(events: AgentEvent[], chunkSize?: number): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(events.map(formatSse).join(""));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= encoded.length) {
        controller.close();
        return;
      }
      const end = chunkSize ? Math.min(encoded.length, i + chunkSize) : encoded.length;
      controller.enqueue(encoded.slice(i, end));
      i = end;
    },
  });
}

function okResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const SAMPLE: AgentEvent[] = [
  { type: "start", runId: "r1", tenantId: "t1" },
  {
    type: "plan",
    graph: { tasks: [{ id: "t1", tool: "web_search", input: { q: "x" } }] },
  },
  { type: "answer", text: "hi" },
  { type: "critic", ok: true, notes: "" },
  {
    type: "final",
    result: {
      answer: "hi",
      verified: true,
      taskGraph: { tasks: [] },
      results: [],
      usage: { tokensIn: 0, tokensOut: 0, cost: 0 },
    },
  },
];

afterEach(() => {
  // Reset any global fetch overrides between tests.
});

describe("createAgentClient", () => {
  test("yields every event in order when chunked at the network boundary", async () => {
    const fetchMock = mock(async () => okResponse(sseStream(SAMPLE, 8)));
    const client = createAgentClient({
      endpoint: ENDPOINT,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const got: AgentEvent[] = [];
    for await (const e of client.run({ tenantId: "t1", message: "hi" })) {
      got.push(e);
    }
    expect(got).toEqual(SAMPLE);
  });

  test("yields every event when the whole stream arrives in one chunk", async () => {
    const fetchMock = mock(async () => okResponse(sseStream(SAMPLE)));
    const client = createAgentClient({
      endpoint: ENDPOINT,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const got: AgentEvent[] = [];
    for await (const e of client.run({ tenantId: "t1", message: "hi" })) {
      got.push(e);
    }
    expect(got.length).toBe(SAMPLE.length);
  });

  test("throws on non-OK responses and surfaces the body", async () => {
    const fetchMock = mock(
      async () =>
        new Response('{"error":"invalid"}', {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        })
    );
    const client = createAgentClient({
      endpoint: ENDPOINT,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(async () => {
      for await (const _ of client.run({ tenantId: "t1", message: "hi" })) {
        // unreachable
      }
    }).toThrow(/400/);
  });

  test("merges headers and POSTs the JSON body", async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer x");
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("accept")).toBe("text/event-stream");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          tenantId: "t1",
          message: "hi",
          model: "claude-sonnet-4-5",
        });
        return okResponse(sseStream(SAMPLE));
      }
    );

    const client = createAgentClient({
      endpoint: ENDPOINT,
      headers: { authorization: "Bearer x" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const it = client.run({
      tenantId: "t1",
      message: "hi",
      model: "claude-sonnet-4-5",
    });
    // Drain the iterator so fetch is invoked.
    for await (const _ of it) {
      // no-op
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
