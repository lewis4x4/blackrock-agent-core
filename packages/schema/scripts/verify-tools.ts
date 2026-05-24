// Verifies the built-in tool catalogue is structurally sound:
//   1. Every builtin has a non-empty `key` and `description`.
//   2. Keys are unique across the catalogue.
//   3. Each `run` is a callable function.
//   4. Connected tools (hubspot_query, m365_mail) reference the per-tenant
//      connection layer added in migration 0006 — i.e. they decline cleanly
//      when ctx.tenantId is missing, rather than swallowing the call.
//
// Pure offline checks — no live Supabase needed. Exits 0 on pass, 1 on
// any assertion failure. The output format mirrors verify-isolation.ts so
// CI scripts can grep for `[ok]` / `[fail]` lines uniformly.

import { builtins } from '@blackrock-ai/agent-tools';

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

async function main(): Promise<void> {
  process.stdout.write(
    `[verify-tools] checking ${builtins.length} built-in tool(s)\n`,
  );

  // 1 — every tool has a non-empty key + description.
  for (const tool of builtins) {
    if (!tool.key || tool.key.length === 0) {
      fail(1, `tool with description "${tool.description}" has empty key`);
    } else if (!tool.description || tool.description.length === 0) {
      fail(1, `tool ${tool.key} has empty description`);
    } else {
      ok(1, `${tool.key}: key + description present`);
    }
  }

  // 2 — keys are unique.
  const seen = new Set<string>();
  let duplicate = false;
  for (const tool of builtins) {
    if (seen.has(tool.key)) {
      fail(2, `duplicate key: ${tool.key}`);
      duplicate = true;
    }
    seen.add(tool.key);
  }
  if (!duplicate) ok(2, `all ${builtins.length} keys unique`);

  // 3 — every tool has a callable `run`.
  for (const tool of builtins) {
    if (typeof tool.run !== 'function') {
      fail(3, `${tool.key}: run is not a function`);
    } else {
      ok(3, `${tool.key}: run is callable`);
    }
  }

  // 4 — connected tools fail closed when ctx.tenantId is missing. Each tool
  // is given the MINIMAL valid input that gets past its other input guards so
  // the tenantId check is the next thing that fires.
  const connectedProbes: { key: string; input: Record<string, unknown> }[] = [
    { key: 'hubspot_query', input: { resource: 'contacts' } },
    { key: 'm365_mail', input: { action: 'list' } },
  ];
  for (const probe of connectedProbes) {
    const tool = builtins.find((t) => t.key === probe.key);
    if (!tool) {
      fail(4, `connected tool ${probe.key} not registered`);
      continue;
    }
    try {
      await tool.run(probe.input, { tenantId: '' });
      fail(4, `${probe.key}: accepted empty tenantId without throwing`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/tenantId|tenant_id|tenant is required/i.test(msg)) {
        ok(4, `${probe.key}: refused empty tenantId (${truncate(msg, 80)})`);
      } else {
        fail(4, `${probe.key}: unexpected error shape — ${msg}`);
      }
    }
  }

  const summary = `[verify-tools] ${passes} pass / ${fails} fail`;
  process.stdout.write(`${summary}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[verify-tools] unhandled: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});

// [PART 3 COMPLETE]
