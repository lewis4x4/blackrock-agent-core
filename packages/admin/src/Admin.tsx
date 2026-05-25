import React, { useEffect, useMemo, useState } from "react";
import type { TenantConfig } from "@blackrock-ai/agent-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAdminClient } from "./api";
import { AdminShell } from "./components/AdminShell";
import { Overview } from "./pages/Overview";
import { Usage } from "./pages/Usage";
import { TenantsList } from "./pages/Tenants";
import { TenantDetail } from "./pages/TenantDetail";
import { RunsList } from "./pages/Runs";
import { RunInspector } from "./pages/RunInspector";
import { Settings } from "./pages/Settings";
import type { AdminProps } from "./types";

interface RouteState {
  page: "overview" | "usage" | "tenants" | "tenant-detail" | "runs" | "run-detail" | "settings";
  id?: string;
}

function parseHash(hash: string): RouteState {
  const [path] = hash.replace(/^#/, "").split("?");
  const parts = (path ?? "").split("/").filter(Boolean);
  if (parts[0] === "usage") return { page: "usage" };
  if (parts[0] === "tenants" && parts[1]) return { page: "tenant-detail", id: parts[1] };
  if (parts[0] === "tenants") return { page: "tenants" };
  if (parts[0] === "runs" && parts[1]) return { page: "run-detail", id: parts[1] };
  if (parts[0] === "runs") return { page: "runs" };
  if (parts[0] === "settings") return { page: "settings" };
  return { page: "overview" };
}

function navTo(next: string): void {
  window.location.hash = `#/${next}`;
}

export function Admin({ config, apiBase, getAuthToken }: AdminProps): JSX.Element {
  const queryClient = useMemo(() => new QueryClient(), []);
  const [route, setRoute] = useState<RouteState>(() => parseHash(window.location.hash));
  const admin = useMemo(() => {
    const base = apiBase ?? window.location.origin;
    const supabaseUrl = base.endsWith("/rest/v1") ? base.replace(/\/rest\/v1$/, "") : base;
    return createAdminClient({ supabaseUrl, getAuthToken });
  }, [apiBase, getAuthToken]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) navTo("overview");
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const active = route.page === "tenant-detail" ? "tenants" : route.page === "run-detail" ? "runs" : route.page;

  return (
    <QueryClientProvider client={queryClient}>
      <AdminShell config={config as TenantConfig} active={active} onNav={navTo}>
        {route.page === "overview" ? <Overview api={admin} /> : null}
        {route.page === "usage" ? <Usage api={admin} /> : null}
        {route.page === "tenants" ? <TenantsList api={admin} onView={(id) => navTo(`tenants/${id}`)} /> : null}
        {route.page === "tenant-detail" ? <TenantDetail api={admin} tenantId={route.id ?? ""} /> : null}
        {route.page === "runs" ? <RunsList api={admin} onView={(id) => navTo(`runs/${id}`)} /> : null}
        {route.page === "run-detail" ? <RunInspector api={admin} runId={route.id ?? ""} /> : null}
        {route.page === "settings" ? <Settings /> : null}
      </AdminShell>
    </QueryClientProvider>
  );
}
