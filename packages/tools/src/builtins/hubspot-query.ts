// SPRINT 4: server-only. Calls into the tenant's HubSpot CRM using the
// OAuth access token stored in tenant_connections. Never bundle into a
// browser/UI build — service-role Supabase access required.

import type { Tool } from "../registry";
import { getConnectionAccessToken } from "./_connections";

type Scalar = string | number | boolean;

interface HubspotQueryInput {
  /** Which CRM object to query. */
  resource: string;
  /** Optional substring search routed to HubSpot's `/search` endpoint. */
  query?: string;
  /** Optional equality filters: `{ email: "x@y", lifecyclestage: "lead" }`. */
  filters?: Record<string, Scalar>;
  /** Specific properties to return. Empty → HubSpot's default property set. */
  properties?: string[];
  /** Up to MAX_LIMIT. */
  limit?: number;
}

interface HubspotQueryOutput {
  resource: string;
  results: Record<string, unknown>[];
  count: number;
}

// Allowlist of CRM objects the tool may query. Anything else is rejected
// before a round-trip. v1 ships the four most-used objects; widen by editing
// this set if a tenant needs more.
const ALLOWED_RESOURCES: ReadonlySet<string> = new Set([
  "contacts",
  "companies",
  "deals",
  "tickets",
]);

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

// Property identifier guard — HubSpot accepts lowercase + underscores +
// digits; we mirror that and add hyphen for compatibility with a handful of
// integration-defined props.
const PROPERTY = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Built-in: read HubSpot CRM objects via the tenant's OAuth connection.
 *
 * Uses the v3 search endpoint when `query` or `filters` are provided, falling
 * back to the list endpoint otherwise. All requests carry the tenant's
 * `Bearer` token, transparently refreshed if expired.
 */
export const hubspotQuery: Tool = {
  key: "hubspot_query",
  description:
    "Read tenant HubSpot CRM data. Input: { resource: 'contacts'|'companies'|'deals'|'tickets', query?, filters?, properties?, limit? }. Returns { results, count, resource }.",
  async run(rawInput, ctx) {
    const input = rawInput as unknown as HubspotQueryInput;
    const resource = String(input?.resource ?? "");
    if (!resource) throw new Error("hubspot_query: resource is required");
    if (!ALLOWED_RESOURCES.has(resource)) {
      throw new Error(`hubspot_query: resource '${resource}' is not allowed`);
    }

    const requestedLimit = Number.isFinite(input?.limit)
      ? Number(input.limit)
      : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit)));

    const properties = Array.isArray(input?.properties) ? input.properties : null;
    if (properties) {
      for (const p of properties) {
        if (typeof p !== "string" || !PROPERTY.test(p)) {
          throw new Error(`hubspot_query: invalid property '${p}'`);
        }
      }
    }

    const filters = input?.filters ?? {};
    for (const [k, v] of Object.entries(filters)) {
      if (!PROPERTY.test(k)) {
        throw new Error(`hubspot_query: invalid filter '${k}'`);
      }
      if (
        typeof v !== "string" &&
        typeof v !== "number" &&
        typeof v !== "boolean"
      ) {
        throw new Error(
          `hubspot_query: filter '${k}' must be string|number|boolean`
        );
      }
    }

    const tenantId = String(ctx?.tenantId ?? "");
    if (!tenantId) throw new Error("hubspot_query: ctx.tenantId is required");

    const accessToken = await getConnectionAccessToken(tenantId, "hubspot");

    const query = typeof input?.query === "string" ? input.query.trim() : "";
    const useSearch = query.length > 0 || Object.keys(filters).length > 0;

    const url = useSearch
      ? `https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(resource)}/search`
      : `https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(resource)}`;

    let res: Response;
    if (useSearch) {
      const filterGroups = Object.entries(filters).map(([k, v]) => ({
        filters: [{ propertyName: k, operator: "EQ", value: String(v) }],
      }));
      const body: Record<string, unknown> = {
        limit,
        ...(properties && properties.length > 0 ? { properties } : {}),
        ...(query ? { query } : {}),
        ...(filterGroups.length > 0 ? { filterGroups } : {}),
      };
      res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } else {
      const u = new URL(url);
      u.searchParams.set("limit", String(limit));
      if (properties && properties.length > 0) {
        u.searchParams.set("properties", properties.join(","));
      }
      res = await fetch(u, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`hubspot_query: ${res.status}: ${text.slice(0, 400)}`);
    }

    const payload = (await res.json()) as { results?: unknown };
    const rawResults = Array.isArray(payload?.results) ? payload.results : [];
    const results = rawResults.slice(0, limit) as Record<string, unknown>[];

    const output: HubspotQueryOutput = {
      resource,
      results,
      count: results.length,
    };
    return output;
  },
};

// [PART 4 — hubspot_query COMPLETE]
