// SPRINT 4: server-only. Imports the service-role Supabase client.
// Shared connection-resolution helper for connected tools (hubspot_query,
// m365_mail, ...). Each tool calls `getConnectionAccessToken(ctx, provider)`
// to obtain a usable Bearer token; this helper handles the refresh dance
// transparently when the stored access token is expired.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function readEnv(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  return g.Deno?.env.get(name) ?? g.process?.env?.[name];
}

let cachedClient: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = readEnv("SUPABASE_URL");
  const key = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error(
      "connections: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
    );
  }
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export type ConnectedProvider = "hubspot" | "m365";

interface ProviderRefreshConfig {
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}

const PROVIDER_REFRESH: Record<ConnectedProvider, ProviderRefreshConfig> = {
  hubspot: {
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    clientIdEnv: "HUBSPOT_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
  },
  m365: {
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientIdEnv: "M365_CLIENT_ID",
    clientSecretEnv: "M365_CLIENT_SECRET",
  },
};

interface ResolvedConnection {
  connection_id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scopes: string[];
  status: string;
  meta: Record<string, unknown>;
}

// 60s slack so we refresh just before the IdP would reject the token.
const EXPIRY_SLACK_MS = 60_000;

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false; // unknown expiry → assume valid (provider didn't supply expires_in)
  return new Date(expiresAt).getTime() - Date.now() <= EXPIRY_SLACK_MS;
}

async function refreshTokens(
  connection: ResolvedConnection,
  provider: ConnectedProvider
): Promise<string> {
  if (!connection.refresh_token) {
    throw new Error(
      `${provider}: access token expired and no refresh token on file — reconnect via the oauth function`
    );
  }
  const cfg = PROVIDER_REFRESH[provider];
  const clientId = readEnv(cfg.clientIdEnv);
  const clientSecret = readEnv(cfg.clientSecretEnv);
  if (!clientId || !clientSecret) {
    throw new Error(
      `${provider}: ${cfg.clientIdEnv} and ${cfg.clientSecretEnv} must be set to refresh tokens`
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${provider}: refresh failed ${res.status}: ${text.slice(0, 400)}`
    );
  }
  const payload = (await res.json()) as Record<string, unknown>;
  const newAccess =
    typeof payload.access_token === "string" ? payload.access_token : "";
  if (!newAccess) {
    throw new Error(`${provider}: refresh response missing access_token`);
  }
  const newRefresh =
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : null;
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : null;
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  const supabase = getSupabase();
  const { error } = await supabase.rpc("update_tenant_connection_tokens", {
    p_connection_id: connection.connection_id,
    p_access_token: newAccess,
    p_refresh_token: newRefresh,
    p_expires_at: expiresAt,
  });
  if (error) {
    throw new Error(
      `${provider}: failed to persist refreshed tokens: ${error.message}`
    );
  }
  return newAccess;
}

/**
 * Returns a usable Bearer access token for (tenant, provider). Handles the
 * resolve → maybe-refresh → return path so callers can just `fetch(api, {
 * headers: { authorization: \`Bearer ${token}\` } })`.
 *
 * Throws if no connection exists, if the connection is revoked, or if the
 * refresh round-trip fails. Errors include the provider name but never the
 * token material itself.
 */
export async function getConnectionAccessToken(
  tenantId: string,
  provider: ConnectedProvider,
  accountLabel = "default"
): Promise<string> {
  if (!tenantId) throw new Error(`${provider}: ctx.tenantId is required`);
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("resolve_tenant_connection", {
    p_tenant: tenantId,
    p_provider: provider,
    p_account_label: accountLabel,
  });
  if (error) {
    throw new Error(
      `${provider}: resolve_tenant_connection failed: ${error.message}`
    );
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error(
      `${provider}: no connection on file for tenant — connect via the oauth function`
    );
  }
  const conn = row as ResolvedConnection;
  if (conn.status === "revoked") {
    throw new Error(`${provider}: connection has been revoked`);
  }
  if (!conn.access_token) {
    throw new Error(`${provider}: no access token on file`);
  }
  if (isExpired(conn.expires_at)) {
    return refreshTokens(conn, provider);
  }
  return conn.access_token;
}
