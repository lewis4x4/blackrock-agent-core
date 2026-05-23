import type { Tool } from "../registry";

type Scalar = string | number | boolean;

interface DocGenerateInput {
  template: string;
  variables?: Record<string, Scalar>;
  format?: "markdown" | "text";
}

interface DocGenerateOutput {
  content: string;
  format: "markdown" | "text";
  missingVariables: string[];
}

// {{ name }} — alphanumeric / underscore, optional whitespace either side.
const PLACEHOLDER = /\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g;

const MAX_TEMPLATE_BYTES = 200_000;

/**
 * Built-in: render a markdown/text template with {{variable}} substitution.
 * Pure function — no network, no filesystem. Useful for synthesizing structured
 * reports, emails, or doc bodies inside an agent run.
 *
 * Missing variables are reported (not thrown) so callers can decide whether to
 * fail or retry with more context.
 */
export const docGenerate: Tool = {
  key: "doc_generate",
  description:
    "Render a markdown/text template with {{var}} substitution. Input: { template, variables?, format? }. Returns { content, format, missingVariables }.",
  async run(rawInput) {
    const input = rawInput as unknown as DocGenerateInput;
    const template = String(input?.template ?? "");
    if (!template) throw new Error("doc_generate requires a template string");
    if (template.length > MAX_TEMPLATE_BYTES) {
      throw new Error(
        `doc_generate: template exceeds ${MAX_TEMPLATE_BYTES} chars`
      );
    }

    const format: "markdown" | "text" = input?.format === "text" ? "text" : "markdown";
    const variables = (input?.variables ?? {}) as Record<string, Scalar>;

    const missing = new Set<string>();
    const content = template.replace(PLACEHOLDER, (_match, name: string) => {
      if (Object.prototype.hasOwnProperty.call(variables, name)) {
        const v = variables[name];
        if (v === undefined || v === null) {
          missing.add(name);
          return "";
        }
        return String(v);
      }
      missing.add(name);
      return "";
    });

    const output: DocGenerateOutput = {
      content,
      format,
      missingVariables: [...missing],
    };
    return output;
  },
};
