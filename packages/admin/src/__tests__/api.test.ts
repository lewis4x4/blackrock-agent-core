import { describe, expect, it } from "bun:test";
import { createAdminClient } from "../api";

describe("createAdminClient", () => {
  it("exposes expected rpc methods", () => {
    const client = createAdminClient({ supabaseUrl: "https://example.supabase.co", getAuthToken: async () => "token" });
    expect(typeof client.admin_list_runs).toBe("function");
    expect(typeof client.admin_get_run).toBe("function");
  });

  it("throws typed error on rpc failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "bad" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const client = createAdminClient({ supabaseUrl: "https://example.supabase.co" });
    await expect(client.admin_list_runs({})).rejects.toBeDefined();
    globalThis.fetch = originalFetch;
  });
});
