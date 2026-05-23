// Verifies the SSE event schema in packages/runtime/src/events.ts:
//   1. formatSse → parseSseFrame is a faithful round-trip across every
//      AgentEvent variant.
//   2. parseSseChunk recovers events even when a sequence of frames is
//      split mid-frame across chunk boundaries — the producer's stream
//      can deliver bytes however it likes.
//   3. parseSseFrame returns null (not throws) for empty / malformed input.
//   4. The client-side asynciterable in @blackrock/agent-core (the shell
//      package) actually yields the events through its full read loop —
//      this exercises createAgentClient end-to-end against a stub SSE body.
//
// Pure offline — no live LLM, no Supabase. Exits 0 on full pass.

import { createAgentClient } from '@blackrock/agent-core';
import {
  formatSse,
  parseSseChunk,
  parseSseFrame,
  type AgentEvent,
} from '@blackrock/agent-runtime';

let passes = 0;
let fails = 0;

function ok(invariant: number, detail: string): void {
  process.stdout.write(`[ok] invariant ${invariant} — ${detail}\n`);
  passes += 1;
}

function fail(invariant: number, detail: string): void {
  process.stdout.write(`[fail] invariant ${invariant} — ${detail}\n`);
  fails += 1;
}

const SAMPLES: AgentEvent[] = [
  { type: 'start', runId: 'run_test', tenantId: 't_acme' },
  {
    type: 'plan',
    graph: {
      rationale: 'search and answer',
      tasks: [{ id: 't1', tool: 'web_search', input: { query: 'x' } }],
    },
  },
  {
    type: 'tool_start',
    taskId: 't1',
    tool: 'web_search',
    input: { query: 'x' },
  },
  {
    type: 'tool_end',
    taskId: 't1',
    tool: 'web_search',
    ok: true,
    output: { results: [{ title: 'one' }] },
  },
  { type: 'answer', text: 'ok' },
  { type: 'critic', ok: true, notes: '' },
  {
    type: 'final',
    result: {
      answer: 'ok',
      verified: true,
      taskGraph: { tasks: [] },
      results: [],
    },
  },
  { type: 'error', message: 'internal error' },
];

async function main(): Promise<void> {
  process.stdout.write(
    `[verify-streaming] exercising ${SAMPLES.length} event variant(s)\n`,
  );

  // 1 — format → parseFrame round-trip.
  for (const event of SAMPLES) {
    const frame = formatSse(event).replace(/\n\n$/, '');
    const parsed = parseSseFrame(frame);
    if (!parsed) {
      fail(1, `${event.type}: parseSseFrame returned null`);
      continue;
    }
    if (JSON.stringify(parsed) !== JSON.stringify(event)) {
      fail(1, `${event.type}: round-trip differed`);
      continue;
    }
    ok(1, `${event.type}: round-trip clean`);
  }

  // 2 — parseSseChunk handles split-mid-frame inputs.
  const joined = SAMPLES.map(formatSse).join('');
  const splitPoint = Math.floor(joined.length * 0.42);
  const chunkA = joined.slice(0, splitPoint);
  const chunkB = joined.slice(splitPoint);
  const r1 = parseSseChunk(chunkA);
  const r2 = parseSseChunk(r1.remainder + chunkB);
  const recovered = [...r1.events, ...r2.events];
  if (recovered.length !== SAMPLES.length) {
    fail(
      2,
      `expected ${SAMPLES.length} events from split chunks, got ${recovered.length}`,
    );
  } else if (JSON.stringify(recovered) !== JSON.stringify(SAMPLES)) {
    fail(2, `split-chunk recovery produced different events`);
  } else {
    ok(2, `${SAMPLES.length} events recovered across a mid-frame split`);
  }

  // 3 — malformed input returns null without throwing.
  const malformed = [
    '',
    ': only a comment',
    'event: bad\ndata: not-json',
    'event: bad', // no data line
  ];
  for (const bad of malformed) {
    const parsed = parseSseFrame(bad);
    if (parsed !== null) {
      fail(3, `expected null for malformed input ${JSON.stringify(bad)}`);
    } else {
      ok(
        3,
        `malformed input ${JSON.stringify(bad).slice(0, 40)} returned null`,
      );
    }
  }

  // 4 — createAgentClient yields events from a stub SSE body.
  const stubBody = new TextEncoder().encode(joined);
  const fakeFetch: typeof fetch = async () =>
    new Response(stubBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const client = createAgentClient({
    endpoint: 'https://example.test/agent',
    fetch: fakeFetch,
  });
  const yielded: AgentEvent[] = [];
  for await (const e of client.run({
    tenantId: 't_acme',
    message: 'irrelevant',
  })) {
    yielded.push(e);
  }
  if (yielded.length !== SAMPLES.length) {
    fail(4, `client yielded ${yielded.length} events, expected ${SAMPLES.length}`);
  } else if (JSON.stringify(yielded) !== JSON.stringify(SAMPLES)) {
    fail(4, `client yielded different events than the stub provided`);
  } else {
    ok(4, `createAgentClient yielded all ${SAMPLES.length} events in order`);
  }

  const summary = `[verify-streaming] ${passes} pass / ${fails} fail`;
  process.stdout.write(`${summary}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[verify-streaming] unhandled: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});

// [PART 4 COMPLETE]
