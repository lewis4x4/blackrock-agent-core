import React from "react";
import { Sparkles } from "lucide-react";
import type { TenantConfig } from "./types";

export const hexA = (hex: string, alpha: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

export function themeVars(accent: string): React.CSSProperties {
  return {
    "--ac": accent,
    "--acSoft": hexA(accent, 0.14),
    "--acGlow": hexA(accent, 0.3),
  } as React.CSSProperties;
}

interface BrandHeaderProps {
  config: TenantConfig;
}

export function BrandHeader({ config }: BrandHeaderProps): JSX.Element {
  return (
    <>
      <div className="eyebrow fu" style={{ animationDelay: ".05s" }}>
        <span className="eyebrow-dot" /> AGENT CORE — BLACKROCK AI
      </div>
      <h1 className="title fu" style={{ animationDelay: ".10s" }}>
        {config.product}
      </h1>
      <p className="subtitle fu" style={{ animationDelay: ".15s" }}>
        {config.tagline}
      </p>
    </>
  );
}

export interface ToastState {
  id: number;
  msg: string;
  sub: string;
}

export function Toast({ toast }: { toast: ToastState }): JSX.Element {
  return (
    <div className="toast" key={toast.id}>
      <span className="toast-dot" />
      <span className="toast-text">
        <strong>{toast.msg}</strong>
        <span>{toast.sub}</span>
      </span>
    </div>
  );
}

export function BrandMark(): JSX.Element {
  return <Sparkles size={18} strokeWidth={2.2} />;
}
