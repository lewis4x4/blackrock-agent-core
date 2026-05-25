import React from "react";
import { useAdminQuery } from "../api";
import type { AdminApiClient } from "../types";

export function RunInspector({ api, runId }: { api: AdminApiClient; runId: string }): JSX.Element {
  const { data = [] } = useAdminQuery(["run", runId], () => api.admin_get_run({ p_run_id: runId }));
  return <div className="card"><pre>{JSON.stringify(data, null, 2)}</pre></div>;
}
