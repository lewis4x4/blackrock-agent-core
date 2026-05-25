import React from "react";

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="card">
      <div className="muted">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      {sub ? <div className="muted">{sub}</div> : null}
    </div>
  );
}
