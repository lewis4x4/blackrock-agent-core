// Verifies the OAuth / connected-integrations surface added in Sprint 4:
//   1. PKCE: generatePkcePair yields a 43-char base64url verifier and a
//      base64url challenge that equals base64url(SHA-256(verifier)).
//   2. State nonces are 43-char base64url strings and unique across calls.
//   3. buildAuthorizeUrl emits the right query string for hubspot and m365:
//      response_type=code, S256, state, code_challenge, redirect_uri, scope,
//      plus m365's response_mode=query.
//   4. Token-exchange parser maps Idp JSON to TokenResponse correctly
//      (access/refresh/expires_at/scopes/token_type), and refuses payloads
//      without access_token.
//   5. If a live Supabase is reachable (SUPABASE_URL +
//      SUPABASE_SERVICE_ROLE_KEY), the three connection RPCs exist and the
//      anon role cannot call them. Otherwise prints PARKED.
//
// Output mirrors verify-isolation.ts so CI greps work uniformly.

import { createClient } from '@supabase/supabase-js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkcePair,
  generateState,
} from '@blackrock-ai/agent-runtime';

const AGENT_CORE_SCHEMA = 'agent_core';

let passes = 0;
let fails = 0;
let parked = false;

function ok(invariant: number, detail: string): void {
  process.stdout.write(`[ok] invariant ${invariant} — ${detail}\n`);
  passes += 1;
}

function fail(invariant: number, detail: string): void {
  process.stdout.write(`[fail] invariant ${invariant} — ${detail}\n`);
  fails += 1;
}

function park(reason: string): void {
  parked = true;
  process.stdout.write(`[parked] live Supabase checks skipped — ${reason}\n`);
}

async function sha256Base64Url(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function checkPkceAndState(): Promise<void> {
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeVerifier)) {
    fail(1, `verifier shape wrong: ${codeVerifier}`);
  } else {
    ok(1, `verifier is 43-char base64url`);
  }
  const expected = await sha256Base64Url(codeVerifier);
  if (codeChallenge !== expected) {
    fail(1, `challenge != base64url(SHA-256(verifier))`);
  } else {
    ok(1, `challenge equals base64url(SHA-256(verifier))`);
  }

  const a = generateState();
  const b = generateState();
  if (!/^[A-Za-z0-9_-]{43}$/.test(a)) {
    fail(2, `state shape wrong: ${a}`);
  } else if (a === b) {
    fail(2, `two state nonces collided`);
  } else {
    ok(2, `state nonces look unique`);
  }
}

function checkAuthorizeUrl(): void {
  const baseInput = {
    clientId: 'client_abc',
    redirectUri: 'https://app.test/oauth/callback',
    state: 'state_xyz',
    codeChallenge: 'challenge_xyz',
  };

  for (const provider of ['hubspot', 'm365'] as const) {
    const url = buildAuthorizeUrl({ provider, ...baseInput });
    const parsed = new URL(url);
    const required: Record<string, string | RegExp> = {
      client_id: 'client_abc',
      redirect_uri: 'https://app.test/oauth/callback',
      response_type: 'code',
      state: 'state_xyz',
      code_challenge: 'challenge_xyz',
      code_challenge_method: 'S256',
    };
    let provOk = true;
    for (const [k, want] of Object.entries(required)) {
      const got = parsed.searchParams.get(k);
      const matches =
        typeof want === 'string' ? got === want : got !== null && want.test(got);
      if (!matches) {
        fail(3, `${provider}: ${k}=${got ?? '(missing)'} want=${want.toString()}`);
        provOk = false;
      }
    }
    const scope = parsed.searchParams.get('scope') ?? '';
    if (scope.length === 0) {
      fail(3, `${provider}: empty scope`);
      provOk = false;
    }
    if (provider === 'm365' && parsed.searchParams.get('response_mode') !== 'query') {
      fail(3, `m365: response_mode is not 'query'`);
      provOk = false;
    }
    if (provOk) ok(3, `${provider}: authorize URL has every required param`);
  }
}

async function checkTokenExchangeParse(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'at_1',
          refresh_token: 'rt_1',
          expires_in: 3600,
          scope: 'Mail.Read Mail.Send',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const tokens = await exchangeCode({
      provider: 'm365',
      code: 'the-code',
      codeVerifier: 'verifier',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'https://app.test/cb',
    });
    if (tokens.accessToken !== 'at_1') {
      fail(4, `accessToken parsed as ${tokens.accessToken}`);
    } else if (tokens.refreshToken !== 'rt_1') {
      fail(4, `refreshToken parsed as ${tokens.refreshToken}`);
    } else if (!tokens.expiresAt) {
      fail(4, `expiresAt unset on expires_in=3600`);
    } else if (tokens.tokenType !== 'Bearer') {
      fail(4, `tokenType parsed as ${tokens.tokenType}`);
    } else if (tokens.scopes.length !== 2) {
      fail(4, `scopes parsed as ${JSON.stringify(tokens.scopes)}`);
    } else {
      ok(4, `token JSON → TokenResponse maps correctly`);
    }

    // Refuses missing access_token.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ refresh_token: 'rt' }), { status: 200 })) as
      unknown as typeof fetch;
    let threw = false;
    try {
      await exchangeCode({
        provider: 'hubspot',
        code: 'x',
        codeVerifier: 'v',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://app.test/cb',
      });
    } catch (err: unknown) {
      threw = /missing access_token/.test(
        err instanceof Error ? err.message : String(err),
      );
    }
    if (threw) {
      ok(4, `parser throws when access_token is absent`);
    } else {
      fail(4, `parser accepted payload with no access_token`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function checkLiveSupabase(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceKey) {
    park('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return;
  }
  // any: Supabase's generated DB types are not available in scripts; the
  // "agent_core" string literal still narrows the .schema() surface.
  const svc: ReturnType<typeof createClient<any, "agent_core">> = createClient(url, serviceKey, {
    auth: { persistSession: false },
    db: { schema: AGENT_CORE_SCHEMA },
  });

  // Service role: every RPC must exist (we invoke with bogus arguments and
  // expect the call to reach the function, then fail on a domain error rather
  // than HTTP 404 / "function does not exist").
  const rpcs = ['store_tenant_connection', 'resolve_tenant_connection', 'update_tenant_connection_tokens'];
  for (const fn of rpcs) {
    const { error } = await svc.rpc(fn, {});
    if (!error) {
      ok(5, `${fn}: callable as service_role (no arg error returned)`);
      continue;
    }
    if (/does not exist|could not find/i.test(error.message)) {
      fail(5, `${fn}: missing — ${error.message}`);
    } else {
      ok(5, `${fn}: callable as service_role (rejected with ${truncate(error.message, 60)})`);
    }
  }

  if (anonKey) {
    // any: Supabase's generated DB type is unavailable in scripts; the
    // "agent_core" string literal still narrows the .schema('agent_core')
    // surface but the row shape is intentionally loose.
    const anon: ReturnType<typeof createClient<any, "agent_core">> = createClient(url, anonKey, {
      auth: { persistSession: false },
      db: { schema: AGENT_CORE_SCHEMA },
    });
    const { error } = await anon.rpc('resolve_tenant_connection', {
      p_tenant: '00000000-0000-0000-0000-000000000000',
      p_provider: 'hubspot',
    });
    if (error) {
      ok(5, `anon role refused: ${truncate(error.message, 60)}`);
    } else {
      fail(5, `anon role unexpectedly succeeded`);
    }
  } else {
    park('SUPABASE_ANON_KEY not set — skipping anon-role denial check');
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function main(): Promise<void> {
  process.stdout.write('[verify-connections] start\n');
  await checkPkceAndState();
  checkAuthorizeUrl();
  await checkTokenExchangeParse();
  await checkLiveSupabase();
  const tail = parked ? ' (live checks parked)' : '';
  process.stdout.write(
    `[verify-connections] ${passes} pass / ${fails} fail${tail}\n`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[verify-connections] unhandled: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});

// [PART 5 COMPLETE]
