import React from "react";
import { useAdminQuery } from "../api";
import { StatCard } from "../components/StatCard";
import { UsageChart } from "../components/UsageChart";
import type { AdminApiClient } from "../types";

export function Overview({ api }: { api: AdminApiClient }): JSX.Element {
  const { data: audit = [] } = useAdminQuery(["audit", 10], () => api.admin_get_audit_log({ p_limit: 10 }));
  const { data: runs = [] } = useAdminQuery(["runs", 5], () => api.admin_list_runs({ p_limit: 5 }));
  const chart = Array.from({ length: 30 }, (_, i) => ({ x: `${i + 1}`, y: Math.round(Math.random() * 100) }));

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
        <StatCard label="Cost this month" value="$0.00" />
        <StatCard label="Runs today" value="0" />
        <StatCard label="Error rate" value="0%" />
        <StatCard label="Top tool" value="—" />
      </div>
      <UsageChart data={chart} />
      <div className="card"><strong>Recent audit events</strong><pre>{JSON.stringify(audit, null, 2)}</pre></div>
      <div className="card"><strong>Recent runs</strong><pre>{JSON.stringify(runs, null, 2)}</pre></div>
    </>
  );
}
