import { describe, expect, test } from "bun:test";
import { mergeClaims } from "../claims";

describe("auth-jwt mergeClaims", () => {
  test("superadmin wins over tenant-scoped rows", () => {
    const claims = mergeClaims(
      { sub: "u1", app_metadata: { tenant_id: "t-from-meta" } },
      [
        { role: "tenant_admin", tenant_id: "t1" },
        { role: "superadmin", tenant_id: null },
      ],
    );

    expect(claims.admin_role).toBe("superadmin");
    expect(claims.tenant_id).toBeUndefined();
  });

  test("tenant-scoped role sets tenant_id", () => {
    const claims = mergeClaims({ sub: "u2" }, [{ role: "tenant_viewer", tenant_id: "t2" }]);

    expect(claims.admin_role).toBe("tenant_viewer");
    expect(claims.tenant_id).toBe("t2");
  });

  test("no admin rows preserves app_metadata tenant and removes admin_role", () => {
    const claims = mergeClaims(
      {
        sub: "u3",
        app_metadata: { tenant_id: "t3" },
        admin_role: "tenant_admin",
      },
      [],
    );

    expect(claims.admin_role).toBeUndefined();
    expect(claims.tenant_id).toBe("t3");
  });
});
