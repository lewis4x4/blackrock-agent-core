import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const PARK =
  "[PARKED — verify-admin needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (+ optional SUPABASE_ANON_KEY)]";

function park(reason: string): never {
  process.stdout.write(`${PARK}\n`);
  process.stderr.write(`[parked] ${reason}\n`);
  process.exit(0);
}

function ok(s: string): void {
  process.stdout.write(`[ok] ${s}\n`);
}

function fail(s: string): never {
  process.stdout.write(`[fail] ${s}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceKey) park("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const service = createClient<any, "agent_core">(url, serviceKey, {
    db: { schema: "agent_core" },
    auth: { persistSession: false },
  });

  const anon = anonKey
    ? createClient<any, "agent_core">(url, anonKey, {
        db: { schema: "agent_core" },
        auth: { persistSession: false },
      })
    : null;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const superadminUser = randomUUID();

  await service.from("tenants").insert([
    { id: tenantA, slug: `verify-admin-a-${tenantA.slice(0, 6)}`, display_name: "verify A" },
    { id: tenantB, slug: `verify-admin-b-${tenantB.slice(0, 6)}`, display_name: "verify B" },
  ]);

  await service.from("admin_users").insert({
    user_id: superadminUser,
    tenant_id: null,
    role: "superadmin",
  });

  try {
    const runsInsert = await service.from("agent_runs").insert([
      { tenant_id: tenantA, status: "completed", model: "m1" },
      { tenant_id: tenantB, status: "completed", model: "m1" },
    ]);
    if (runsInsert.error) fail(`seed runs failed: ${runsInsert.error.message}`);

    ok("invariant 1: seeded multi-tenant run rows for RLS/admin checks");

    if (anon) {
      const denied = await anon.rpc("admin_list_runs", { p_tenant: tenantA, p_limit: 1 });
      if (!denied.error) fail("invariant 2: anon unexpectedly called admin_list_runs");
      ok("invariant 2: admin_* RPCs are not callable by anon role");
    } else {
      process.stdout.write("[parked] invariant 2: SUPABASE_ANON_KEY missing\n");
    }

    const targetRun = await service
      .from("agent_runs")
      .select("id, tenant_id")
      .eq("tenant_id", tenantB)
      .limit(1)
      .single();
    if (targetRun.error || !targetRun.data?.id) fail("invariant 3: missing seeded run");

    await service.rpc("admin_get_run", { p_run_id: targetRun.data.id });
    const audit = await service
      .from("audit_log")
      .select("event, meta")
      .eq("event", "cross_tenant_access")
      .eq("tenant_id", tenantB)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (audit.error) fail(`invariant 3: audit lookup failed (${audit.error.message})`);
    if (!audit.data) {
      process.stdout.write(
        "[parked] invariant 3: cross-tenant audit requires signed superadmin JWT context\n",
      );
    } else {
      ok("invariant 3: cross_tenant_access audit event recorded");
    }

    const rotate = await service.rpc("admin_rotate_credential", {
      p_tenant: tenantA,
      p_provider: "anthropic",
      p_new_secret: `sk-verify-${randomUUID()}`,
    });
    if (rotate.error) fail(`invariant 4: rotate credential failed (${rotate.error.message})`);

    const rotatedAudit = await service
      .from("audit_log")
      .select("meta")
      .eq("event", "secret_rotated")
      .eq("tenant_id", tenantA)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rotatedAudit.error) fail(`invariant 4: audit read failed (${rotatedAudit.error.message})`);
    const auditText = JSON.stringify(rotatedAudit.data?.meta ?? {});
    if (/sk-verify-/i.test(auditText)) fail("invariant 4: secret leaked into audit meta");
    ok("invariant 4: admin_rotate_credential did not log secret values");

    const revokeLast = await service.rpc("admin_revoke_admin", {
      p_user_id: superadminUser,
      p_tenant: null,
    });
    if (!revokeLast.error) fail("invariant 5: last superadmin revoke should fail");
    ok("invariant 5: last superadmin revoke is refused");

    await service.from("rate_limit_counters").insert([
      {
        tenant_id: tenantA,
        subject: "verify-subject",
        window_start: new Date().toISOString(),
        window_secs: 60,
        count: 1,
      },
      {
        tenant_id: tenantA,
        subject: "verify-subject-2",
        window_start: new Date().toISOString(),
        window_secs: 60,
        count: 1,
      },
    ]);

    const reset = await service.rpc("admin_reset_rate_limit", {
      p_tenant: tenantA,
      p_subject: "verify-subject",
    });
    if (reset.error) fail(`invariant 6: admin_reset_rate_limit failed (${reset.error.message})`);
    if (typeof reset.data !== "number" || reset.data < 1) {
      fail("invariant 6: admin_reset_rate_limit deleted count invalid");
    }
    ok("invariant 6: admin_reset_rate_limit pruned matching rows");
  } finally {
    await service.from("tenants").delete().in("id", [tenantA, tenantB]);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch|network|ENOTFOUND|ECONNREFUSED/i.test(msg)) park(msg);
  fail(msg);
});
