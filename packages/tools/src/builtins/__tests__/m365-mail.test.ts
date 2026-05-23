import { describe, expect, test } from "bun:test";
import { m365Mail } from "../m365-mail";

process.env.SUPABASE_URL = "http://127.0.0.1:1/";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";

const ctx = { tenantId: "00000000-0000-0000-0000-000000000001" };

describe("m365_mail validation", () => {
  test("rejects unknown action", () => {
    expect(m365Mail.run({ action: "delete" } as never, ctx)).rejects.toThrow(
      /'list' or 'send'/
    );
  });

  test("rejects missing ctx.tenantId", () => {
    expect(
      m365Mail.run({ action: "list" } as never, { tenantId: "" } as never)
    ).rejects.toThrow(/tenantId is required/);
  });

  test("send: rejects invalid 'to' address", () => {
    expect(
      m365Mail.run(
        {
          action: "send",
          to: "not-an-email",
          subject: "hi",
          body: "hello",
        } as never,
        ctx
      )
    ).rejects.toThrow(/invalid 'to' address/);
  });

  test("send: rejects missing subject", () => {
    expect(
      m365Mail.run(
        { action: "send", to: "a@b.co", subject: "", body: "x" } as never,
        ctx
      )
    ).rejects.toThrow(/subject is required/);
  });

  test("send: rejects missing body", () => {
    expect(
      m365Mail.run(
        { action: "send", to: "a@b.co", subject: "s", body: "" } as never,
        ctx
      )
    ).rejects.toThrow(/body is required/);
  });

  test("send: rejects oversized body", () => {
    const big = "x".repeat(100_001);
    expect(
      m365Mail.run(
        { action: "send", to: "a@b.co", subject: "s", body: big } as never,
        ctx
      )
    ).rejects.toThrow(/exceeds 100000 chars/);
  });
});
