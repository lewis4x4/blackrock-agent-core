import type { RunContext, TaskGraph, ToolResult } from "./types";

/**
 * Runs the task graph in dependency waves. Independent tasks in a wave
 * run in parallel. Unresolved dependencies fail their tasks without
 * blocking the rest.
 */
export async function execute(
  ctx: RunContext,
  graph: TaskGraph
): Promise<ToolResult[]> {
  const done = new Map<string, ToolResult>();
  const remaining = [...graph.tasks];

  while (remaining.length) {
    const ready = remaining.filter((t) =>
      (t.dependsOn ?? []).every((d) => done.has(d))
    );

    if (ready.length === 0) {
      for (const t of remaining) {
        done.set(t.id, {
          taskId: t.id,
          tool: t.tool,
          ok: false,
          output: null,
          error: "unresolved or cyclic dependency",
        });
      }
      break;
    }

    const wave = await Promise.all(
      ready.map(async (t): Promise<ToolResult> => {
        try {
          const output = await ctx.registry.run(t.tool, t.input, {
            tenantId: ctx.tenantId,
          });
          return { taskId: t.id, tool: t.tool, ok: true, output };
        } catch (e) {
          return {
            taskId: t.id,
            tool: t.tool,
            ok: false,
            output: null,
            error: String(e),
          };
        }
      })
    );

    for (const r of wave) done.set(r.taskId, r);
    for (const t of ready) remaining.splice(remaining.indexOf(t), 1);
  }

  return graph.tasks.map(
    (t) =>
      done.get(t.id) ?? {
        taskId: t.id,
        tool: t.tool,
        ok: false,
        output: null,
        error: "not executed",
      }
  );
}
