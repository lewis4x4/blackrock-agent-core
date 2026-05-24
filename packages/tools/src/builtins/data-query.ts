// SPRINT 2: server-only. Imports the service-role Supabase client.
// Never bundle into a browser/UI build.
import { createClient } from "@supabase/supabase-js";
import type { Tool } from "../registry";
import { AGENT_CORE_SCHEMA } from "../constants";

/**
 * Cross-runtime env reader (matches runtime/src/context.ts).
 */
function readEnv(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  return g.Deno?.env.get(name) ?? g.process?.env?.[name];
}

type Scalar = string | number | boolean;

interface DataQueryInput {
  table: string;
  filters?: Record<string, Scalar>;
  columns?: string[];
  limit?: number;
}

interface DataQueryOutput {
  table: string;
  rows: Record<string, unknown>[];
  count: number;
}

// SECURITY: this tool uses the service-role key, which bypasses RLS. The
// only tenant boundary enforced here is the `tenant_id = ctx.tenantId`
// filter injected below. Every table in TABLE_COLUMNS must have a
// NOT NULL `tenant_id` column.
//
// Per-table column allowlist. Anything not in the set is rejected before a
// round-trip to the database, for BOTH `columns` and `filters`. Sensitive
// jsonb columns like `agent_messages.content` and `agent_runs.task_graph`
// are deliberately excluded — raw user/assistant content excluded by default;
// access requires a separate, audited tool.
const TABLE_COLUMNS: Record<string, ReadonlySet<string>> = {
  agent_runs: new Set([
    "id", "tenant_id", "user_id", "status",
    "model_provider", "tokens_in", "tokens_out",
    "cost_estimate", "created_at",
  ]),
  agent_messages: new Set([
    "id", "run_id", "tenant_id", "role", "created_at",
  ]),
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const QUERY_TIMEOUT_MS = 30_000;

// Column identifier guard. Strict enough that we can safely interpolate into
// PostgREST .select() and .eq() calls without enabling SQL injection.
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// any: Supabase's generated DB types are not available here; the "agent_core"
// string literal still narrows the schema target. The row shape is loose.
let cachedClient: ReturnType<typeof createClient<any, "agent_core">> | null = null;
function getSupabase() {
  if (cachedClient) return cachedClient;
  const supabaseUrl = readEnv("SUPABASE_URL");
  const supabaseServiceKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "data_query: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
    );
  }
  cachedClient = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
    db: { schema: AGENT_CORE_SCHEMA },
  });
  return cachedClient;
}

/**
 * Built-in: read-only, tenant-scoped data query against the project's Supabase
 * database. The tool never accepts arbitrary SQL — only (table, filters, columns,
 * limit) tuples, where `table` must be in `TABLE_COLUMNS` and every column
 * identifier passes the IDENT guard AND is in the per-table allowlist.
 *
 * `tenant_id = ctx.tenantId` is enforced server-side on every call.
 */
export const dataQuery: Tool = {
  key: "data_query",
  description:
    "Read-only query against tenant-scoped tables. Input: { table, filters?, columns?, limit? }. Returns { rows, table, count }.",
  async run(rawInput, ctx) {
    const input = rawInput as unknown as DataQueryInput;
    const table = String(input?.table ?? "");
    if (!table) throw new Error("data_query requires a table name");
    const allowedColumns = TABLE_COLUMNS[table];
    if (!allowedColumns) {
      throw new Error(
        `data_query: table '${table}' is not in the allowlist`
      );
    }

    const requestedLimit = Number.isFinite(input?.limit)
      ? Number(input.limit)
      : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit)));

    const columns = Array.isArray(input?.columns) ? input.columns : null;
    if (columns) {
      for (const c of columns) {
        if (typeof c !== "string" || !IDENT.test(c)) {
          throw new Error(`data_query: invalid column identifier '${c}'`);
        }
        if (!allowedColumns.has(c)) {
          throw new Error(
            `data_query: column '${c}' is not allowed on table '${table}'`
          );
        }
      }
    }
    const selectExpr =
      columns && columns.length > 0
        ? columns.join(",")
        : [...allowedColumns].join(",");

    const tenantId = String(ctx?.tenantId ?? "");
    if (!tenantId) {
      throw new Error("data_query: ctx.tenantId is required");
    }

    const supabase = getSupabase();

    let query = supabase
      .from(table)
      .select(selectExpr)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
      .eq("tenant_id", tenantId)
      .limit(limit);

    const filters = input?.filters ?? {};
    for (const [key, value] of Object.entries(filters)) {
      if (!IDENT.test(key)) {
        throw new Error(`data_query: invalid filter column '${key}'`);
      }
      if (key === "tenant_id") {
        throw new Error(
          "data_query: caller may not specify a 'tenant_id' filter; it is injected from ctx"
        );
      }
      if (!allowedColumns.has(key)) {
        throw new Error(
          `data_query: filter '${key}' is not allowed on table '${table}'`
        );
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `data_query: filter '${key}' must be string|number|boolean`
        );
      }
      query = query.eq(key, value);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`data_query: ${error.message}`);
    }

    // PostgREST's typed select returns a union including GenericStringError
    // when the column list is dynamic; widen through `unknown` deliberately.
    const rows = ((data ?? []) as unknown) as Record<string, unknown>[];
    const output: DataQueryOutput = { table, rows, count: rows.length };
    return output;
  },
};
