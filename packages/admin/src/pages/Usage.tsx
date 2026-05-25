import React, { useMemo, useState } from "react";
import { useAdminQuery } from "../api";
import { UsageChart } from "../components/UsageChart";
import { Table } from "../components/Table";
import type { AdminApiClient } from "../types";

export function Usage({ api }: { api: AdminApiClient }): JSX.Element {
  const [range, setRange] = useState("30");
  const [grain, setGrain] = useState("day");
  const { data: tools = [] } = useAdminQuery(["usage-tools", range, grain], () => api.admin_get_usage_summary({ include_tools: true }));
  const { data: users = [] } = useAdminQuery(["usage-users", range, grain], () => api.admin_get_usage_summary_by_user({}));
  const data = useMemo(() => Array.from({ length: 10 }, (_, i) => ({ x: `${i + 1}`, y: i * 5 + 3 })), []);

  return (
    <>
      <div className="toolbar">
        <select value={range} onChange={(e) => setRange(e.target.value)}><option value="7">Last 7</option><option value="30">Last 30</option><option value="90">Last 90</option><option value="custom">Custom</option></select>
        <select value={grain} onChange={(e) => setGrain(e.target.value)}><option>day</option><option>week</option><option>month</option></select>
      </div>
      <UsageChart data={data} />
      <Table columns={[{ header: "Per-tool breakdown", accessorFn: (row) => JSON.stringify(row) }]} data={tools as object[]} />
      <Table columns={[{ header: "Per-user breakdown", accessorFn: (row) => JSON.stringify(row) }]} data={users as object[]} />
    </>
  );
}
