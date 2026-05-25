import type { TenantConfig } from "@blackrock-ai/agent-core";

export interface AdminProps {
  config: TenantConfig;
  apiBase?: string;
  getAuthToken?: () => Promise<string | null>;
}

export interface AdminRpcError extends Error {
  code?: string;
  details?: string;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface AdminApiClient {
  admin_get_audit_log(args?: Record<string, unknown>): Promise<unknown[]>;
  admin_list_runs(args?: Record<string, unknown>): Promise<unknown[]>;
  admin_get_usage_summary(args?: Record<string, unknown>): Promise<unknown[]>;
  admin_get_usage_summary_by_user(args?: Record<string, unknown>): Promise<unknown[]>;
  admin_list_tenants(args?: Record<string, unknown>): Promise<unknown[]>;
  admin_set_tenant_paused(args: Record<string, unknown>): Promise<unknown>;
  admin_create_tenant(args: Record<string, unknown>): Promise<unknown>;
  admin_list_tools(args: Record<string, unknown>): Promise<unknown[]>;
  admin_set_tool_enabled(args: Record<string, unknown>): Promise<unknown>;
  admin_list_connections(args: Record<string, unknown>): Promise<unknown[]>;
  admin_revoke_connection(args: Record<string, unknown>): Promise<unknown>;
  admin_list_credentials(args: Record<string, unknown>): Promise<unknown[]>;
  admin_rotate_credential(args: Record<string, unknown>): Promise<unknown>;
  admin_list_admins(args: Record<string, unknown>): Promise<unknown[]>;
  admin_set_admin(args: Record<string, unknown>): Promise<unknown>;
  admin_revoke_admin(args: Record<string, unknown>): Promise<unknown>;
  admin_update_tenant(args: Record<string, unknown>): Promise<unknown>;
  admin_get_run(args: Record<string, unknown>): Promise<unknown[]>;
}
