import React, { useState } from "react";
import { useAdminMutation, useAdminQuery } from "../api";
import { JsonEditor } from "../components/JsonEditor";
import type { AdminApiClient } from "../types";

const TABS = ["overview", "tools", "connections", "credentials", "admins", "audit", "settings"] as const;

export function TenantDetail({ api, tenantId }: { api: AdminApiClient; tenantId: string }): JSX.Element {
  const [tab, setTab] = useState<(typeof TABS)[number]>("overview");
  const [json, setJson] = useState("{}");
  const tools = useAdminQuery(["tools", tenantId], () => api.admin_list_tools({ p_tenant: tenantId }), { enabled: tab === "tools" });
  const cons = useAdminQuery(["connections", tenantId], () => api.admin_list_connections({ p_tenant: tenantId }), { enabled: tab === "connections" });
  const creds = useAdminQuery(["creds", tenantId], () => api.admin_list_credentials({ p_tenant: tenantId }), { enabled: tab === "credentials" });
  const admins = useAdminQuery(["admins", tenantId], () => api.admin_list_admins({ p_tenant: tenantId }), { enabled: tab === "admins" });
  const audit = useAdminQuery(["audit", tenantId], () => api.admin_get_audit_log({ p_tenant: tenantId }), { enabled: tab === "audit" });
  const toggleTool = useAdminMutation((v: Record<string, unknown>) => api.admin_set_tool_enabled(v));
  const revokeConn = useAdminMutation((v: Record<string, unknown>) => api.admin_revoke_connection(v));
  const rotate = useAdminMutation((v: Record<string, unknown>) => api.admin_rotate_credential(v));
  const setAdmin = useAdminMutation((v: Record<string, unknown>) => api.admin_set_admin(v));
  const revokeAdmin = useAdminMutation((v: Record<string, unknown>) => api.admin_revoke_admin(v));
  const updateTenant = useAdminMutation((v: Record<string, unknown>) => api.admin_update_tenant(v));

  return (
    <>
      <div className="toolbar">{TABS.map((t) => <button className="btn" key={t} onClick={() => setTab(t)}>{t}</button>)}</div>
      <div className="card">
        {tab === "overview" ? <div>Tenant {tenantId}</div> : null}
        {tab === "tools" ? <pre>{JSON.stringify(tools.data ?? [], null, 2)}</pre> : null}
        {tab === "connections" ? <pre>{JSON.stringify(cons.data ?? [], null, 2)}</pre> : null}
        {tab === "credentials" ? <pre>{JSON.stringify(creds.data ?? [], null, 2)}</pre> : null}
        {tab === "admins" ? <pre>{JSON.stringify(admins.data ?? [], null, 2)}</pre> : null}
        {tab === "audit" ? <pre>{JSON.stringify(audit.data ?? [], null, 2)}</pre> : null}
        {tab === "settings" ? <JsonEditor value={json} onChange={setJson} /> : null}
      </div>
      <div className="toolbar">
        <button className="btn" onClick={() => toggleTool.mutate({ p_tenant: tenantId, p_tool_key: "web_search", p_enabled: true })}>Toggle tool</button>
        <button className="btn" onClick={() => revokeConn.mutate({ p_connection_id: "" })}>Revoke connection</button>
        <button className="btn" onClick={() => rotate.mutate({ p_tenant: tenantId, p_provider: "anthropic", p_new_secret: "" })}>Rotate credential</button>
        <button className="btn" onClick={() => setAdmin.mutate({ p_tenant: tenantId, p_user_id: "" })}>Grant admin</button>
        <button className="btn" onClick={() => revokeAdmin.mutate({ p_admin_user_id: "" })}>Revoke admin</button>
        <button className="btn" onClick={() => updateTenant.mutate({ p_tenant: tenantId, p_display_name: "Updated" })}>Update tenant</button>
      </div>
    </>
  );
}
