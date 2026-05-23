import { test, expect, describe } from "bun:test";

// Bogus env so that if validation unexpectedly passes, the test fails loudly
// rather than hitting a real Supabase endpoint.
process.env.SUPABASE_URL = "http://127.0.0.1:1/";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";

import { dataQuery } from "../data-query";

const ctx = { tenantId: "00000000-0000-0000-0000-000000000001" };

function run(input: Record<string, unknown>, c: { tenantId: string } = ctx) {
  return dataQuery.run(input, c);
}

describe("data_query — input validation (no network)", () => {
  test("throws when table is missing/empty", async () => {
    await expect(run({})).rejects.toThrow();
    await expect(run({ table: "" })).rejects.toThrow();
  });

  test("throws when table is not in the allowlist", async () => {
    await expect(run({ table: "tenants" })).rejects.toThrow(
      /not in the allowlist/
    );
  });

  test("throws when ctx.tenantId is empty", async () => {
    await expect(
      run({ table: "agent_runs" }, { tenantId: "" })
    ).rejects.toThrow();
  });

  test("throws when columns contains an invalid identifier", async () => {
    await expect(
      run({ table: "agent_runs", columns: ["id; DROP"] })
    ).rejects.toThrow();
  });

  test("throws when columns contains an identifier not allowed on the table", async () => {
    // 'content' is a valid SQL identifier but should not be in the
    // agent_messages column allowlist (post-fix).
    await expect(
      run({ table: "agent_messages", columns: ["content"] })
    ).rejects.toThrow(/not allowed on table/);
  });

  test("throws when filters contains an invalid identifier key", async () => {
    await expect(
      run({
        table: "agent_runs",
        filters: { "bad-key": "x" } as unknown as Record<string, string>,
      })
    ).rejects.toThrow();
  });

  test("throws when filters contains a column not in the allowlist", async () => {
    await expect(
      run({
        table: "agent_runs",
        filters: { task_graph: "x" } as Record<string, string>,
      })
    ).rejects.toThrow();
  });

  test("throws when a caller provides a tenant_id filter", async () => {
    await expect(
      run({
        table: "agent_runs",
        filters: { tenant_id: "deadbeef" } as Record<string, string>,
      })
    ).rejects.toThrow();
  });

  test("throws when filter value is an object/array", async () => {
    await expect(
      run({
        table: "agent_runs",
        filters: { id: { nested: true } } as unknown as Record<string, string>,
      })
    ).rejects.toThrow();
    await expect(
      run({
        table: "agent_runs",
        filters: { id: [1, 2] } as unknown as Record<string, string>,
      })
    ).rejects.toThrow();
  });
});
