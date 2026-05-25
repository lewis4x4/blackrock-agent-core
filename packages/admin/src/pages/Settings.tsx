import React from "react";

export function Settings(): JSX.Element {
  return (
    <div className="card">
      <p>Default rate limits: read-only (v1)</p>
      <p>Default retention days: read-only (v1)</p>
      <p>Branding: placeholder (S7)</p>
      <p>Cross-tenant access policy: active</p>
    </div>
  );
}
