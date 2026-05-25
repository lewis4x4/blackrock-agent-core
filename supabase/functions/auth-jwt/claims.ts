export type AdminUserRow = {
  role: "superadmin" | "tenant_admin" | "tenant_viewer";
  tenant_id: string | null;
};

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) {
    throw new Error("invalid hex length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function verifyHookSignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!secret) return false;
  if (!signatureHeader) return false;

  const raw = signatureHeader.trim();
  const token = raw.includes("=") ? raw.split("=").slice(1).join("=") : raw;
  const expected = fromHex(token);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );

  return timingSafeEqual(expected, sig);
}

export function mergeClaims(
  originalClaims: Record<string, unknown>,
  rows: AdminUserRow[],
): Record<string, unknown> {
  const merged = { ...originalClaims };
  const appMetadata =
    typeof merged.app_metadata === "object" && merged.app_metadata !== null
      ? (merged.app_metadata as Record<string, unknown>)
      : {};

  const superadmin = rows.find((r) => r.role === "superadmin");
  if (superadmin) {
    merged.admin_role = "superadmin";
    delete merged.tenant_id;
    return merged;
  }

  const scoped = rows.find(
    (r) => r.role === "tenant_admin" || r.role === "tenant_viewer",
  );

  if (!scoped) {
    if (typeof appMetadata.tenant_id === "string" && appMetadata.tenant_id.length > 0) {
      merged.tenant_id = appMetadata.tenant_id;
    }
    delete merged.admin_role;
    return merged;
  }

  merged.admin_role = scoped.role;
  if (scoped.tenant_id) {
    merged.tenant_id = scoped.tenant_id;
  }

  return merged;
}
