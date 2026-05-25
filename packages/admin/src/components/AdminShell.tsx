import React from "react";
import type { TenantConfig } from "@blackrock-ai/agent-core";
import { BrandHeader, themeVars } from "../../../shell/src/theme";

interface AdminShellProps {
  config: TenantConfig;
  active: string;
  onNav: (next: string) => void;
  children: React.ReactNode;
}

const NAV = ["overview", "usage", "tenants", "runs", "settings"] as const;

export function AdminShell({ config, active, onNav, children }: AdminShellProps): JSX.Element {
  return (
    <div className="ws" style={themeVars(config.accent)}>
      <style>{CSS}</style>
      <aside className="admin-rail">
        {NAV.map((item) => (
          <button
            key={item}
            className={"admin-nav" + (active === item ? " on" : "")}
            onClick={() => onNav(item)}
          >
            {item}
          </button>
        ))}
      </aside>
      <main className="main">
        <div className="hero"><BrandHeader config={config} /></div>
        <div className="admin-content">{children}</div>
      </main>
    </div>
  );
}

const CSS = `
.ws .admin-rail{width:180px;border-right:1px solid rgba(255,255,255,.06);padding:20px;display:flex;flex-direction:column;gap:8px;background:#111}
.ws .admin-nav{border:1px solid rgba(255,255,255,.1);background:#181818;color:#d4d4d8;border-radius:10px;padding:8px 10px;text-transform:capitalize;cursor:pointer}
.ws .admin-nav.on{background:var(--acSoft);color:var(--ac)}
.ws .admin-content{max-width:1200px;margin:24px auto 0;display:flex;flex-direction:column;gap:16px}
.ws .card{border:1px solid rgba(255,255,255,.09);background:#161618;border-radius:12px;padding:12px}
.ws table{width:100%;border-collapse:collapse}
.ws th,.ws td{padding:8px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left;font-size:13px}
.ws .muted{opacity:.75}
.ws .toolbar{display:flex;gap:8px;flex-wrap:wrap}
.ws input,.ws select,.ws textarea{background:#0f0f10;border:1px solid rgba(255,255,255,.12);color:#ececee;border-radius:8px;padding:8px;font-family:inherit}
.ws button.btn{background:var(--ac);color:#111;border:none;border-radius:8px;padding:8px 10px;cursor:pointer}
`;
