# Sprint 6 — Admin UX & Shell Design

**Status:** Draft for review
**Author:** Agent Core shell track
**Date:** 2026-05-24
**Scope:** Packaging, auth model, page specs, components, backend deps, tech picks for the first Agent Core admin UI.

---

## 0. Context

Agent Core is live in production for tenant #1 (BlackRock). The Command Center install (Supabase project `gsvhuzpysxaegoecwjmf`) is the only end-to-end deployment. There is no admin UI yet — Brian manages tenants via raw SQL and the `bootstrap-tenant.ts` script. Sprint 6 needs to make the system operable without psql.

The existing shell (`@blackrock-ai/agent-core`) ships exactly one React component, `<Workspace />`, plus a `createAgentClient` for SSE streaming. It is **deliberately minimal**: one external runtime dep (`lucide-react`), all styling embedded as a single `<style>` block scoped under `.ws`, no router, no data fetching, no design system. Adding admin must not violate that posture.

Recurring constraints throughout this design:

1. **Bundle discipline.** The end-user shell must not grow because we shipped an admin UI.
2. **Security blast radius.** Admin surfaces credential metadata and run history. It must be impossible for a tenant end-user shell to import any admin RPC by accident, and impossible for tenant A's admin to read tenant B's data.
3. **Host-agnostic.** Agent Core is consumed as an npm package by N client repos. The admin must work in whatever host stack (Next.js, Vite, Remix) the client picked.
4. **Configure, don't rebuild.** Same philosophy as the workspace shell — the admin UI takes a config object plus a data client and renders. No client repo should ever fork the admin.

---

## 1. Packaging decision

### Recommendation: **Option B — new package `@blackrock-ai/agent-admin`** that depends on `@blackrock-ai/agent-core`.

### Reasoning

**Option A (extend `agent-core` with `<Admin />`)** — rejected.

- The end-user shell is currently ~one component + CSS. Adding admin (7 pages, charts, tables, forms, route logic) at least doubles the surface area and ~5× the dep weight (chart lib, table primitives, date utils, form handling). Every client repo that embeds `<Workspace />` would pay that bundle cost forever, even if they never load `/admin`.
- Tree-shaking helps but is unreliable across bundlers when a package ships React components with side-effecty CSS-in-JS imports. We do not want to bet customer bundle size on Vite + esbuild always doing the right thing.
- Mixing admin and end-user code in one package raises the security-review burden for every change — a one-line tweak to `<Workspace />` now ships alongside admin RPC helpers.

**Option C (scaffold into host app — no shipped component)** — rejected.

- Defeats the "configure, don't rebuild" principle. Every client (QEP, Command Center, future tenants) would re-implement the same 7 pages.
- Admin pages need tight coupling to the agent_core RPC contract. Without a shipped component, every backend RPC signature change becomes a coordinated migration across N client repos.
- We lose the security review point — admin code that touches Vault metadata is reviewed once in the shared package, not N times in client forks.

**Option B (`@blackrock-ai/agent-admin`)** — chosen.

- Clean separation: clients who only need end-user UX install `agent-core`. Clients who need admin (initially: BlackRock internal app + each tenant's own admin portal) install `agent-admin`.
- `agent-admin` depends on `agent-core` for shared primitives (brand header tokens, the accent-color CSS variable system, the toast component) — no duplicated design language.
- Admin can adopt heavier dependencies (chart lib, date-fns, table primitive) without polluting the end-user bundle. Each client decides.
- npm scope makes the security boundary obvious in code review: an end-user shell file that imports from `@blackrock-ai/agent-admin` is a red flag the linter can catch.

### Package layout

```
packages/
├── shell/                          # existing — @blackrock-ai/agent-core
│   └── src/
│       ├── Workspace.tsx
│       ├── client.ts
│       ├── types.ts
│       └── theme.ts                # NEW — extracted CSS variables, hexA helper,
│                                   #       brand header component. Re-exported.
└── admin/                          # NEW — @blackrock-ai/agent-admin
    ├── src/
    │   ├── Admin.tsx               # top-level shell wrapper
    │   ├── client.ts               # AdminClient — wraps the admin RPC surface
    │   ├── types.ts                # AdminConfig, role types, page props
    │   ├── theme.css.ts            # imports tokens from agent-core
    │   ├── pages/
    │   │   ├── Overview.tsx        # /admin
    │   │   ├── Usage.tsx           # /admin/usage
    │   │   ├── TenantsList.tsx     # /admin/tenants
    │   │   ├── TenantDetail.tsx    # /admin/tenants/:id
    │   │   ├── RunsList.tsx        # /admin/runs
    │   │   ├── RunInspector.tsx    # /admin/runs/:id
    │   │   └── Settings.tsx        # /admin/settings
    │   ├── widgets/
    │   │   ├── UsageChart.tsx
    │   │   ├── UsageStatCards.tsx
    │   │   ├── ToolToggleList.tsx
    │   │   ├── ConnectionsList.tsx
    │   │   ├── CredentialsList.tsx
    │   │   ├── RunsTable.tsx
    │   │   ├── TenantSwitcher.tsx
    │   │   └── DataTable.tsx
    │   └── index.ts
    ├── package.json
    └── tsup.config.ts
```

`Admin` does **not** ship a router. Like `Workspace`, the host app picks the route (Next.js App Router, react-router, etc.) and renders the correct admin page. The package exports both `<Admin />` (a layout shell with the nav rail + active page) and each page component individually for hosts that prefer to route page-by-page.

### Bundle target

- `agent-core` stays under 25 KB gzipped (current target ~10 KB).
- `agent-admin` budget: 90 KB gzipped including chart lib. Larger is acceptable because it's loaded behind admin auth and never on the end-user critical path.

---

## 2. Auth model

### Recommendation

Use a **dedicated `agent_core.admin_users` table** as the source of truth. Use **Supabase JWT custom claims** (`tenant_id`, `admin_role`) populated by a `before-token-issued` Auth Hook that reads `admin_users`. RLS continues to use `auth.jwt() ->> 'tenant_id'`, plus a new `agent_core.current_admin_role()` helper.

### Why a table over pure JWT metadata

- JWT app_metadata is editable only via service-role calls; we'd need an admin RPC to mutate it anyway. The table is the data, the JWT is the cache.
- Audit log: assignments, revocations, last-used timestamps belong on rows, not auth metadata blobs.
- Cross-tenant superadmin is multi-row by definition (one row per tenant scope), which JWT metadata models awkwardly.

### Roles

Three roles, intentionally minimal:

| Role | Scope | Capabilities |
|------|-------|--------------|
| `superadmin` | All tenants | Create/edit/deactivate tenants, manage admin assignments, see all runs/usage across tenants, rotate any key. BlackRock AI staff only. |
| `tenant_admin` | One tenant | Manage own tenant's tools, connections, API keys, view own usage and runs. Cannot create/delete tenants, cannot see other tenants. Client staff (e.g. QEP IT). |
| `tenant_viewer` | One tenant | Read-only on own tenant: usage, runs, tool list. No mutations. For client managers who want visibility without configuration access. |

End-user shell users (the people typing into `<Workspace />`) are **not** in `admin_users` at all — they are regular Supabase `authenticated` users with `tenant_id` in their JWT but no `admin_role`. Admin routes simply check `claims.admin_role IN ('superadmin', 'tenant_admin', 'tenant_viewer')` and render a 403 otherwise.

### Schema (migration 0008)

```sql
create table agent_core.admin_users (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  tenant_id       uuid references agent_core.tenants(id) on delete cascade,
  role            text not null check (role in ('superadmin','tenant_admin','tenant_viewer')),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  last_seen_at    timestamptz,
  -- superadmin: tenant_id is NULL (cross-tenant); tenant_admin/viewer: tenant_id required
  constraint admin_scope_consistent check (
    (role = 'superadmin' and tenant_id is null) or
    (role in ('tenant_admin','tenant_viewer') and tenant_id is not null)
  ),
  -- A user can hold at most one role per (tenant, scope). superadmin is global.
  unique nulls not distinct (user_id, tenant_id)
);

create index idx_admin_users_user on agent_core.admin_users(user_id);
create index idx_admin_users_tenant on agent_core.admin_users(tenant_id) where tenant_id is not null;

alter table agent_core.admin_users enable row level security;
```

### RLS strategy

Two new helper functions:

```sql
create or replace function agent_core.is_superadmin() returns boolean
  language sql stable
as $$ select coalesce(auth.jwt() ->> 'admin_role', '') = 'superadmin' $$;

create or replace function agent_core.current_admin_role() returns text
  language sql stable
as $$ select coalesce(auth.jwt() ->> 'admin_role', '') $$;
```

Existing `tenant_isolation` policies are extended with a superadmin escape hatch:

```sql
drop policy tenant_isolation on agent_core.agent_runs;
create policy tenant_isolation on agent_core.agent_runs
  for all
  using (
    tenant_id = agent_core.current_tenant()
    or agent_core.is_superadmin()
  )
  with check (
    tenant_id = agent_core.current_tenant()
    or agent_core.is_superadmin()
  );
```

Same pattern is applied to `tenants`, `tenant_credentials`, `tenant_tools`, `tenant_connections`, `agent_messages`, `artifacts`, and `admin_users` itself.

`admin_users` gets one extra policy: tenant_admins can read their own tenant's admin list (so the per-tenant Users page works), but only superadmin can insert/update/delete:

```sql
create policy admin_users_read on agent_core.admin_users
  for select using (
    agent_core.is_superadmin()
    or (tenant_id = agent_core.current_tenant()
        and agent_core.current_admin_role() in ('tenant_admin','tenant_viewer'))
  );

create policy admin_users_write on agent_core.admin_users
  for insert with check (agent_core.is_superadmin());
create policy admin_users_modify on agent_core.admin_users
  for update using (agent_core.is_superadmin())
                 with check (agent_core.is_superadmin());
create policy admin_users_delete on agent_core.admin_users
  for delete using (agent_core.is_superadmin());
```

### Token issuance

A Supabase Auth Hook (Edge Function, `supabase/functions/auth-jwt/`) runs on `before-token-issued`. It queries `admin_users` for the authenticating user and merges into the JWT:

```json
{
  "tenant_id": "uuid-of-tenant",
  "admin_role": "tenant_admin" | "superadmin" | null,
  "admin_tenants": ["uuid"]
}
```

For a superadmin, `tenant_id` is unset; the admin UI uses `admin_tenants` (which superadmin gets as `["*"]` for clarity) plus an in-app **Tenant Switcher** to scope subsequent reads. The switcher is purely a UI concept — the JWT does not change between switches. Instead, superadmin reads bypass `current_tenant()` via the `is_superadmin()` escape hatch and pass an explicit `p_tenant` to every RPC.

### Mutations: SECURITY DEFINER RPCs only

For all admin mutations (rotate credential, toggle tool, revoke connection, etc.), the rule is: **never let the browser write directly to credential/connection tables.** Every mutation routes through a `security definer` RPC that:

1. Checks `is_superadmin()` OR `(current_tenant() = p_tenant and current_admin_role() = 'tenant_admin')`.
2. Performs the mutation (with vault writes where applicable).
3. Returns minimal acknowledgment, not secret material.

This is the same pattern migrations 0002/0006 already established for `store_tenant_credential` and `store_tenant_connection` — we extend it.

---

## 3. Page-by-page spec

The admin shell has its own nav rail (mirroring the workspace shell's visual language) with these top-level items: **Overview · Usage · Tenants · Runs · Settings**. Per-tenant detail and run inspector are nested routes.

### 3.1 `/admin` — Overview

**Purpose.** Operator's "is everything healthy?" landing page. Optimized for a 5-second glance.

**Data shown.**
- 4 stat cards across the top: **Active tenants** (count), **Runs today** (count + sparkline), **Tokens today** (in+out + $ cost), **Failed runs (24h)** (count, accent red if > 0).
- A 14-day stacked area chart: runs per day, stacked by status (completed / failed / running).
- Most recent 10 runs across all tenants (or scoped to one tenant if `tenant_admin`): timestamp, tenant slug, status pill, model, cost.
- Health row: API key statuses across tenants (e.g. "QEP Anthropic key: OK · last used 4m ago", "Command Center OpenAI: OK · last used 1h ago"), and OAuth connections expiring within 7 days as a callout.

**Controls/actions.** No mutations on this page. Each card and row is a link to the deeper page that owns it (clicking the Runs Today card → `/admin/usage?range=today`, clicking a run row → `/admin/runs/:id`).

**Layout sketch.**

```
+-------------------------------------------------------------------------------+
| ⌂ Overview                                  Tenant: All  ▾   Range: 24h  ▾   |
+-------------------------------------------------------------------------------+
| [Active tenants] [Runs today]  [Tokens today]  [Failed (24h)]                |
|       12              847        4.2M / $18.14       3 ⚠                     |
+-------------------------------------------------------------------------------+
| Runs per day — last 14 days                                                  |
|   ▁▃▅▆▇▇▇▆▆█▇█▇█  (stacked: completed / failed / running)                    |
+-------------------------------------------------------------------------------+
| Recent runs                                            [view all →]          |
| 19:51  qep            ●completed   sonnet   $0.012                           |
| 19:48  command-center ●completed   opus     $0.043                           |
| ...                                                                          |
+-------------------------------------------------------------------------------+
| Credentials & connections health                                             |
|  ● qep / anthropic           last used 4m ago                                |
|  ● qep / m365 (OAuth)        expires in 4d  [renew]                          |
+-------------------------------------------------------------------------------+
```

**Required RPCs.**
- `admin_overview_stats(p_tenant uuid default null, p_range interval default '24 hours')` → returns the 4 stat-card numbers in one call.
- `admin_runs_timeseries(p_tenant uuid default null, p_days int default 14)` → day buckets with status counts.
- `admin_recent_runs(p_tenant uuid default null, p_limit int default 10)` → summary rows.
- `admin_credentials_health(p_tenant uuid default null)` → list of (tenant_slug, provider, last_used_at, status).
- `admin_connections_expiring(p_tenant uuid default null, p_days int default 7)` → expiring OAuth.

**Edge cases.**
- Zero data (brand new install, no runs ever): show empty state with link to bootstrap docs and the inline "Create tenant" CTA.
- `tenant_admin` role: the Tenant dropdown is locked to their tenant; the "All" option is hidden.
- A tenant with a missing or revoked Anthropic key shows a banner at top of the page with link to fix.

---

### 3.2 `/admin/usage` — Usage deep dive

**Purpose.** The page Brian opens when a client asks "what did we spend last month?" or when investigating a cost spike. Also the primary input for invoicing.

**Data shown.**
- Top: filter bar — tenant (or "All" for superadmin), date range presets (Today, 7d, 30d, MTD, Last month, Custom), group-by (Day, Tool, Model, User).
- Hero metric block: total runs, total tokens in/out, total $ cost, average cost per run, p50/p95 run duration.
- Main chart: time series (line or stacked area depending on group-by) of cost-over-time.
- Secondary chart: horizontal bar — top tools by call count, with cost overlay.
- Table below: per-row breakdown matching the group-by. Sortable columns: runs, tokens_in, tokens_out, cost, avg_duration_ms. Each row clickable to drill into a filtered runs list.

**Controls/actions.**
- Export CSV button (top-right) — POSTs filters to `admin_export_usage_csv`, downloads.
- "Set as default view" — stores the current filter set in localStorage. No backend.
- "Copy invoice line" — formats the current totals as a copy-pasteable invoice line.

**Layout sketch.**

```
+-------------------------------------------------------------------------------+
| Usage                          [Tenant ▾] [Range ▾] [Group: Day ▾] [Export ▾]|
+-------------------------------------------------------------------------------+
| Runs        Tokens in/out      Cost          Avg cost      p50 / p95 dur     |
| 12,847      48.2M / 18.1M      $214.88       $0.017        1.2s / 4.8s       |
+-------------------------------------------------------------------------------+
| Cost over time                                                               |
|   ▂▃▄▅▅▇▆▇█▇▆▇▆▇  (line/area)                                                |
+-------------------------------------------------------------------------------+
| Top tools                          | Runs by status                          |
| http_request   ████████ 3.2k       | completed  98.6%                        |
| web_search     █████ 2.0k          | failed       0.9%                       |
| hubspot_query  ████ 1.6k           | running      0.5%                       |
+-------------------------------------------------------------------------------+
| Breakdown                                                                    |
| Day          Runs   Tok in   Tok out   Cost    Avg dur                       |
| 2026-05-24   847    4.2M     1.5M      $18.14  1.4s                          |
| 2026-05-23   903    4.7M     1.7M      $19.91  1.3s                          |
| ...                                                                          |
+-------------------------------------------------------------------------------+
```

**Required RPCs.** Reuse the Metering specialist's contracts. Assumed signatures (must be aligned with their work):
- `usage_summary(p_tenant uuid default null, p_from timestamptz, p_to timestamptz)` → stat block.
- `usage_timeseries(p_tenant uuid default null, p_from timestamptz, p_to timestamptz, p_bucket text)` → array of bucket rows.
- `usage_by_tool(p_tenant uuid default null, p_from timestamptz, p_to timestamptz)` → tool breakdown.
- `usage_by_model(p_tenant uuid default null, p_from timestamptz, p_to timestamptz)` → model breakdown.
- `usage_for_billing(p_tenant uuid, p_from date, p_to date)` → invoice-format payload (already specified for metering).

**Edge cases.**
- Custom date range > 90 days: warn and require explicit confirm (heavy query).
- Group-by User but the user_id column is sparse (most early runs have NULL user_id): render "unknown" bucket prominently and link to a docs page explaining backfill.
- `tenant_admin` cannot see other tenants — tenant dropdown disabled, RPCs always receive their tenant_id.

---

### 3.3 `/admin/tenants` — Tenants list + CRUD

**Purpose.** Superadmin's main control surface. List every tenant, create a new one, edit display name / slug, deactivate (soft-delete).

**Data shown.** A table: slug, display name, created_at, active status, runs (30d), cost (30d), # active connections, # API keys, # admin users. Sortable, searchable by slug or display name.

**Controls/actions.**
- **+ New tenant** button (top-right): opens a slide-over panel with the bootstrap form — slug, display name, initial model provider (Anthropic/OpenAI), initial API key, tool selection (checkboxes from registry). Submitting calls `admin_create_tenant` (which wraps the same steps as `bootstrap-tenant.ts`).
- Per-row actions menu: **Edit** (slug, display name), **Deactivate** (soft — sets `active=false`, blocks new runs but keeps history), **Delete** (hard — only after Deactivate, requires typing slug as confirmation).
- Clicking a row navigates to `/admin/tenants/:id`.

**Layout sketch.**

```
+-------------------------------------------------------------------------------+
| Tenants                                                       [+ New tenant] |
+-------------------------------------------------------------------------------+
| Search: [_______________]                                                    |
| Slug         Display name      Status   Runs 30d   Cost 30d   Tools  Keys ⋯ |
| qep          QEP USA           ●Active  12,847     $214.88    8      2    ⋯ |
| cmdctr       Command Center    ●Active  3,402      $98.12     6      2    ⋯ |
| ackme        Ackme Co          ○Inact   0          $0         0      0    ⋯ |
+-------------------------------------------------------------------------------+
```

**Required RPCs.**
- `admin_list_tenants(p_search text default null, p_include_inactive boolean default false)` → returns enriched rows (joins counts).
- `admin_create_tenant(p_slug text, p_display_name text, p_provider text, p_api_key text, p_tool_keys text[])` → returns new tenant_id. SECURITY DEFINER, superadmin-only; wraps the bootstrap-tenant logic atomically.
- `admin_update_tenant(p_tenant uuid, p_slug text default null, p_display_name text default null)`.
- `admin_set_tenant_active(p_tenant uuid, p_active boolean)`.
- `admin_delete_tenant(p_tenant uuid, p_confirm_slug text)` — requires slug match.

**Edge cases.**
- Slug collisions: validated client-side, server-side returns 23505 → translated to "slug already exists".
- Deactivate while runs are in-flight: the runtime checks `tenants.active` at run-start; in-flight runs continue but new ones get 403.
- Hard delete cascades: `tenant_credentials`, `tenant_tools`, `tenant_connections`, `agent_runs`, `agent_messages`, `artifacts`, `admin_users` — already wired via ON DELETE CASCADE in existing migrations. Bytes in Storage are NOT cascaded; the RPC enqueues a Storage cleanup job and returns the orphan-paths count.

**New schema needed.** Add `active boolean not null default true` to `agent_core.tenants` (migration 0008).

---

### 3.4 `/admin/tenants/:id` — Tenant detail

**Purpose.** All per-tenant configuration in one place, organized as tabs.

**Tabs.** Overview · Tools · Connections · API Keys · Users · Danger

**3.4.1 Overview tab.** A scoped version of the global Overview: this tenant's stat cards, 14-day chart, recent runs (linked to `/admin/runs/:id` with tenant pre-filtered). Top of page: tenant brand color swatch, slug, display name, created_at, active toggle (with confirmation if turning off), product description if set.

**3.4.2 Tools tab.** A list of every tool registered in the registry. Each row: tool key, description (from `Tool.description`), enabled toggle, "Edit config" button. The list reflects the *registered* tools from the runtime; existing rows in `tenant_tools` mark which are enabled. Editing config opens a JSON editor (Monaco-lite or just a textarea with validation against a shipped schema if the tool provides one).

```
+-------------------------------------------------------------------------------+
| Tools — QEP USA                                                              |
+-------------------------------------------------------------------------------+
| ☑ http_request    Generic HTTP fetch with caching          [Edit config ▾]   |
| ☑ web_search      Tavily-backed web search                  [Edit config ▾]   |
| ☑ hubspot_query   HubSpot CRM query (OAuth required)        [Edit config ▾]   |
| ☐ m365_mail       Microsoft Graph mail (OAuth required)     [Edit config ▾]   |
| ☐ data_query      Read-only Supabase data path              [Edit config ▾]   |
+-------------------------------------------------------------------------------+
```

RPCs: `admin_list_tools(p_tenant uuid)` (joins registry catalog with `tenant_tools`), `admin_set_tool_enabled(p_tenant uuid, p_tool_key text, p_enabled boolean)`, `admin_set_tool_config(p_tenant uuid, p_tool_key text, p_config jsonb)`.

The registry catalog itself is **not** stored in Postgres — the runtime owns it. A new runtime-side RPC handler `/agent/admin/tool-catalog` returns the registered tool list (key, description, optional config-schema JSON). The admin UI calls this once on tab mount and joins client-side with the DB `tenant_tools` rows.

**3.4.3 Connections tab.** OAuth connections from `tenant_connections`. Rows: provider, account_label, scopes (collapsed), status (active/expired/revoked), expires_at, created_at, "last used" (derived from latest run that called the matching tool — best-effort).

Actions per row:
- **Re-authorize** (kicks off the OAuth flow via the existing `supabase/functions/oauth/` edge function with returnUrl back to this page).
- **Revoke** (calls `admin_revoke_connection(p_connection_id uuid)` — sets status='revoked' and nulls out both secret_refs).
- **Add connection** button (top of tab) — picker of supported providers, launches OAuth flow.

**3.4.4 API Keys tab.** Model-provider keys from `tenant_credentials`. Rows: provider (anthropic/openai), meta.source, created_at, "last used" (from `agent_runs` join on model_provider), status (always 'present' or 'missing' — we never reveal key material or even fingerprints in the browser).

Actions per row:
- **Rotate** — opens a panel with a single password input + provider dropdown; calls `admin_rotate_credential(p_tenant uuid, p_provider text, p_new_secret text)` which wraps `store_tenant_credential` (which already does the upsert). The previous Vault secret is NOT deleted in v1 (per the migration 0002 note) — we surface this as a banner: "Previous secret is rotated out of use but remains in Vault until manual cleanup."
- **Delete** — `admin_delete_credential(p_tenant uuid, p_provider text)` requires typed confirmation. Blocks if any in-flight run depends on it.
- **+ Add credential** — same form as rotate but for new providers.

The UI never shows a key. We show only: provider, fingerprint computed server-side as `substring(sha256(secret), 1, 8)` returned by `resolve_tenant_secret` wrapped in a new `admin_credential_fingerprint(p_tenant, p_provider)` RPC. Even the fingerprint is optional — operator confidence-check only.

**3.4.5 Users tab.** Admin user assignments for this tenant. Rows: email (joined from auth.users), role (tenant_admin/tenant_viewer), assigned_at, last_seen_at.

Actions: **+ Invite admin** (email + role; sends Supabase magic-link invite via `admin_invite_tenant_admin`), per-row **Change role**, **Remove**.

Superadmins are NOT shown here (they're managed under `/admin/settings`).

**3.4.6 Danger tab.** Three actions: Deactivate, Export tenant data (writes a tarball of all rows + artifact manifest to Storage and returns signed URL), Hard delete.

**Layout sketch (tab nav).**

```
+-------------------------------------------------------------------------------+
| ← Tenants     QEP USA  ●Active     accent:#C98A4A    [Deactivate]            |
+-------------------------------------------------------------------------------+
| [Overview] [Tools] [Connections] [API Keys] [Users] [Danger]                 |
+-------------------------------------------------------------------------------+
| (tab content per spec above)                                                 |
+-------------------------------------------------------------------------------+
```

**Edge cases.**
- A tool that requires an OAuth provider gets a yellow warning chip on the Tools tab if no active connection exists for that provider.
- Disabling a tool while an in-flight run uses it: runs already in flight finish; new plans skip it. No mid-run kill.
- Rotating the model provider key invalidates the runtime's in-memory cache — emit a Postgres NOTIFY on `agent_core.credentials_rotated` and have the runtime subscribe (or just TTL the cache to 60s, which is simpler — recommend the TTL).

---

### 3.5 `/admin/runs` — Run history

**Purpose.** Searchable history of every run with filters. The page you go to when a user says "my agent didn't respond" or when you want to see all failed runs for a specific tool.

**Data shown.** A dense table: timestamp, tenant (if superadmin), user (email if joined, else short id), status pill, model, tokens in/out, cost, duration (completed_at - created_at), # tool calls (count of agent_messages with role='tool'), error (truncated, hover for full).

**Controls.**
- Filter bar: tenant, status (multi-select), model, date range, has_error (boolean), tool key (filters to runs that called this tool).
- Search box: full-text against user prompt (the first agent_messages row, role='user').
- Column sort.
- Row click → `/admin/runs/:id`.
- Pagination: cursor-based on (created_at, id).

**Layout sketch.**

```
+-------------------------------------------------------------------------------+
| Runs                            [Tenant▾] [Status▾] [Model▾] [Date▾] [Tool▾] |
| Search: [______________________________________________]                     |
+-------------------------------------------------------------------------------+
| Time      Tenant  User       Status      Model  Tok in/out  Cost   Dur  Tools|
| 19:51:02  qep     bjl@..     ●completed  son.   3.2k/1.1k   $0.012 1.4s 3    |
| 19:48:11  cmdctr  rk@..      ●completed  opus   4.4k/2.3k   $0.043 2.8s 5    |
| 19:45:01  qep     —          ●failed     son.   1.1k/0      $0.003 0.3s 0    |
+-------------------------------------------------------------------------------+
| [< Prev]                                                          [Next >]   |
+-------------------------------------------------------------------------------+
```

**Required RPCs.**
- `admin_list_runs(p_tenant uuid default null, p_status text[] default null, p_model text default null, p_from timestamptz default null, p_to timestamptz default null, p_search text default null, p_tool_key text default null, p_cursor text default null, p_limit int default 50)` — returns rows + next_cursor.
- `admin_run_summary_counts(...same filters)` — returns total count for "showing 1-50 of 12,847".

**Edge cases.**
- Search across `agent_messages.content->>'text'` is expensive at scale. Add a `pg_trgm` index on `((content->>'text'))` for `role='user'` rows in a future migration; v1 can use `ILIKE` with a 30-day default range cap.
- Long error strings: server truncates at 240 chars for the list; full text only on detail page.
- A tenant with 1M+ runs: cursor pagination keeps queries fast, but the "total count" RPC must short-circuit at 10,000 ("showing 1-50 of 10k+") to avoid full table scans.

---

### 3.6 `/admin/runs/:id` — Run inspector

**Purpose.** Drill-down on a single run for debugging and cost forensics. This is the page that justifies admin's existence — without it, debugging a bad answer means SQL.

**Layout — three panes.**

```
+-------------------------------------------------------------------------------+
| ← Runs       Run 7b3a1f… · qep · ●completed · sonnet · 1.4s · $0.012         |
+-------------------------------------------------------------------------------+
| LEFT: Timeline (380px)                | RIGHT: Selected step detail           |
|                                        |                                       |
| ▸ User prompt          19:51:02       |  Tool: web_search                     |
| ▸ Plan (3 tasks)       19:51:02       |  Task: t2                             |
|   ▸ t1 http_request    19:51:02 ✓     |  Status: ok                           |
|   ▸ t2 web_search      19:51:03 ✓     |  Duration: 412 ms                     |
|   ▸ t3 doc_generate    19:51:03 ✓     |                                       |
| ▸ Draft answer         19:51:04       |  Input:                               |
| ▸ Critic verdict ✓     19:51:04       |  { "query": "..." }                   |
| ▸ Final answer         19:51:04       |                                       |
|                                        |  Output:                              |
|                                        |  { "results": [ {...} ] }             |
|                                        |                                       |
|                                        |  [Copy] [Re-run this task]            |
+-------------------------------------------------------------------------------+
| BOTTOM: Cost & token breakdown                                                |
| Planner   1,204 in / 312 out  $0.004     Tools  (4 calls)        $0.005      |
| Critic    287   in / 91  out  $0.001     Synth  1,711 in/702 out $0.002      |
+-------------------------------------------------------------------------------+
```

**Data shown.**
- Header: run id, tenant, status, model, duration, total cost.
- Timeline (left): chronological tree of `agent_messages` rows. Each entry shows role, summary (e.g. tool name for role='tool', "Plan (N tasks)" for the planner output, etc.) and timestamp. Click any row to populate the right pane.
- Detail (right): full content of the selected message. For tool calls, pretty-prints input/output; for plans, renders the TaskGraph (with deps visualized as a small DAG); for assistant/user messages, renders text.
- Cost panel (bottom): if the runtime tags each message with per-stage token usage in `content` (recommended new field — see Backend deps), we render the breakdown; otherwise show total only with a hint.

**Controls/actions.**
- **Re-run this run** (top-right): calls `admin_replay_run(p_run uuid)` — creates a new run with the same prompt and tenant, optionally same model. Useful after fixing a credential or config.
- **Re-run this task** (per task in detail pane): only available for `tenant_admin` of the same tenant, and only for idempotent tools (flagged in registry). v1: probably ship as disabled with tooltip "coming in S7".
- **Copy as cURL** for tool calls: emits a curl line that would reproduce the underlying HTTP request, for tools that wrap HTTP. Optional, only if the tool stamps the request in its output.

**Required RPCs.**
- `admin_get_run(p_run uuid)` → run row + tenant slug + user email.
- `admin_get_run_messages(p_run uuid)` → ordered agent_messages.
- `admin_get_run_artifacts(p_run uuid)` → artifact pointers (uses existing `list_artifacts`).
- `admin_replay_run(p_run uuid)` → new run_id; calls into the existing agent handler.

**Edge cases.**
- A run that's still `running`: poll `admin_get_run_messages` every 2s, append new rows. Already streamable via SSE but admin doesn't need streaming-by-default — polling is simpler.
- A run with thousands of tool messages (e.g. a poorly-bounded loop): paginate the timeline at 200 rows with "load more".
- A run whose tenant has been hard-deleted: the run is gone too (CASCADE). The route shows a 404 with a hint.

---

### 3.7 `/admin/settings` — Org-wide settings

**Purpose.** Things that aren't per-tenant. Superadmin only.

**Sections.**

1. **Branding.** Logo, product name, footer text used by the admin shell itself. Persisted to a new `agent_core.org_settings` singleton table (one row, id=true on a check). Why ship this? Because if BlackRock sells the admin as a white-label, each reseller wants their own banner. v1 scope: just BlackRock branding, but the surface is shipped so we don't need a follow-up migration.

2. **Superadmin users.** List + invite + remove. Same shape as the per-tenant Users tab but scoped to `admin_users where role='superadmin'`. Cannot delete the last superadmin (server-side check).

3. **Runtime endpoints.** The agent edge function URL, OAuth callback URL, configured providers. These are environment values today; the page is a read-only display (operator confirms what the runtime saw at boot) with a "test" button per endpoint.

4. **Audit log.** Recent admin mutations (last 200): who, what, when. Read from a new `agent_core.admin_audit` table populated by triggers on the SECURITY DEFINER RPCs.

**Required RPCs.**
- `admin_get_org_settings()`, `admin_set_org_settings(p_brand jsonb)`.
- `admin_list_superadmins()`, `admin_invite_superadmin(p_email text)`, `admin_remove_admin(p_admin_user_id uuid)`.
- `admin_audit_log(p_limit int default 200, p_cursor text default null)`.

**New schema needed.** `agent_core.org_settings` (singleton), `agent_core.admin_audit` (id, actor_user_id, action, target_table, target_id, payload jsonb, created_at).

**Edge cases.**
- Branding upload: out of scope for v1 (text-only fields).
- Removing your own superadmin role: prompt confirms with "you will lose access immediately".

---

## 4. Component hierarchy

```
<Admin config={adminConfig} client={adminClient} route={hostRoute}>
│
├── <AdminShell>                  ← layout: nav rail + header + content slot
│   ├── <BrandHeader>             ← REUSED from agent-core (extracted in 1)
│   ├── <NavRail>                 ← admin-flavoured (Sparkles/Activity/Users/...)
│   └── <Toast>                   ← REUSED from agent-core
│
├── route="/admin"            → <OverviewPage>
│                                ├── <StatCards>          (reusable widget)
│                                ├── <UsageChart kind="timeseries-stacked">
│                                ├── <RunsTable mode="compact" limit=10>
│                                └── <HealthList>
│
├── route="/admin/usage"      → <UsagePage>
│                                ├── <FilterBar>          (reusable widget)
│                                ├── <StatCards>
│                                ├── <UsageChart kind="line">
│                                ├── <BarChart>           (top tools)
│                                ├── <DataTable>          (breakdown — reusable)
│                                └── <ExportMenu>
│
├── route="/admin/tenants"    → <TenantsListPage>
│                                ├── <DataTable>
│                                └── <NewTenantPanel>     (slide-over form)
│
├── route="/admin/tenants/:id" → <TenantDetailPage>
│                                ├── <TenantHeader>
│                                ├── <TabBar>             (reusable widget)
│                                └── <TabContent>:
│                                    ├── <TenantOverviewTab>
│                                    ├── <ToolToggleList>
│                                    ├── <ConnectionsList>
│                                    ├── <CredentialsList>
│                                    ├── <TenantUsersTab>
│                                    └── <DangerTab>
│
├── route="/admin/runs"       → <RunsListPage>
│                                ├── <FilterBar>
│                                ├── <DataTable>
│                                └── <Pagination>         (reusable widget)
│
├── route="/admin/runs/:id"   → <RunInspectorPage>
│                                ├── <RunHeader>
│                                ├── <RunTimeline>        (left pane)
│                                ├── <MessageDetail>      (right pane)
│                                └── <CostBreakdown>      (bottom pane)
│
└── route="/admin/settings"   → <SettingsPage>
                                 ├── <BrandingSection>
                                 ├── <SuperadminsList>
                                 ├── <EndpointsSection>
                                 └── <AuditLog>
```

### Sharing with `<Workspace />`

The following primitives should be extracted from `agent-core` and re-exported from both packages:

| Primitive | Why share |
|-----------|-----------|
| `BrandHeader` / brand color tokens (`--ac`, `--acSoft`, `--acGlow`) | Same visual identity — admin should feel like a power-user mode of the workspace, not a separate product. |
| `hexA()` helper | Used for accent-derived alphas in both UIs. |
| `Toast` component + `useToast()` hook | Same notification pattern (action launched, run completed, etc.). |
| The base `.ws` CSS reset (fonts, colors, box-sizing) | Avoid font/color drift between the two shells. Rename to `.bk` (BlackRock) or similar so admin can opt in without conflicting if both render on the same page. |

Refactor sequence: extract these into `packages/shell/src/theme.ts` and re-export from `index.ts` in S6 before the admin package is built. This is the only refactor agent-core needs.

The end-user `<Workspace />` itself is NOT reused inside admin — the admin nav rail has different items and the page is a different shape. Trying to reuse `<Workspace />` would tangle the two.

---

## 5. Backend dependencies

### Migrations needed (Sprint 6)

**0008_admin_users.sql** — `admin_users` table, role check constraint, RLS, helper functions (`is_superadmin`, `current_admin_role`), extended `tenant_isolation` policies on all existing tables to include the superadmin escape hatch. Add `active boolean not null default true` to `tenants`. (See section 2 for the full DDL.)

**0009_org_settings_and_audit.sql** — `org_settings` singleton, `admin_audit` table + trigger function that audit-logs SECURITY DEFINER mutations.

### New runtime/handler additions

The runtime currently exposes a single POST endpoint (`createAgentHandler`). Sprint 6 needs **one additional endpoint**: a tool catalog endpoint that returns the registered tool keys + descriptions + optional config schemas. Mounted as `GET /admin/tool-catalog` on the same edge function. Implementation: read from the `ToolRegistry` already constructed by the host app, serialize.

```ts
// packages/runtime/src/admin-handler.ts (new file)
export function createAdminToolCatalogHandler(registry: ToolRegistry) {
  return async (_req: Request) => {
    const tools = registry.list().map(t => ({
      key: t.key,
      description: t.description,
      configSchema: (t as any).configSchema ?? null,
    }));
    return new Response(JSON.stringify(tools), {
      headers: { "content-type": "application/json" },
    });
  };
}
```

No other runtime changes are *required* by S6, but two would be nice-to-have:

1. **Per-stage token tagging.** The persistence layer already records `agent_messages` rows for plan / tools / synth / critic. If each stage's row carries `content.tokens_in`, `content.tokens_out`, `content.cost` (instead of only the final total on `agent_runs`), the Run Inspector cost breakdown becomes much more useful. Recommend adding this to `recordMessage` calls in `handler.ts`.

2. **Credential cache TTL.** Drop in-process credential caches to ≤60s TTL so a rotate from the admin UI is honored without a process restart. Replace any unbounded cache in `model.ts` / OAuth resolution.

### RPC signatures — consolidated list

All return `setof jsonb` unless noted. All are `security definer` and `revoked from public, anon, authenticated; granted execute to authenticated` (the auth check runs inside the function body using `is_superadmin()` / `current_admin_role()` helpers).

Naming convention: every admin RPC is prefixed `admin_` so a future audit of grants is straightforward.

```
-- Overview / usage
admin_overview_stats(p_tenant uuid default null, p_range interval default '24 hours')
admin_runs_timeseries(p_tenant uuid default null, p_days int default 14)
admin_recent_runs(p_tenant uuid default null, p_limit int default 10)
admin_credentials_health(p_tenant uuid default null)
admin_connections_expiring(p_tenant uuid default null, p_days int default 7)

-- Tenants
admin_list_tenants(p_search text default null, p_include_inactive boolean default false)
admin_create_tenant(p_slug text, p_display_name text, p_provider text,
                    p_api_key text, p_tool_keys text[]) returns uuid
admin_update_tenant(p_tenant uuid, p_slug text default null,
                    p_display_name text default null)
admin_set_tenant_active(p_tenant uuid, p_active boolean)
admin_delete_tenant(p_tenant uuid, p_confirm_slug text)

-- Tools
admin_list_tools(p_tenant uuid)
admin_set_tool_enabled(p_tenant uuid, p_tool_key text, p_enabled boolean)
admin_set_tool_config(p_tenant uuid, p_tool_key text, p_config jsonb)

-- Connections
admin_list_connections(p_tenant uuid)
admin_revoke_connection(p_connection_id uuid)
-- (re-auth uses existing supabase/functions/oauth flow)

-- Credentials
admin_list_credentials(p_tenant uuid)
admin_rotate_credential(p_tenant uuid, p_provider text, p_new_secret text)
admin_delete_credential(p_tenant uuid, p_provider text, p_confirm boolean)
admin_credential_fingerprint(p_tenant uuid, p_provider text) returns text

-- Admin users
admin_list_admins(p_tenant uuid default null)            -- null = superadmins
admin_invite_admin(p_email text, p_role text,
                   p_tenant uuid default null) returns uuid
admin_change_admin_role(p_admin_user_id uuid, p_role text)
admin_remove_admin(p_admin_user_id uuid)

-- Runs
admin_list_runs(p_tenant uuid default null, p_status text[] default null,
                p_model text default null, p_from timestamptz default null,
                p_to timestamptz default null, p_search text default null,
                p_tool_key text default null, p_cursor text default null,
                p_limit int default 50)
admin_get_run(p_run uuid)
admin_get_run_messages(p_run uuid)
admin_get_run_artifacts(p_run uuid)
admin_replay_run(p_run uuid) returns uuid

-- Org / settings
admin_get_org_settings()
admin_set_org_settings(p_brand jsonb)
admin_audit_log(p_limit int default 200, p_cursor text default null)
```

### Cross-reference with Metering specialist

`usage_summary`, `usage_timeseries`, `usage_by_tool`, `usage_by_model`, `usage_for_billing` are assumed to come from Metering. The admin UI consumes them directly without wrapping. If their signatures end up differing from what this doc assumes, the only impact is the `<UsagePage>` query layer — wrap them in `AdminClient.usage.*` so a rename is a one-file change.

---

## 6. Tech choices

The shell's current dep budget is `react` + `react-dom` (peers) and `lucide-react`. The admin can take on more deps but each must justify itself.

| Concern | Pick | Why |
|---------|------|-----|
| **Chart library** | **Recharts** (`recharts`) | Small (~70 KB gz when tree-shaken with only the chart types we use), React-native API, zero config theming via CSS vars, used widely so onboarding is trivial. Alternative considered: visx (lower-level, more code per chart, bigger initial commit); rolling our own SVG (great control, but cost breakdown + 4 chart variants would consume the whole sprint). |
| **Date/time** | **`date-fns`** with selective imports (`format`, `parseISO`, `differenceInMilliseconds`, `subDays`, `startOfDay`). | ~10 KB gz with tree-shaking. We avoid moment (deprecated, heavy) and Luxon (overkill for what we need — no time zone math). All datetimes in the schema are `timestamptz`; we format in the browser's local zone and label "(local)" on the few places it matters. |
| **Table component** | **TanStack Table v8** (headless) | Heavy lifting on sort/pagination/filter without imposing UI. We render with the same `.bk-table` CSS as the rest of the shell. ~12 KB gz. The DataTable widget wraps it once so pages don't import TanStack directly. |
| **Form handling** | **No library — controlled components + a tiny `useForm` hook.** | The admin has maybe 8 forms total; none have complex validation needs that react-hook-form would justify (~20 KB). The exception: the JSON config editor (Tools tab) — use a plain `<textarea>` + JSON.parse-on-blur in v1; defer Monaco to S7+. |
| **Routing** | **None — `route` prop.** | Same pattern as `<Workspace />`. Host app (Next.js App Router, react-router) picks the URL and renders the matching admin page. Admin exports both `<Admin route="/admin/tenants/:id" params={{id}} />` (full layout) and each page component bare. |
| **Data fetching** | **`@tanstack/react-query`** | Pages have nested, dependent, polling, and cache-on-mutation patterns (run inspector polling, mutations that invalidate lists). Rolling fetch + useEffect for 7 pages will be a regret. ~13 KB gz. Strict cap: query, mutation, invalidate — no other react-query features. |
| **Styling** | **Same embedded CSS approach as `agent-core`.** | One `<style>{CSS}</style>` block scoped under `.bk-admin`. Host needs zero CSS setup. Vars (`--ac`, `--acSoft`) imported from agent-core's theme module. No Tailwind, no CSS modules, no styled-components. |
| **Icons** | **`lucide-react`** (already a dep via agent-core) | Consistent visual vocabulary. |

**Total expected dep weight** for `agent-admin`: ~110 KB gzipped (recharts 70 + tanstack-query 13 + tanstack-table 12 + date-fns 10 + framework overhead). End-user shell unchanged.

### What we deliberately do NOT pick

- No CSS framework. The existing shell proves we don't need one and admin is a few thousand lines of CSS at most.
- No state management library. React-query handles server state; everything else is local component state.
- No `react-router`. Host routes.
- No design system component library (shadcn/Radix/MUI). Each would dwarf our actual code by 10x.

---

## 7. Out of scope (deferred)

Explicit non-goals for Sprint 6 — each item is a sentence on why, plus where it might land.

- **Multi-org / multi-workspace UI.** v1 assumes one BlackRock org over N tenants. The schema doesn't model orgs above tenants. → S7 if a reseller deal closes.
- **White-label admin per tenant.** `org_settings` ships single-row in v1. The data model is forward-compatible (could become per-tenant later) but the UI is BlackRock-branded. → S7+.
- **Mobile responsive.** Desktop-only (≥1024px). The CSS will use the existing 1080/680 breakpoints but we won't audit small screens. Admin is an operations tool. → only if a customer complains.
- **Re-run individual tasks** in Run Inspector. Ship the button disabled with a tooltip. → S7.
- **Tool config JSON schema editor** with Monaco / autocomplete. Plain textarea in v1; schema rendering when the config gets non-trivial. → S7+.
- **Storage UI** for artifacts. Artifacts surface only in Run Inspector via download links. No general browsing of `agent_core.artifacts`. → S7.
- **Per-tenant rate limit / quota UI.** No quotas exist in the runtime yet. → blocked on a runtime feature.
- **Audit log export, alerting.** Display only in v1. → S7.
- **OAuth provider self-service** (client adds a new provider with its own client_id/secret). v1 only supports the providers the runtime ships with built-in. → S7+.
- **i18n.** English only. The shell has no i18n primitives. → indefinitely deferred.

---

## 8. Open questions for review

1. **Auth Hook deployability.** Supabase Auth Hooks are GA but require self-hosting or paid plans on some tiers — does Command Center's project have the right tier? If not, fallback is to populate JWT claims at sign-in via a custom JWT-signing edge function in front of Supabase Auth. Recommend confirming before locking in section 2.
2. **Replay semantics.** `admin_replay_run` re-prompts the agent with the same user message. Does it bill the tenant again? Recommendation: yes, with an audit log entry tagging it as a replay so they're filterable in `/admin/usage`. Get sign-off.
3. **Superadmin scoping by env.** Should there be different superadmin lists per Supabase project (one per tenant)? Or does BlackRock plan to centralize? Centralizing requires cross-project SSO. v1 assumes superadmins are configured per project — operationally simple, slightly redundant.
4. **Tool catalog endpoint auth.** The new `/admin/tool-catalog` GET endpoint should require an admin JWT. Confirm we want to add edge-function-level auth checking (currently the runtime does no JWT verification at the function boundary — the host's middleware does).

---

## 9. Delivery sequence (suggested for sprint planning)

Not part of the design ask but useful for kickoff. Approximate ordering, not estimates:

1. Extract `theme.ts` (brand tokens, hexA, BrandHeader, Toast) from agent-core; re-export. Bump version.
2. Migration 0008 (admin_users + RLS extensions + `active` on tenants).
3. Scaffold `packages/admin/` with build pipeline, dummy `<Admin />` rendering an "ok" page that proves the import boundary and bundle target.
4. Land the read-only RPCs (`admin_list_*`, `admin_overview_stats`, `admin_runs_timeseries`, `admin_get_run*`).
5. Build Overview + Usage + Runs list + Run Inspector against the read RPCs. Ship to internal staging.
6. Land mutation RPCs (`admin_create_tenant`, `admin_set_tool_enabled`, `admin_rotate_credential`, `admin_revoke_connection`, admin user mgmt).
7. Build Tenants list + Tenant Detail tabs + Settings.
8. Migration 0009 (org_settings + audit log) and wire the audit triggers.
9. End-to-end with Command Center as the first admin install. Brian uses it to retire `bootstrap-tenant.ts` from his SOP.

---

**End of design.**
