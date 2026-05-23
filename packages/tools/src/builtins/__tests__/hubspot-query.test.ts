import { describe, expect, test } from "bun:test";
import { hubspotQuery } from "../hubspot-query";

// Set bogus env so if validation passes unexpectedly, the test surfaces a
// connection error instead of trying real network. All tests below should
// short-circuit on input validation before any DB/HTTP round-trip.
process.env.SUPABASE_URL = "http://127.0.0.1:1/";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";

const ctx = { tenantId: "00000000-0000-0000-0000-000000000001" };

describe("hubspot_query validation", () => {
  test("rejects missing resource", () => {
    expect(hubspotQuery.run({} as never, ctx)).rejects.toThrow(
      /resource is required/
    );
  });

  test("rejects resource not in the allowlist", () => {
    expect(
      hubspotQuery.run({ resource: "secrets" } as never, ctx)
    ).rejects.toThrow(/not allowed/);
  });

  test("rejects missing ctx.tenantId", () => {
    expect(
      hubspotQuery.run({ resource: "contacts" } as never, {
        tenantId: "",
      } as never)
    ).rejects.toThrow(/tenantId is required/);
  });

  test("rejects invalid property identifier", () => {
    expect(
      hubspotQuery.run(
        { resource: "contacts", properties: ["email; DROP"] } as never,
        ctx
      )
    ).rejects.toThrow(/invalid property/);
  });

  test("rejects invalid filter key", () => {
    expect(
      hubspotQuery.run(
        { resource: "contacts", filters: { "bad key": "x" } } as never,
        ctx
      )
    ).rejects.toThrow(/invalid filter/);
  });

  test("rejects non-scalar filter value", () => {
    expect(
      hubspotQuery.run(
        { resource: "contacts", filters: { email: { x: 1 } } } as never,
        ctx
      )
    ).rejects.toThrow(/string\|number\|boolean/);
  });
});
