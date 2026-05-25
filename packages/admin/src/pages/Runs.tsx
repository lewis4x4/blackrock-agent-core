import React, { useState } from "react";
import { useAdminQuery } from "../api";
import type { AdminApiClient } from "../types";

export function RunsList({ api, onView }: { api: AdminApiClient; onView: (id: string) => void }): JSX.Element {
  const [status, setStatus] = useState("");
  const [model, setModel] = useState("");
  const { data: runs = [] } = useAdminQuery(["runs", status, model], () => api.admin_list_runs({ p_status: status ? [status] : null, p_model: model || null }));
  return (
    <>
      <div className="toolbar">
        <input placeholder="status" value={status} onChange={(e) => setStatus(e.target.value)} />
        <input placeholder="model" value={model} onChange={(e) => setModel(e.target.value)} />
      </div>
      <div className="card"><table><thead><tr><th>When</th><th>Tenant</th><th>Model</th><th>Status</th><th>Tokens</th><th>Cost</th><th>Duration</th><th></th></tr></thead><tbody>
        {(runs as Array<Record<string, unknown>>).map((run, idx) => (
          <tr key={String(run.id ?? idx)}><td>{String(run.created_at ?? "")}</td><td>{String(run.tenant ?? "")}</td><td>{String(run.model ?? "")}</td><td>{String(run.status ?? "")}</td><td>{String(run.tokens ?? "")}</td><td>{String(run.cost ?? "")}</td><td>{String(run.duration ?? "")}</td><td><button className="btn" onClick={() => onView(String(run.id ?? ""))}>Inspect</button></td></tr>
        ))}
      </tbody></table></div>
    </>
  );
}
