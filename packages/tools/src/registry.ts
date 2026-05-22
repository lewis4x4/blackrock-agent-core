/** Passed to every tool at run time. Host may attach a DB client, etc. */
export interface ToolContext {
  tenantId: string;
  [key: string]: unknown;
}

/** A tool the orchestrator can dispatch to. Every "feature" is one of these. */
export interface Tool<I = Record<string, unknown>, O = unknown> {
  key: string;
  description: string;
  run(input: I, ctx: ToolContext): Promise<O>;
}

/**
 * The registry. The orchestrator is generic; the registry is what differs
 * per tenant — register only the tools that tenant has access to.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.key, tool);
    return this;
  }

  get(key: string): Tool | undefined {
    return this.tools.get(key);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async run(
    key: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<unknown> {
    const tool = this.tools.get(key);
    if (!tool) throw new Error(`unknown tool: ${key}`);
    return tool.run(input, ctx);
  }
}
