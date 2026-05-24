/**
 * Single TS-side source of truth for the Postgres schema Agent Core's
 * objects live in. The migrations hardcode the same name in SQL.
 */
export const AGENT_CORE_SCHEMA = "agent_core" as const;
