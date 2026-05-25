import React, { useState } from "react";
import { useAdminMutation, useAdminQuery } from "../api";
import type { AdminApiClient } from "../types";
import { Modal } from "../components/Modal";

export function TenantsList({ api, onView }: { api: AdminApiClient; onView: (id: string) => void }): JSX.Element {
  const { data: tenants = [], refetch } = useAdminQuery(["tenants"], () => api.admin_list_tenants({}));
  const pause = useAdminMutation((vars: Record<string, unknown>) => api.admin_set_tenant_paused(vars));
  const create = useAdminMutation((vars: Record<string, unknown>) => api.admin_create_tenant(vars));
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  return (
    <>
      <div className="toolbar"><button className="btn" onClick={() => setOpen(true)}>Create tenant</button></div>
      <div className="card">
        <table><thead><tr><th>Slug</th><th>Display</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          {(tenants as Array<Record<string, unknown>>).map((tenant, idx) => (
            <tr key={String(tenant.id ?? idx)}>
              <td>{String(tenant.slug ?? "")}</td><td>{String(tenant.display_name ?? "")}</td><td>{String(tenant.status ?? "active")}</td>
              <td>
                <button className="btn" onClick={() => onView(String(tenant.id ?? ""))}>View</button>
                <button className="btn" onClick={async () => { await pause.mutateAsync({ tenant_id: tenant.id, paused: true }); await refetch(); }}>Pause/Unpause</button>
              </td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <Modal open={open} title="Create tenant" onClose={() => setOpen(false)}>
        <div className="toolbar"><input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} /><input placeholder="display_name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /><button className="btn" onClick={async () => { await create.mutateAsync({ p_slug: slug, p_display_name: displayName }); setOpen(false); await refetch(); }}>Create</button></div>
      </Modal>
    </>
  );
}
