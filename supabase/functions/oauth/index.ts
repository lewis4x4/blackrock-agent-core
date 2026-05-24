// Supabase Edge Function — OAuth start + callback for connected integrations.
//
// Routes (single function, action selected by query param):
//   GET ?action=start    &tenant_id=<uuid>&provider=hubspot|m365[&account_label=<text>]
//     → stores state + PKCE verifier in oauth_states, redirects (302) to IdP.
//
//   GET ?action=callback &state=<text>&code=<text>
//     → validates state, exchanges code, stores tokens in Vault via the
//       store_tenant_connection RPC, returns an HTML success page.
//
// Required env (per provider):
//   HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET
//   M365_CLIENT_ID,    M365_CLIENT_SECRET
//   OAUTH_REDIRECT_URI            — the public URL of THIS function's callback
//   SUPABASE_URL                  — for the service_role admin client
//   SUPABASE_SERVICE_ROLE_KEY     — to call SECURITY DEFINER RPCs
//
// Error sanitization: raw errors are console.error'd; the user only sees a
// generic message. IdP error bodies can include client_secret echoes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkcePair,
  generateState,
  getProviderConfig,
  type OauthProviderId,
} from "../../../packages/runtime/src/oauth.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

// mirrors packages/runtime/src/constants.ts
const AGENT_CORE_SCHEMA = "agent_core";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, OPTIONS",
};

const SUPPORTED: ReadonlySet<OauthProviderId> = new Set<OauthProviderId>([
  "hubspot",
  "m365",
]);

// account_label is interpolated into Vault secret names by the
// store_tenant_connection RPC; bound it to a safe set so a hostile caller
// can't smuggle control characters or path-style separators into the name.
const ACCOUNT_LABEL = /^[a-zA-Z0-9_.-]{1,64}$/;

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("oauth: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: AGENT_CORE_SCHEMA },
  });
}

interface ProviderEnv {
  clientId: string;
  clientSecret: string;
}

function getProviderEnv(provider: OauthProviderId): ProviderEnv {
  const upper = provider.toUpperCase();
  const clientId = Deno.env.get(`${upper}_CLIENT_ID`);
  const clientSecret = Deno.env.get(`${upper}_CLIENT_SECRET`);
  if (!clientId || !clientSecret) {
    throw new Error(`oauth: ${upper}_CLIENT_ID and ${upper}_CLIENT_SECRET must be set`);
  }
  return { clientId, clientSecret };
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS, "content-type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function handleStart(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant_id") ?? "";
  const providerRaw = url.searchParams.get("provider") ?? "";
  const accountLabel = url.searchParams.get("account_label") ?? "default";

  if (!tenantId) return jsonResponse({ error: "tenant_id required" }, 400);
  if (!SUPPORTED.has(providerRaw as OauthProviderId)) {
    return jsonResponse({ error: "unsupported provider" }, 400);
  }
  if (!ACCOUNT_LABEL.test(accountLabel)) {
    return jsonResponse({ error: "invalid account_label" }, 400);
  }
  const provider = providerRaw as OauthProviderId;

  const { clientId } = getProviderEnv(provider);
  const redirectUri = Deno.env.get("OAUTH_REDIRECT_URI");
  if (!redirectUri) {
    return jsonResponse({ error: "OAUTH_REDIRECT_URI must be set" }, 500);
  }

  const state = generateState();
  const { codeVerifier, codeChallenge } = await generatePkcePair();

  const supabase = getSupabase();
  const { error: insertErr } = await supabase
    .from("oauth_states")
    .insert({
      state,
      tenant_id: tenantId,
      provider,
      account_label: accountLabel,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
  if (insertErr) {
    console.error("oauth start: failed to persist state:", insertErr);
    return jsonResponse({ error: "internal error" }, 500);
  }

  const authorizeUrl = buildAuthorizeUrl({
    provider,
    clientId,
    redirectUri,
    state,
    codeChallenge,
    scopes: getProviderConfig(provider).defaultScopes,
  });

  return new Response(null, {
    status: 302,
    headers: { ...CORS, location: authorizeUrl },
  });
}

async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const errorParam = url.searchParams.get("error") ?? "";

  if (errorParam) {
    // IdP returned an error inline (user denied, scope rejected, etc.).
    console.error("oauth callback: IdP returned error:", errorParam);
    return html(renderError("authorization was declined"), 400);
  }
  if (!state || !code) {
    return html(renderError("missing state or code"), 400);
  }

  const supabase = getSupabase();

  // Pop the state row atomically by deleting it on lookup. If anyone replays
  // the callback URL the second attempt will see no row and fail.
  const { data: stateRows, error: stateErr } = await supabase
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .select("tenant_id, provider, account_label, code_verifier, redirect_uri, expires_at")
    .limit(1);

  if (stateErr) {
    console.error("oauth callback: state lookup failed:", stateErr);
    return html(renderError("internal error"), 500);
  }
  const row = stateRows?.[0];
  if (!row) {
    return html(renderError("invalid or expired state"), 400);
  }
  if (new Date(row.expires_at as string).getTime() < Date.now()) {
    return html(renderError("state has expired — please try again"), 400);
  }
  if (!SUPPORTED.has(row.provider as OauthProviderId)) {
    return html(renderError("invalid provider in state"), 400);
  }

  const provider = row.provider as OauthProviderId;
  const { clientId, clientSecret } = getProviderEnv(provider);

  let tokens;
  try {
    tokens = await exchangeCode({
      provider,
      code,
      codeVerifier: row.code_verifier as string,
      clientId,
      clientSecret,
      redirectUri: row.redirect_uri as string,
    });
  } catch (e) {
    console.error("oauth callback: token exchange failed:", e);
    return html(renderError("token exchange failed"), 502);
  }

  const { error: rpcErr } = await supabase.rpc("store_tenant_connection", {
    p_tenant: row.tenant_id,
    p_provider: provider,
    p_account_label: row.account_label,
    p_access_token: tokens.accessToken,
    p_refresh_token: tokens.refreshToken,
    p_scopes: tokens.scopes,
    p_expires_at: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
    p_meta: { token_type: tokens.tokenType, raw_scope: tokens.rawScope },
  });
  if (rpcErr) {
    console.error("oauth callback: store_tenant_connection failed:", rpcErr);
    return html(renderError("failed to persist connection"), 500);
  }

  return html(renderSuccess(provider, row.account_label as string), 200);
}

function renderSuccess(provider: string, accountLabel: string): string {
  // Minimal, escape-clean success page. No user input is interpolated.
  const safeProvider = provider.replace(/[^a-z0-9_-]/gi, "");
  const safeLabel = accountLabel.replace(/[^a-z0-9_.-]/gi, "");
  return [
    "<!doctype html><html><head><meta charset='utf-8'>",
    "<title>Connected</title></head><body style='font-family:system-ui;padding:2rem;'>",
    `<h1>Connected</h1>`,
    `<p>${safeProvider} (${safeLabel}) is now linked. You can close this window.</p>`,
    "<script>setTimeout(()=>window.close?.(),2500)</script>",
    "</body></html>",
  ].join("");
}

function renderError(message: string): string {
  const safe = message.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
  );
  return [
    "<!doctype html><html><head><meta charset='utf-8'>",
    "<title>Connection error</title></head><body style='font-family:system-ui;padding:2rem;'>",
    `<h1>Connection error</h1>`,
    `<p>${safe}</p>`,
    "</body></html>",
  ].join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return jsonResponse({ error: "GET only" }, 405);

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "start") return await handleStart(req);
    if (action === "callback") return await handleCallback(req);
    return jsonResponse({ error: "action must be 'start' or 'callback'" }, 400);
  } catch (e) {
    // Catch-all for anything we forgot. Log full error server-side; user sees
    // a generic message so client_secret echoes can't leak.
    console.error("oauth handler unhandled error:", e);
    return jsonResponse({ error: "internal error" }, 500);
  }
});

// [PART 3 COMPLETE]
