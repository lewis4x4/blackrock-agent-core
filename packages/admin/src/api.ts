import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useMutation, useQuery, type UseMutationOptions, type UseQueryOptions } from "@tanstack/react-query";
import type { AdminApiClient, AdminRpcError } from "./types";

interface ClientOpts {
  supabaseUrl: string;
  getAuthToken?: () => Promise<string | null>;
}

const RPCS = [
  "admin_get_audit_log",
  "admin_list_runs",
  "admin_get_usage_summary",
  "admin_get_usage_summary_by_user",
  "admin_list_tenants",
  "admin_set_tenant_paused",
  "admin_create_tenant",
  "admin_list_tools",
  "admin_set_tool_enabled",
  "admin_list_connections",
  "admin_revoke_connection",
  "admin_list_credentials",
  "admin_rotate_credential",
  "admin_list_admins",
  "admin_set_admin",
  "admin_revoke_admin",
  "admin_update_tenant",
  "admin_get_run",
] as const;

function rpcError(message: string, details?: string, code?: string): AdminRpcError {
  const err = new Error(message) as AdminRpcError;
  err.details = details;
  err.code = code;
  return err;
}

export function createAdminClient(opts: ClientOpts): AdminApiClient {
  const authFetch = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const token = await opts.getAuthToken?.();
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }) as unknown as typeof fetch;

  const supabase: SupabaseClient = createClient(opts.supabaseUrl, "agent-admin-public-anon-key", {
    global: {
      fetch: authFetch,
    },
    auth: { persistSession: false },
  });

  const call = async (name: string, args?: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await supabase.rpc(name, args ?? {});
    if (error) throw rpcError(error.message, error.details, error.code);
    return data;
  };

  const client = Object.fromEntries(
    RPCS.map((rpc) => [rpc, (args?: Record<string, unknown>) => call(rpc, args) as Promise<unknown[]>])
  ) as unknown as AdminApiClient;

  return client;
}

export function useAdminQuery<TData>(
  key: ReadonlyArray<unknown>,
  queryFn: () => Promise<TData>,
  options?: Omit<UseQueryOptions<TData>, "queryKey" | "queryFn">
) {
  return useQuery({ queryKey: key, queryFn, ...(options ?? {}) });
}

export function useAdminMutation<TData, TVariables>(
  mutationFn: (vars: TVariables) => Promise<TData>,
  options?: UseMutationOptions<TData, Error, TVariables>
) {
  return useMutation({ mutationFn, ...(options ?? {}) });
}
