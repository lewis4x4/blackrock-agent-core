import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkcePair,
  generateState,
  getProviderConfig,
  refreshAccessToken,
} from "../oauth";

describe("getProviderConfig", () => {
  test("returns the hubspot config", () => {
    const cfg = getProviderConfig("hubspot");
    expect(cfg.id).toBe("hubspot");
    expect(cfg.authorizeUrl).toContain("hubspot.com");
    expect(cfg.tokenUrl).toContain("hubapi.com");
  });

  test("returns the m365 config", () => {
    const cfg = getProviderConfig("m365");
    expect(cfg.id).toBe("m365");
    expect(cfg.authorizeUrl).toContain("microsoftonline.com");
  });

  test("throws on unknown provider", () => {
    expect(() => getProviderConfig("nope")).toThrow(/unknown provider/);
  });
});

describe("generatePkcePair", () => {
  test("verifier is base64url with no padding", async () => {
    const { codeVerifier, codeChallenge } = await generatePkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes -> 43-char base64url (sans padding).
    expect(codeVerifier.length).toBe(43);
    expect(codeChallenge.length).toBe(43);
  });

  test("produces distinct pairs on subsequent calls", async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe("generateState", () => {
  test("is a base64url string of 43 chars", () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBe(43);
  });
});

describe("buildAuthorizeUrl", () => {
  const baseInput = {
    clientId: "client_abc",
    redirectUri: "https://app.test/oauth/callback",
    state: "state_xyz",
    codeChallenge: "challenge_123",
  };

  test("hubspot URL has PKCE params and default scopes", () => {
    const url = buildAuthorizeUrl({ provider: "hubspot", ...baseInput });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://app.hubspot.com/oauth/authorize"
    );
    expect(parsed.searchParams.get("client_id")).toBe("client_abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe(baseInput.redirectUri);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("state")).toBe("state_xyz");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge_123");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("scope")).toContain("crm.objects.contacts.read");
  });

  test("m365 URL includes response_mode=query", () => {
    const url = buildAuthorizeUrl({ provider: "m365", ...baseInput });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("response_mode")).toBe("query");
    expect(parsed.searchParams.get("scope")).toContain("offline_access");
  });

  test("uses caller-supplied scopes when present", () => {
    const url = buildAuthorizeUrl({
      provider: "hubspot",
      ...baseInput,
      scopes: ["custom.scope.a", "custom.scope.b"],
    });
    const scope = new URL(url).searchParams.get("scope");
    expect(scope).toBe("custom.scope.a custom.scope.b");
  });
});

describe("exchangeCode + refreshAccessToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("exchangeCode posts form-encoded body and parses tokens", async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")).toBe(
          "application/x-www-form-urlencoded"
        );
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("the-code");
        expect(body.get("code_verifier")).toBe("the-verifier");
        return new Response(
          JSON.stringify({
            access_token: "at_1",
            refresh_token: "rt_1",
            expires_in: 3600,
            scope: "Mail.Read Mail.Send",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tokens = await exchangeCode({
      provider: "m365",
      code: "the-code",
      codeVerifier: "the-verifier",
      clientId: "c",
      clientSecret: "s",
      redirectUri: "https://app.test/cb",
    });
    expect(tokens.accessToken).toBe("at_1");
    expect(tokens.refreshToken).toBe("rt_1");
    expect(tokens.scopes).toEqual(["Mail.Read", "Mail.Send"]);
    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.expiresAt).toBeInstanceOf(Date);
  });

  test("exchangeCode throws when IdP returns non-OK", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("invalid_grant", {
          status: 400,
          headers: { "content-type": "text/plain" },
        })
    ) as unknown as typeof fetch;

    expect(
      exchangeCode({
        provider: "hubspot",
        code: "bad",
        codeVerifier: "v",
        clientId: "c",
        clientSecret: "s",
        redirectUri: "https://app.test/cb",
      })
    ).rejects.toThrow(/400/);
  });

  test("exchangeCode throws when payload lacks access_token", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ refresh_token: "rt" }), { status: 200 })
    ) as unknown as typeof fetch;

    expect(
      exchangeCode({
        provider: "hubspot",
        code: "x",
        codeVerifier: "v",
        clientId: "c",
        clientSecret: "s",
        redirectUri: "https://app.test/cb",
      })
    ).rejects.toThrow(/missing access_token/);
  });

  test("refreshAccessToken supplies grant_type=refresh_token", async () => {
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("rt_in");
        return new Response(
          JSON.stringify({
            access_token: "at_new",
            refresh_token: "rt_new",
            expires_in: 1800,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    ) as unknown as typeof fetch;

    const t = await refreshAccessToken({
      provider: "hubspot",
      refreshToken: "rt_in",
      clientId: "c",
      clientSecret: "s",
    });
    expect(t.accessToken).toBe("at_new");
    expect(t.refreshToken).toBe("rt_new");
  });
});
