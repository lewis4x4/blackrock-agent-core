/**
 * Single TS-side source of truth for the Postgres schema Agent Core's
 * objects live in. The migrations hardcode the same name in SQL.
 *
 * The schema package stays migrations-only and non-buildable — this
 * constant is the only TS shim.
 */
export const AGENT_CORE_SCHEMA = "agent_core" as const;
