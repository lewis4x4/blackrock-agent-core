// Pure OAuth 2.0 authorization-code helpers. Provider configs + functions
// that build authorize URLs, exchange codes, and refresh access tokens. No
// database or HTTP-server specifics — the Edge Function in
// supabase/functions/oauth composes these into a full flow.
//
// Every connected provider that Sprint 4 ships (hubspot, m365) goes through
// PKCE. Adding a new provider is a config-only change here.

export type OauthProviderId = "hubspot" | "m365";

export interface OauthProviderConfig {
  id: OauthProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  /** Default scopes requested if the caller doesn't supply their own. */
  defaultScopes: string[];
  /** Some providers (m365) need a tenant or "common" segment in the URL. */
  authorizeUrlBuilder?: (base: string) => string;
}

export const OAUTH_PROVIDERS: Record<OauthProviderId, OauthProviderConfig> = {
  hubspot: {
    id: "hubspot",
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    defaultScopes: ["crm.objects.contacts.read", "crm.objects.deals.read"],
  },
  m365: {
    id: "m365",
    // 'common' lets users from any AAD tenant or personal MSA sign in. Override
    // in env (M365_TENANT) for tenant-specific apps.
    authorizeUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    defaultScopes: ["offline_access", "Mail.Read", "Mail.Send"],
  },
};

export function getProviderConfig(id: string): OauthProviderConfig {
  const cfg = OAUTH_PROVIDERS[id as OauthProviderId];
  if (!cfg) throw new Error(`oauth: unknown provider '${id}'`);
  return cfg;
}

/**
 * PKCE pair generation. `code_verifier` is a random URL-safe string (43-128
 * chars) and `code_challenge` is its base64url-encoded SHA-256.
 *
 * Uses WebCrypto, which is available on Deno, Bun, Node 16+, and modern
 * browsers. We never store the verifier in a cookie — it lives in
 * oauth_states alongside the state nonce.
 */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export async function generatePkcePair(): Promise<PkcePair> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64urlEncode(bytes);

  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(codeVerifier));
  const codeChallenge = base64urlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

/**
 * 32-byte cryptographically random `state` nonce, base64url encoded. The
 * Edge Function stores this in `oauth_states` keyed by itself, then matches
 * the value the IdP echoes back on the callback.
 */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export interface BuildAuthorizeUrlInput {
  provider: OauthProviderId;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}

/**
 * Compose the IdP's authorize URL. Always uses PKCE (`S256`) and requests
 * `response_type=code`. Scopes default to the provider's `defaultScopes`
 * unless overridden.
 */
export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const cfg = getProviderConfig(input.provider);
  const base = cfg.authorizeUrlBuilder
    ? cfg.authorizeUrlBuilder(cfg.authorizeUrl)
    : cfg.authorizeUrl;
  const url = new URL(base);
  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : cfg.defaultScopes;

  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // M365 wants response_mode=query so the code arrives on the callback's URL.
  if (input.provider === "m365") {
    url.searchParams.set("response_mode", "query");
  }
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry time. Null when the IdP doesn't supply expires_in. */
  expiresAt: Date | null;
  scopes: string[];
  rawScope: string;
  tokenType: string;
}

interface ExchangeCodeInput {
  provider: OauthProviderId;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Trade an authorization code for an access + refresh token at the IdP's
 * token endpoint. POST body is `application/x-www-form-urlencoded` (the
 * format every OAuth 2.0 server speaks).
 */
export async function exchangeCode(input: ExchangeCodeInput): Promise<TokenResponse> {
  const cfg = getProviderConfig(input.provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  return parseTokenResponse(res);
}

interface RefreshAccessTokenInput {
  provider: OauthProviderId;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

/**
 * Refresh an expired access token. Note: M365 rotates refresh tokens on
 * every refresh, so callers MUST update the stored refresh token from the
 * response. HubSpot keeps the same refresh token. The token response shape
 * is identical for both — `refreshToken` may simply equal the input value.
 */
export async function refreshAccessToken(input: RefreshAccessTokenInput): Promise<TokenResponse> {
  const cfg = getProviderConfig(input.provider);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  if (input.scopes && input.scopes.length > 0) {
    body.set("scope", input.scopes.join(" "));
  }
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  return parseTokenResponse(res);
}

async function parseTokenResponse(res: Response): Promise<TokenResponse> {
  if (!res.ok) {
    // Surface the IdP body verbatim into the thrown error — the Edge Function
    // logs the error server-side and returns a sanitized message to the user.
    const text = await safeReadText(res);
    throw new Error(`oauth token endpoint ${res.status}: ${text.slice(0, 600)}`);
  }
  const payload = (await res.json()) as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken) {
    throw new Error("oauth token endpoint: missing access_token");
  }
  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : null;
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : null;
  const expiresAt = expiresIn !== null ? new Date(Date.now() + expiresIn * 1000) : null;
  const rawScope = typeof payload.scope === "string" ? payload.scope : "";
  const scopes = rawScope ? rawScope.split(/\s+/).filter(Boolean) : [];
  const tokenType = typeof payload.token_type === "string" ? payload.token_type : "Bearer";

  return { accessToken, refreshToken, expiresAt, scopes, rawScope, tokenType };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Standard URL-safe base64 (RFC 7636 §A — no padding, `-`/`_` instead of
 * `+`/`/`). Used for both the PKCE verifier/challenge and the state nonce.
 */
function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa exists on Deno, Bun, Node 16+ and browsers.
  const b64 = (globalThis as { btoa?: (s: string) => string }).btoa?.(bin) ??
    Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// [PART 2 COMPLETE]
