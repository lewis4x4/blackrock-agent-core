import React from "react";

export function Modal({ open, title, children, onClose }: { open: boolean; title: string; children: React.ReactNode; onClose: () => void }): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="card" role="dialog" aria-modal="true">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>{title}</strong>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}
