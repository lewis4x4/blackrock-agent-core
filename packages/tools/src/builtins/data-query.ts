// SPRINT 2: server-only. Imports the service-role Supabase client.
// Never bundle into a browser/UI build.
import { createClient } from "@supabase/supabase-js";
import type { Tool } from "../registry";

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

/**
 * Allowlist of tables this tool may query. Anything else is rejected before a
 * round-trip to the database. v1 ships the tenant-scoped audit tables; future
 * iterations can drive this from `tenant_tools.config` per tenant.
 *
 * Every table here MUST have a `tenant_id` column — `data_query` injects an
 * equality filter on `ctx.tenantId` for every request, so RLS isn't the only
 * line of defense.
 */
const ALLOWED_TABLES: ReadonlySet<string> = new Set([
  "agent_runs",
  "agent_messages",
]);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

// Column identifier guard. Strict enough that we can safely interpolate into
// PostgREST .select() and .eq() calls without enabling SQL injection.
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Built-in: read-only, tenant-scoped data query against the project's Supabase
 * database. The tool never accepts arbitrary SQL — only (table, filters, columns,
 * limit) tuples, where `table` must be in `ALLOWED_TABLES` and every column
 * identifier passes the IDENT guard.
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
    if (!ALLOWED_TABLES.has(table)) {
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
      }
    }
    const selectExpr = columns && columns.length > 0 ? columns.join(",") : "*";

    const tenantId = String(ctx?.tenantId ?? "");
    if (!tenantId) {
      throw new Error("data_query: ctx.tenantId is required");
    }

    const supabaseUrl = readEnv("SUPABASE_URL");
    const supabaseServiceKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error(
        "data_query: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
      );
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    let query = supabase
      .from(table)
      .select(selectExpr)
      .eq("tenant_id", tenantId)
      .limit(limit);

    const filters = input?.filters ?? {};
    for (const [key, value] of Object.entries(filters)) {
      if (!IDENT.test(key)) {
        throw new Error(`data_query: invalid filter column '${key}'`);
      }
      if (key === "tenant_id") {
        // Don't let the caller widen the tenant scope.
        continue;
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

// [PART 3 COMPLETE]
