import { test, expect, describe } from "bun:test";
import { docGenerate } from "../doc-generate";

const ctx = { tenantId: "00000000-0000-0000-0000-000000000001" };

interface DocGenerateOutput {
  content: string;
  format: "markdown" | "text";
  missingVariables: string[];
}

async function run(input: Record<string, unknown>): Promise<DocGenerateOutput> {
  return (await docGenerate.run(input, ctx)) as DocGenerateOutput;
}

describe("doc_generate", () => {
  test("renders a simple template with provided variables", async () => {
    const out = await run({
      template: "Hello {{name}}",
      variables: { name: "Brian" },
    });
    expect(out.content).toBe("Hello Brian");
    expect(out.missingVariables).toEqual([]);
    expect(out.format).toBe("markdown");
  });

  test("reports missing variables without throwing", async () => {
    const out = await run({
      template: "Hi {{a}} and {{b}}",
      variables: { a: "x" },
    });
    expect(out.content).toBe("Hi x and ");
    const bOccurrences = out.missingVariables.filter((v) => v === "b").length;
    expect(bOccurrences).toBe(1);
    expect(out.missingVariables).toContain("b");
  });

  test("treats null/undefined variable values as missing", async () => {
    const outNull = await run({
      template: "Hi {{a}}",
      variables: { a: null as unknown as string },
    });
    expect(outNull.missingVariables).toContain("a");

    const outUndef = await run({
      template: "Hi {{a}}",
      variables: { a: undefined as unknown as string },
    });
    expect(outUndef.missingVariables).toContain("a");
  });

  test("honors format: 'text'", async () => {
    const out = await run({
      template: "plain {{x}}",
      variables: { x: "value" },
      format: "text",
    });
    expect(out.format).toBe("text");
    expect(out.content).toBe("plain value");
  });

  test("throws when template is empty", async () => {
    await expect(run({ template: "" })).rejects.toThrow();
  });

  test("throws when template exceeds 200_000 chars", async () => {
    const huge = "a".repeat(200_001);
    await expect(run({ template: huge })).rejects.toThrow();
  });

  test("placeholder regex rejects dotted identifiers", async () => {
    const out = await run({
      template: "{{user.email}}",
      variables: { "user.email": "brian@example.com" },
    });
    // Dot is rejected by the post-fix regex — the placeholder is not matched
    // at all, so the literal text remains and nothing is reported as missing.
    expect(out.content).toBe("{{user.email}}");
    expect(out.missingVariables).not.toContain("user.email");
    expect(out.missingVariables).not.toContain("user");
  });
});
