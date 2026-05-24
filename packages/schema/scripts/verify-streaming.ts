// Verifies the SSE event schema in packages/runtime/src/events.ts AND the
// run-persistence layer that lands rows in agent_runs / agent_messages:
//   1. formatSse → parseSseFrame is a faithful round-trip across every
//      AgentEvent variant.
//   2. parseSseChunk recovers events even when a sequence of frames is
//      split mid-frame across chunk boundaries — the producer's stream
//      can deliver bytes however it likes.
//   3. parseSseFrame returns null (not throws) for empty / malformed input.
//   4. The client-side asynciterable in @blackrock-ai/agent-core (the shell
//      package) actually yields the events through its full read loop —
//      this exercises createAgentClient end-to-end against a stub SSE body.
//   5. Live-DB persistence: when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//      point at a database that has run the Agent Core migration sequence,
//      recordRunStart + recordMessage + recordToolResults + finalizeRun all
//      land their rows AND finalizeRun stamps completed_at / status. Parks
//      if env unset OR the schema isn't applied.
//
// Invariants 1-4 are pure offline. Invariant 5 is the run-persistence
// remediation's DB-side check.

import { randomUUID } from 'node:crypto';

import { createAgentClient } from '@blackrock-ai/agent-core';
import {
  finalizeRun,
  formatSse,
  parseSseChunk,
  parseSseFrame,
  recordMessage,
  recordRunStart,
  recordToolResults,
  type AgentEvent,
} from '@blackrock-ai/agent-runtime';
import { createClient } from '@supabase/supabase-js';

const AGENT_CORE_SCHEMA = 'agent_core';

let passes = 0;
let fails = 0;
let parked = false;

function ok(invariant: number, detail: string): void {
  process.stdout.write(`[ok] invariant ${invariant} — ${detail}\n`);
  passes += 1;
}

function park(reason: string): void {
  parked = true;
  process.stdout.write(`[parked] ${reason}\n`);
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
      usage: { tokensIn: 0, tokensOut: 0, cost: 0 },
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

  await checkLivePersistence();

  const tail = parked ? ' (some live checks parked)' : '';
  const summary = `[verify-streaming] ${passes} pass / ${fails} fail${tail}`;
  process.stdout.write(`${summary}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

async function checkLivePersistence(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    park('persistence checks — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return;
  }

  // any: Supabase's generated DB types are not available in scripts; the
  // "agent_core" string literal still narrows the .schema() surface.
  const supabase: ReturnType<typeof createClient<any, "agent_core">> = createClient(url, serviceKey, {
    auth: { persistSession: false },
    db: { schema: AGENT_CORE_SCHEMA },
  });

  // Confirm the migrations have landed — if `agent_runs` doesn't exist we
  // can't usefully assert anything about persistence.
  const { error: probeErr } = await supabase
    .from('agent_runs')
    .select('id')
    .limit(1);
  if (probeErr) {
    park(`persistence checks — agent_runs not queryable (${probeErr.message})`);
    return;
  }

  // Seed a disposable tenant. Cleaned up in finally — agent_runs cascades.
  const tenantId = randomUUID();
  const runId = randomUUID();
  const slug = `verify-streaming-${runId.slice(0, 8)}`;
  const { error: tenantErr } = await supabase
    .from('tenants')
    .insert({ id: tenantId, slug, display_name: 'verify-streaming' });
  if (tenantErr) {
    park(`persistence checks — could not seed tenant (${tenantErr.message})`);
    return;
  }

  try {
    // recordRunStart: agent_runs row + initial user message.
    const started = await recordRunStart({
      runId,
      tenantId,
      model: 'claude-sonnet-4-5',
      modelProvider: 'anthropic',
      userMessage: 'verify-streaming probe',
    });
    if (!started) {
      fail(5, 'recordRunStart returned false');
      return;
    }
    ok(5, 'recordRunStart wrote agent_runs + initial user message');

    // recordMessage: an assistant draft.
    const drafted = await recordMessage({
      runId,
      tenantId,
      role: 'assistant',
      content: { kind: 'draft_answer', text: 'probe answer' },
    });
    if (!drafted) fail(5, 'recordMessage(assistant draft) returned false');
    else ok(5, 'recordMessage appended an assistant row');

    // recordToolResults: one fake successful tool.
    const written = await recordToolResults(runId, tenantId, [
      {
        taskId: 't1',
        tool: 'web_search',
        ok: true,
        output: { results: [{ title: 'probe' }] },
      },
    ]);
    if (written !== 1) fail(5, `recordToolResults wrote ${written} rows, expected 1`);
    else ok(5, 'recordToolResults appended a tool row');

    // finalizeRun: terminal state, tokens stamped.
    const finalized = await finalizeRun({
      runId,
      tenantId,
      status: 'completed',
      usage: { tokensIn: 42, tokensOut: 24, cost: 0.0042 },
      taskGraph: { tasks: [] },
    });
    if (!finalized) {
      fail(5, 'finalizeRun returned false');
      return;
    }

    // Verify the row landed as expected.
    const { data: rows, error: runErr } = await supabase
      .from('agent_runs')
      .select('status,tokens_in,tokens_out,cost_estimate,completed_at')
      .eq('id', runId)
      .limit(1);
    if (runErr || !rows || rows.length === 0) {
      fail(5, `agent_runs read-back failed: ${runErr?.message ?? 'no rows'}`);
      return;
    }
    const r = rows[0] as {
      status: string;
      tokens_in: number;
      tokens_out: number;
      cost_estimate: number;
      completed_at: string | null;
    };
    if (
      r.status !== 'completed' ||
      r.tokens_in !== 42 ||
      r.tokens_out !== 24 ||
      !r.completed_at
    ) {
      fail(
        5,
        `agent_runs terminal state wrong: ${JSON.stringify(r)}`,
      );
    } else {
      ok(5, 'finalizeRun stamped status=completed + tokens + completed_at');
    }

    const { count: msgCount, error: msgErr } = await supabase
      .from('agent_messages')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', runId);
    if (msgErr) {
      fail(5, `agent_messages count failed: ${msgErr.message}`);
    } else if ((msgCount ?? 0) < 3) {
      fail(5, `expected at least 3 agent_messages rows, got ${msgCount ?? 0}`);
    } else {
      ok(5, `agent_messages has ${msgCount} rows for this run`);
    }
  } finally {
    // Cleanup — cascade from tenants takes care of runs and messages.
    await supabase.from('tenants').delete().eq('id', tenantId);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[verify-streaming] unhandled: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});

// [PART 4 COMPLETE]
