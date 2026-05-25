import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mergeClaims, verifyHookSignature, type AdminUserRow } from "./claims.ts";

type HookPayload = {
  user_id?: string;
  claims?: Record<string, unknown>;
  authentication_method?: string;
};

type HookResponse = {
  claims: Record<string, unknown>;
};

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const CORS_HEADERS = {
  "content-type": "application/json",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: "agent_core" },
  });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json(405, { error: "POST required" });
  }

  const secret = Deno.env.get("SUPABASE_AUTH_HOOK_SECRET") ?? "";
  const rawBody = await req.text();
  const sig = req.headers.get("x-supabase-signature");

  let signatureOk = false;
  try {
    signatureOk = await verifyHookSignature(secret, rawBody, sig);
  } catch {
    signatureOk = false;
  }

  if (!signatureOk) {
    return json(401, { error: "invalid signature" });
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(rawBody) as HookPayload;
  } catch {
    return json(400, { error: "invalid json" });
  }

  const baseClaims: Record<string, unknown> =
    payload.claims && typeof payload.claims === "object" ? payload.claims : {};

  const userId = payload.user_id;
  if (!userId) {
    return json(200, { claims: baseClaims } satisfies HookResponse);
  }

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("admin_users")
      .select("role, tenant_id")
      .eq("user_id", userId);

    if (error) {
      console.warn("auth-jwt admin lookup failed", error.message);
      return json(200, { claims: baseClaims } satisfies HookResponse);
    }

    const rows = (data ?? []) as AdminUserRow[];
    const claims = mergeClaims(baseClaims, rows);

    return json(200, { claims } satisfies HookResponse);
  } catch (err) {
    console.warn("auth-jwt fail-open", err);
    return json(200, { claims: baseClaims } satisfies HookResponse);
  }
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}

export { handleRequest, mergeClaims, verifyHookSignature };
