import { describe, expect, test } from "bun:test";
import {
  formatSse,
  parseSseChunk,
  parseSseFrame,
  type AgentEvent,
} from "../events";

const RUN_ID = "run_test_0001";
const TENANT = "t_acme";

const SAMPLE_EVENTS: AgentEvent[] = [
  { type: "start", runId: RUN_ID, tenantId: TENANT },
  {
    type: "plan",
    graph: {
      rationale: "search the web then answer",
      tasks: [
        { id: "t1", tool: "web_search", input: { query: "test" } },
      ],
    },
  },
  {
    type: "tool_start",
    taskId: "t1",
    tool: "web_search",
    input: { query: "test" },
  },
  {
    type: "tool_end",
    taskId: "t1",
    tool: "web_search",
    ok: true,
    output: { results: [] },
  },
  { type: "answer", text: "ok" },
  { type: "critic", ok: true, notes: "" },
  {
    type: "final",
    result: {
      answer: "ok",
      verified: true,
      taskGraph: { tasks: [] },
      results: [],
    },
  },
  { type: "error", message: "internal error" },
];

describe("formatSse", () => {
  test("produces a well-formed SSE frame", () => {
    const frame = formatSse({ type: "answer", text: "hello" });
    expect(frame).toBe(
      `event: answer\ndata: ${JSON.stringify({ type: "answer", text: "hello" })}\n\n`
    );
  });

  test("each frame ends with a double newline", () => {
    for (const e of SAMPLE_EVENTS) {
      expect(formatSse(e).endsWith("\n\n")).toBe(true);
    }
  });
});

describe("parseSseFrame", () => {
  test("round-trips every event type via format → parse", () => {
    for (const e of SAMPLE_EVENTS) {
      const frame = formatSse(e).replace(/\n\n$/, "");
      const parsed = parseSseFrame(frame);
      expect(parsed).toEqual(e);
    }
  });

  test("returns null for empty / malformed input", () => {
    expect(parseSseFrame("")).toBeNull();
    expect(parseSseFrame(": comment only")).toBeNull();
    expect(parseSseFrame("event: foo\ndata: not-json")).toBeNull();
    expect(parseSseFrame("event: foo")).toBeNull();
  });

  test("handles CRLF line endings", () => {
    const payload: AgentEvent = { type: "answer", text: "x" };
    const frame = `event: answer\r\ndata: ${JSON.stringify(payload)}`;
    expect(parseSseFrame(frame)).toEqual(payload);
  });
});

describe("parseSseChunk", () => {
  test("splits multiple frames in a single chunk", () => {
    const buffer =
      formatSse({ type: "answer", text: "a" }) +
      formatSse({ type: "critic", ok: true, notes: "" });

    const { events, remainder } = parseSseChunk(buffer);
    expect(events).toHaveLength(2);
    const [first, second] = events;
    expect(first).toEqual({ type: "answer", text: "a" } satisfies AgentEvent);
    expect(second).toEqual({
      type: "critic",
      ok: true,
      notes: "",
    } satisfies AgentEvent);
    expect(remainder).toBe("");
  });

  test("preserves an incomplete trailing frame as remainder", () => {
    const full = formatSse({ type: "answer", text: "a" });
    const partial = "event: critic\ndata: ";
    const { events, remainder } = parseSseChunk(full + partial);
    expect(events).toHaveLength(1);
    expect(remainder).toBe(partial);
  });

  test("supports re-feeding the remainder on the next chunk", () => {
    const e1 = formatSse({ type: "answer", text: "first" });
    const e2 = formatSse({ type: "answer", text: "second" });

    // Simulate two reads that split the second frame in half.
    const chunk1 = e1 + e2.slice(0, 10);
    const chunk2 = e2.slice(10);

    const r1 = parseSseChunk(chunk1);
    expect(r1.events).toHaveLength(1);
    const r2 = parseSseChunk(r1.remainder + chunk2);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0]).toEqual({
      type: "answer",
      text: "second",
    } satisfies AgentEvent);
  });
});
