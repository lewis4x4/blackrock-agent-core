import type { LucideIcon } from "lucide-react";

/** What kind of tile this is — drives the badge and launch behaviour. */
export type ToolKind = "ai" | "app" | "connected";

/** A single launchable tile in the workspace launcher. */
export interface ToolDef {
  name: string;
  Icon: LucideIcon;
  /** Hex colour for the tile icon chip. */
  tint: string;
  kind: ToolKind;
  /** For `connected` tools — the client subscription it authenticates against. */
  source?: string;
  /** Optional id the host app maps to a real action / route. */
  action?: string;
}

export interface ToolGroup {
  /** Optional sub-heading (e.g. "Their subscriptions"). */
  label?: string;
  tools: ToolDef[];
}

export interface Category {
  label: string;
  groups: ToolGroup[];
}

export interface NavItem {
  id: string;
  label: string;
  Icon: LucideIcon;
}

/**
 * The entire client-specific surface area. One of these per client app —
 * lives in the CLIENT repo, never in agent-core.
 */
export interface TenantConfig {
  id: string;
  brand: string;
  product: string;
  tagline: string;
  /** Hex accent colour. Themes the whole shell. */
  accent: string;
  nav: NavItem[];
  categories: Category[];
}

export interface WorkspaceProps {
  config: TenantConfig;
  /** Fired when a launcher tile is clicked. Host app wires the real action. */
  onLaunch?: (tool: ToolDef) => void;
  /** Fired when the composer is submitted. Host app calls the agent runtime. */
  onSend?: (query: string, model: string) => void;
}
