# Sprint 6 — Runtime Changes (Design)

**Status:** Draft for review
**Package:** `@blackrock-ai/agent-runtime`
**Current version (prod):** `0.1.2` (tenant `blackrock` @ `gsvhuzpysxaegoecwjmf`)
**Target version:** `0.2.0`
**Author:** Runtime specialist
**Audience:** Sprint 6 parallel specialists (Metering, Security, Admin UX, DB Eng) + the
implementer who picks this up after design freeze.

---

## 0. Goals & non-goals

**In scope for the runtime in Sprint 6:**

1. Wire the per-tenant **rate limiter** designed by Security into the request path.
2. Wire the **quota** ceilings (max tokens/run, max runs/day) into the request path.
3. Compute and persist a **cost estimate** that the Metering team can roll up.
4. Emit an **audit event** for every sensitive operation that touches the runtime
   (run start with model/tenant, tool execution by name, finalize with cost).
5. Surface additional metadata (`runId`, `cost`, `tokens`, `duration_ms`) on SSE
   so Admin UX can render run-level dashboards from the stream.
6. Stay **wire-compatible** with shells still on `@blackrock-ai/agent-runtime@0.1.2`.

**Out of scope (owned elsewhere):**

- The shape of `usage_rollup` / `rate_limit_state` / `audit_log` tables — owned by
  DB Engineering. This doc describes what the runtime *writes*; the DDL lives in
  their migration 0008/0009.
- Cost source-of-truth for invoices — provider invoices remain authoritative;
  the runtime's `cost_estimate` is for dashboards.
- Admin UI components — owned by Admin UX.

---

## 1. New runtime modules (proposed)

Four new modules. Each is a thin, single-purpose file so it can be unit-tested in
isolation and so individual specialists can land work in parallel without merge
conflicts.

### 1.1 `packages/runtime/src/metering.ts`

**Purpose:** Convert raw token counts + provider + model into a USD cost estimate
and shape a row for the `usage_events` write. Owns the *price table* that
`model.ts` currently owns (extracted) and adds cache-aware pricing.

**Public API:**

```ts
export interface UsageBreakdown {
  tokensIn: number;
  tokensOut: number;
  // New in 0.2.0 — Anthropic prompt-cache stats. Optional so OpenAI calls
  // pass `undefined` and the math falls back to legacy pricing.
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface CostInputs extends UsageBreakdown {
  provider: ModelProvider;
  model: string;
}

export interface CostResult {
  cost: number;
  /** The matched price row's key. Empty string if no match. */
  priceKey: string;
  /** Per-component breakdown so dashboards don't have to back-derive. */
  components: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
}

export function estimateCost(input: CostInputs): CostResult;

/** Shape a usage_events row. Persistence writes the result. */
export interface UsageEvent {
  kind: "llm" | "tool";
  runId: string;
  tenantId: string;
  provider: string;        // anthropic | openai | hubspot | brave | ...
  model?: string;          // populated for kind:"llm"
  tool?: string;           // populated for kind:"tool"
  tokensIn: number;
  tokensOut: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  durationMs: number;
  occurredAt: string;      // ISO timestamp
  meta: Record<string, unknown>;
}

export function buildLlmUsageEvent(args: {
  runId: string;
  tenantId: string;
  call: ModelCallResult;          // from model.ts
  durationMs: number;
}): UsageEvent;

export function buildToolUsageEvent(args: {
  runId: string;
  tenantId: string;
  tool: string;
  provider: string;               // "hubspot" | "brave" | "internal"
  cost: number;
  durationMs: number;
  meta?: Record<string, unknown>;
}): UsageEvent;
```

**Dependencies:** `./model` (types only), `./types`. No DB calls. No network.

### 1.2 `packages/runtime/src/rate-limiter.ts`

**Purpose:** Check whether the tenant may start a new run, and increment the
sliding-window counter when one is accepted. Implementation defers to Security's
RPC (see §4) — the runtime never holds rate-limit state in memory.

**Public API:**

```ts
export type RateLimitDecision =
  | { allowed: true; remaining: number; resetSeconds: number }
  | { allowed: false; reason: "rate_limit"; retryAfterSeconds: number; limit: number; window: "minute" | "hour" | "day" };

export interface CheckRateLimitInput {
  tenantId: string;
  /** Logical operation — distinct buckets per operation in v0.2.0. */
  op: "run_start" | "tool_call";
  /** Cost units to deduct from the window. 1 for a run, N for a tool call. */
  weight?: number;
}

/**
 * Hits the `agent_core.check_rate_limit` RPC (DB Eng migration 0008). The RPC
 * is a single atomic UPSERT-and-increment over `agent_core.rate_limit_state`
 * so we never race between "read" and "write".
 *
 * Returns allowed:false WITHOUT throwing. The caller (handler) decides how to
 * surface that to the client.
 */
export function checkRateLimit(input: CheckRateLimitInput): Promise<RateLimitDecision>;

/**
 * Record that a run finished — releases any "reserved" tokens from the
 * sliding window. Best-effort. Called from finalizeRun path.
 */
export function settleRateLimit(input: {
  tenantId: string;
  runId: string;
  consumed: { tokensIn: number; tokensOut: number };
}): Promise<void>;
```

**Dependencies:** `./persistence` (for the shared `getSupabase()` helper —
extracted to a tiny `./_supabase.ts` so persistence and rate-limiter share one
cached client).

### 1.3 `packages/runtime/src/quota.ts`

**Purpose:** Enforce hard ceilings configured per tenant — distinct from
rate-limit because quota is *terminal* (you've hit your daily cap; come back
tomorrow) rather than *temporal* (back off, retry in 60s).

**Public API:**

```ts
export interface TenantQuota {
  maxTokensPerRun: number;     // 0 = unlimited
  maxRunsPerDay: number;       // 0 = unlimited
  maxCostPerDay: number;       // 0 = unlimited, USD
}

export type QuotaDecision =
  | { allowed: true; quota: TenantQuota; consumedToday: { runs: number; cost: number } }
  | { allowed: false; reason: "quota_exceeded"; metric: "runs_per_day" | "cost_per_day"; limit: number; consumed: number };

/**
 * Read the tenant's quota + today's usage rollup in ONE round-trip (a tiny
 * `agent_core.get_tenant_quota_state` RPC). Returns sane unlimited defaults
 * if no `tenant_quotas` row exists for that tenant.
 */
export function checkQuota(tenantId: string): Promise<QuotaDecision>;

/**
 * Mid-run guard. Called from the planner/synthesizer callsite (via callModel)
 * if `quota.maxTokensPerRun > 0` and the running total is about to cross it.
 * Throws a typed `QuotaExceededError` that the handler maps to `event: error`.
 */
export class QuotaExceededError extends Error {
  constructor(public metric: "tokens_per_run", public limit: number, public consumed: number);
}
```

**Dependencies:** `./_supabase.ts`.

### 1.4 `packages/runtime/src/audit.ts`

**Purpose:** Single funnel for audit events. Decouples the *what we log*
decision (here) from the *where it lands* decision (DB Eng's `audit_log`
table). Every call is fire-and-forget; failures never break a run.

**Public API:**

```ts
export type AuditAction =
  | "run.start"
  | "run.complete"
  | "run.failed"
  | "run.rate_limited"
  | "run.quota_exceeded"
  | "tool.execute"
  | "tool.denied"
  | "credential.resolved"
  | "connection.refreshed";

export interface AuditEvent {
  action: AuditAction;
  tenantId: string;
  runId?: string;
  /** Free-form structured metadata. Never include raw secrets, JWTs, tokens. */
  meta: Record<string, unknown>;
  /** Override timestamp for backfills. Defaults to now. */
  occurredAt?: string;
}

/** Best-effort write to agent_core.audit_log. Returns silently on failure. */
export function recordAudit(event: AuditEvent): Promise<void>;

/**
 * Batched variant — collects events for the duration of a run and flushes
 * once in finalizeRun. Reduces RPC pressure on chatty runs. Each run gets
 * its own collector via openAuditCollector().
 */
export interface AuditCollector {
  push(event: Omit<AuditEvent, "tenantId" | "runId">): void;
  flush(): Promise<void>;
}

export function openAuditCollector(tenantId: string, runId: string): AuditCollector;
```

**Dependencies:** `./_supabase.ts`.

### 1.5 Why not fewer modules?

A previous draft folded `rate-limiter.ts` + `quota.ts` into a single
`gating.ts`. Rejected because:

1. **Rate-limit state is hot** (every request, sub-second). **Quota state is
   cool** (read once per run). Separating them keeps the hot path narrowly
   testable and lets us add an in-process LRU to rate-limiter later without
   touching quota.
2. Security owns the rate-limit table schema; ops/billing owns the quota
   table. Two files = two clear PR owners.
3. The wire-level error responses differ (`429 + Retry-After` vs.
   `403 + remediation link`), so the call sites stay distinct anyway.

### 1.6 Why not more modules?

I considered an explicit `pricing.ts` separate from `metering.ts`. Folded the
price table into `metering.ts` because there is no second consumer: only the
metering layer needs prices, and externalizing pricing as configuration
(rather than a constant) is out of scope for Sprint 6.

---

## 2. `handler.ts` changes

### 2.1 New order of operations on the happy path

The current pipeline (313 lines) does:

```
parse body → context → recordRunStart → plan → execute → synthesize → critic → [correct] → final → finalizeRun
```

Sprint 6 inserts four new steps and re-orders one existing step:

```
parse body
  → check rate-limit  (NEW; before any DB hit other than the rate-limit RPC itself)
  → load context      (now in parallel with the quota read)
  → check quota
  → recordRunStart    (now also opens the audit collector)
  → audit: run.start
  → plan
  → audit: tool.execute (one per task)
  → execute
  → synthesize
  → critic
  → [correct]
  → emit final        (now includes cost, tokens, duration_ms, runId)
  → audit: run.complete + flush collector
  → finalizeRun       (now also settles rate-limit + writes usage_events)
```

**Rationale for the order:**

- **Rate-limit BEFORE context load.** Context load decrypts a Vault secret —
  expensive and pointless if we're going to 429 the request. Cost: one extra
  RPC, but `check_rate_limit` is designed to be sub-5ms.
- **Quota AFTER context load** (in parallel with it). Quota requires no
  decryption and can fan out alongside `loadTenantContext`. The pair waits on
  `Promise.all([loadTenantContext, checkQuota])`.
- **Audit collector opens before `recordRunStart`** so the run-start audit
  event is timestamped from the same clock as the run row.

### 2.2 Error path

The error path is the trickier surface. Three new failure modes:

| Failure | HTTP status | SSE event | finalizeRun called? | rate-limit settled? |
|---|---|---|---|---|
| Rate-limit deny | **200 + SSE** (`event: rate_limited`) | `rate_limited` + `error` + close | NO — no run was started | NO — nothing reserved |
| Quota deny | **200 + SSE** (`event: quota_exceeded`) | `quota_exceeded` + `error` + close | NO | NO |
| In-stream quota trip (tokens-per-run) | already 200 streaming | `error` with reason `quota_exceeded` | YES (status=`failed`, error=`quota_tokens_per_run`) | YES |
| Existing failures (unchanged) | 200 streaming | `error` | YES | YES |

**Why 200 + SSE for rate-limit deny rather than 429?** Backward compatibility.
Existing shells on `0.1.2` will retry on a hard 429 because they don't know
about `Retry-After`. Returning 200 + an SSE `rate_limited` event lets us
gracefully degrade: legacy clients see a final `error` event (same as today's
"internal error" path) while 0.2.0 clients see the typed `rate_limited` event
and can render a proper "try again in N seconds" UI.

A future 0.3.0 can flip to a real 429 once the entire fleet is on `0.2.0+`.

### 2.3 Backward compatibility (POST shape)

The POST body is **unchanged**: `{ tenantId, message, model? }`. Existing
shells on `0.1.2` continue to work without modification.

Additive headers (server emits, optional for client to read):

- `x-agent-event-schema: 2` — present on responses where new event types may
  appear. Absent on responses from 0.1.x or when the handler's compatibility
  flag is off.
- `x-agent-runtime-version: 0.2.0` — sent on every response for telemetry.

### 2.4 Pseudocode patch (sketch — not the final implementation)

```ts
// inside the ReadableStream start(controller)
const runStartedAt = Date.now();
const audit = openAuditCollector(tenantId, runId);

// 1. Rate-limit (before any other DB work)
const rl = await checkRateLimit({ tenantId, op: "run_start" });
if (!rl.allowed) {
  emit({ type: "rate_limited", retryAfterSeconds: rl.retryAfterSeconds, limit: rl.limit, window: rl.window });
  emit({ type: "error", message: "rate_limit" });
  await audit.push({ action: "run.rate_limited", meta: { window: rl.window, limit: rl.limit } });
  await audit.flush();
  closed = true; controller.close();
  return;
}

// 2. Context + quota in parallel
const [ctxBase, quota] = await Promise.all([
  resolveContext(tenantId, model, customLoad),   // existing 3-branch resolver, extracted
  checkQuota(tenantId),
]);
if (!quota.allowed) {
  emit({ type: "quota_exceeded", metric: quota.metric, limit: quota.limit, consumed: quota.consumed });
  emit({ type: "error", message: "quota_exceeded" });
  await audit.push({ action: "run.quota_exceeded", meta: quota });
  await audit.flush();
  closed = true; controller.close();
  return;
}
const ctx: RunContext = { ...ctxBase, quota: quota.quota, audit };

// 3. recordRunStart + audit
await recordRunStart({ ... });
audit.push({ action: "run.start", meta: { model: ctx.model, provider: ctx.modelProvider } });

// ... plan/execute/synthesize/critic UNCHANGED, except:
//   - addUsage now also accumulates cacheCreationTokens / cacheReadTokens
//   - executor receives ctx.audit so it can push tool.execute events
//   - executor receives a meter callback so tools can record provider costs

// 4. final event now richer
const durationMs = Date.now() - runStartedAt;
emit({
  type: "final",
  result,
  // NEW additive fields:
  runId, cost, tokens: { in: tokensIn, out: tokensOut, cacheCreation, cacheRead }, durationMs,
});

// 5. finalize
audit.push({ action: "run.complete", meta: { cost, tokensIn, tokensOut, durationMs } });
await Promise.all([
  finalizeRun({ ..., durationMs, cacheCreationTokens, cacheReadTokens }),
  settleRateLimit({ tenantId, runId, consumed: { tokensIn, tokensOut } }),
  audit.flush(),
]);
```

---

## 3. SSE event contract additions

### 3.1 New events

```ts
| { type: "rate_limited"; retryAfterSeconds: number; limit: number; window: "minute" | "hour" | "day" }
| { type: "quota_exceeded"; metric: "runs_per_day" | "cost_per_day" | "tokens_per_run"; limit: number; consumed: number }
| { type: "usage"; phase: "plan" | "execute" | "synthesize" | "critic" | "correct"; tokensIn: number; tokensOut: number; cacheCreationTokens?: number; cacheReadTokens?: number; cost: number }
```

The `usage` event is emitted after each LLM call so Admin UX can render a
running total without waiting for the `final` event. Subtypes:

- `phase` lets the UI attribute the cost to a pipeline stage.
- Cache fields are optional so OpenAI-served calls don't carry empty zeros.

### 3.2 Modified events

`event: final` gains four additive fields. Existing consumers ignore unknown
fields (verified — `parseSseFrame` JSON-parses the whole payload), so this is
a backward-compatible change:

```ts
| {
    type: "final";
    result: AgentResult;
    // NEW in 0.2.0 — all optional for backward compat:
    runId?: string;
    cost?: number;
    tokens?: {
      in: number;
      out: number;
      cacheCreation?: number;
      cacheRead?: number;
    };
    durationMs?: number;
  }
```

`event: tool_end` gains optional `costEstimate` and `durationMs` so per-tool
cost shows up alongside the result:

```ts
| {
    type: "tool_end";
    taskId: string;
    tool: string;
    ok: boolean;
    output: unknown;
    error?: string;
    // NEW:
    durationMs?: number;
    costEstimate?: number;     // 0 for built-in computation; non-zero for HubSpot, Brave, etc.
  }
```

### 3.3 Versioning strategy

We do **not** invent a runtime-internal event-schema version field on each
event. Instead:

- Add the additive fields to the existing `AgentEvent` discriminated union.
  Old clients deserialize them as ignored properties (the union's `extra`
  fields).
- Emit `x-agent-event-schema: 2` as a response header. New clients can opt in
  to handling `rate_limited`/`quota_exceeded`/`usage` events when present; old
  clients see the schema-1 events they already know.
- Add a `--schema=1` query-string flag on POST that *suppresses* the new
  events for clients that fail closed on unknown event types. (We don't have
  any such clients today, but it's cheap insurance for downstream consumers
  who built a strict-validating parser.)

Future versioning rule (codified in `events.ts` JSDoc): **additive only**
until 1.0. Removing an event type or required field requires a major version
bump on the runtime + a flag day across shells.

---

## 4. `persistence.ts` changes

### 4.1 New columns on `agent_runs`

DB Engineering writes the migration; the runtime writes these columns. New
additive columns (all nullable / sane defaults so 0.1.x runs in parallel
during the deploy window):

| Column | Type | Default | Set by |
|---|---|---|---|
| `cache_creation_tokens` | `int not null default 0` | 0 | `finalizeRun` |
| `cache_read_tokens` | `int not null default 0` | 0 | `finalizeRun` |
| `duration_ms` | `int` | null | `finalizeRun` |
| `tool_call_count` | `int not null default 0` | 0 | `finalizeRun` |
| `finish_reason` | `text` | null | `finalizeRun` (from final LLM call) |
| `rate_limit_decision` | `jsonb` | null | `recordRunStart` (snapshot of allow decision) |
| `quota_snapshot` | `jsonb` | null | `recordRunStart` (snapshot of quota state) |

### 4.2 New table writes

**`agent_core.usage_events`** (DB Eng owns the schema; the runtime writes the
following columns per event):

```sql
-- columns the runtime supplies on insert (DB Eng owns id/created_at):
tenant_id            uuid
run_id               uuid
kind                 text          -- 'llm' | 'tool'
provider             text          -- 'anthropic' | 'openai' | 'hubspot' | 'brave' | 'internal'
model                text          -- nullable; populated when kind='llm'
tool                 text          -- nullable; populated when kind='tool'
tokens_in            int
tokens_out           int
cache_creation_tokens int
cache_read_tokens    int
cost_estimate        numeric(12,6)
duration_ms          int
meta                 jsonb         -- arbitrary structured metadata
occurred_at          timestamptz
```

The runtime writes:

- **One row per LLM call** (so plan/synth/critic each get a row → 3+ rows per
  run typical, more if the corrector fires).
- **One row per tool execution** (so a 4-task graph → 4 rows).

These are the source-of-truth events; DB Eng's `usage_rollup` (if they ship
it) is computed from `usage_events` via a scheduled rollup or a materialized
view. The runtime is *event-sourced* on the write side; the runtime doesn't
write rollups directly.

**`agent_core.audit_log`** (DB Eng owns the schema). The runtime writes:

```sql
tenant_id   uuid
run_id      uuid          -- nullable for non-run audit events
action      text          -- 'run.start' | 'run.complete' | 'tool.execute' | ...
meta        jsonb
occurred_at timestamptz
```

Writes are batched via `openAuditCollector` and flushed once at run end. A
collector that holds N events does one `insert ... values (...), (...), ...`
instead of N round-trips.

### 4.3 Backward-compatible writes during the deploy window

The risk: for ~5-10s during a `supabase functions deploy` swap, both
`@0.1.2` (writing the old column set) and `@0.2.0` (writing the new column
set) may serve traffic concurrently.

Mitigations baked into persistence:

1. **All new columns have defaults**, so a 0.1.x `INSERT` that omits them
   succeeds. The new columns sit at 0 / null.
2. **All new column updates use `coalesce`** in the SQL so a partial update
   never NULLs a column that was just populated:
   ```ts
   .update({
     duration_ms: input.durationMs ?? undefined,
     cache_creation_tokens: input.usage.cacheCreationTokens ?? undefined,
     // ...
   })
   ```
   The `undefined` properties are stripped by supabase-js so they don't
   appear in the UPDATE SET list.
3. **New tables (`usage_events`, `audit_log`) are wrapped in a try/catch
   that swallows 42P01 "relation does not exist"** so a 0.2.0 runtime
   deployed before DB Eng's migration runs doesn't crash. (Cheap insurance;
   in practice we'll always run the migration before deploying the runtime.)

### 4.4 New `persistence.ts` public API

```ts
// existing exports unchanged

// NEW:
export interface RecordUsageEventInput {
  runId: string;
  tenantId: string;
  event: UsageEvent;     // from metering.ts
}
export function recordUsageEvent(input: RecordUsageEventInput): Promise<boolean>;

export interface RecordAuditBatchInput {
  tenantId: string;
  runId?: string;
  events: { action: AuditAction; meta: Record<string, unknown>; occurredAt?: string }[];
}
export function recordAuditBatch(input: RecordAuditBatchInput): Promise<number>;

// finalizeRun input grows additively:
export interface FinalizeRunInput {
  runId: string;
  tenantId: string;
  status: "completed" | "failed";
  usage: TokenUsage;
  taskGraph?: TaskGraph;
  error?: string;
  // NEW:
  durationMs?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  toolCallCount?: number;
  finishReason?: string;
}
```

---

## 5. `model.ts` changes

### 5.1 Capture more from LLM responses

**Anthropic** (`/v1/messages` response):

| Field | Current | 0.2.0 |
|---|---|---|
| `usage.input_tokens` | ✅ tokensIn | ✅ tokensIn |
| `usage.output_tokens` | ✅ tokensOut | ✅ tokensOut |
| `usage.cache_creation_input_tokens` | — | **NEW** cacheCreationTokens |
| `usage.cache_read_input_tokens` | — | **NEW** cacheReadTokens |
| `stop_reason` | — | **NEW** finishReason |
| `id` | — | **NEW** providerCallId (for cross-ref with Anthropic invoices) |

**OpenAI** (`/v1/chat/completions` response):

| Field | Current | 0.2.0 |
|---|---|---|
| `usage.prompt_tokens` | ✅ tokensIn | ✅ tokensIn |
| `usage.completion_tokens` | ✅ tokensOut | ✅ tokensOut |
| `usage.prompt_tokens_details.cached_tokens` | — | **NEW** cacheReadTokens (no separate creation count) |
| `system_fingerprint` | — | **NEW** systemFingerprint |
| `choices[0].finish_reason` | — | **NEW** finishReason |
| `id` | — | **NEW** providerCallId |

### 5.2 New `ModelCallResult` shape

```ts
export interface ModelCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;                              // kept for back-compat — see §5.3
  // NEW (all optional so the API stays additive):
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  finishReason?: string;
  systemFingerprint?: string;
  providerCallId?: string;
  durationMs?: number;                       // wall clock for the fetch
}
```

### 5.3 Cost computation — split between `model.ts` and `metering.ts`

**Recommendation:** Move cost computation entirely to `metering.ts`. Keep a
`cost` field on `ModelCallResult` for backward compatibility but have
`callModel` compute it by delegating to `metering.estimateCost`:

```ts
// model.ts (after the fetch + parse):
const cost = estimateCost({
  provider: opts.provider,
  model: opts.model,
  tokensIn,
  tokensOut,
  cacheCreationTokens,
  cacheReadTokens,
}).cost;
```

**Why split:**

- `model.ts` shouldn't own pricing — it's the network layer.
- `metering.ts` becomes the single test surface for cache discount math,
  provider-specific quirks (e.g., Anthropic cache-creation costs 1.25× input,
  cache-read costs 0.1× input).
- Callers that want richer cost data (`components` breakdown, `priceKey`) get
  it from `estimateCost` directly. The flattened `cost` number on
  `ModelCallResult` stays so existing call sites compile.

### 5.4 Streaming considerations (deferred)

`callModel` is currently non-streaming. Adding token-by-token streaming is
out of scope for Sprint 6 — Admin UX's needs (per-phase cost, running totals)
are met by the per-phase `usage` SSE event. A future Sprint can stream
individual model deltas; doing so requires the `usage` event to fire
mid-call, not after, which is a more invasive change.

---

## 6. `context.ts` changes

### 6.1 Should `loadTenantContext` also load rate-limit state?

**No.** Rate-limit state is checked *before* `loadTenantContext` even runs
(see §2.1). Folding it into the context loader would force the credential
decryption RPC to run even when we're about to 429 the request — exactly
what the new ordering avoids.

### 6.2 Should `loadTenantContext` also load quotas?

**No, but call them in parallel.** Quota state is needed at run-start time
and at mid-run guard points, so it belongs alongside the context. But it
doesn't *depend* on context resolution — they're independent reads. The
handler does:

```ts
const [ctxBase, quotaDecision] = await Promise.all([
  resolveContext(tenantId, model, customLoad),
  checkQuota(tenantId),
]);
```

This adds zero latency on the happy path (parallel) and keeps the two
concerns separate in test land.

### 6.3 Caching tenant context

Today: `loadTenantContext` does **three sequential DB ops** per request:

1. `select provider from tenant_credentials where tenant_id=?` (1 row)
2. `rpc resolve_tenant_secret(?, ?)` (Vault decrypt — slowest)
3. `select tool_key from tenant_tools where tenant_id=?` (N rows)

With rate-limit + quota adding `check_rate_limit` and `get_tenant_quota_state`,
we'd go from 3 to 5 round-trips per request. That's not catastrophic
(Supabase pooler keeps it warm), but it's worth a cache.

**Recommendation for 0.2.0 — a narrow, opt-in in-process cache:**

```ts
// context.ts
export interface TenantContextCache {
  ttlMs: number;                  // recommended: 30_000 (30s)
  /** What to cache. The API key is NEVER cached. */
  cacheTools: boolean;
  cacheProvider: boolean;
}

export function loadTenantContext(
  tenantId: string,
  model: string,
  cache?: TenantContextCache
): Promise<RunContext>;
```

**What we cache (safe):**

- The set of enabled tool keys → `tenant_tools` cache. Tools change rarely
  (admin UI mutation), and even a 60s stale cache is acceptable for a
  prototype.
- The resolved provider for `model=""` callers → `tenant_credentials.provider`
  cache.

**What we NEVER cache:**

- The decrypted API key. Always a fresh Vault round-trip per request. The
  audit story matters more than the latency saved.
- Rate-limit state or quota state. These must be authoritative per request.

**Default:** cache is **OFF** in 0.2.0. We add the plumbing and wire it
through `HandlerOptions.contextCache`, but ship with cache disabled and let
ops opt in once the rate-limit hit pattern is real production data.

### 6.4 New `RunContext` fields

```ts
export interface RunContext {
  tenantId: string;
  model: string;
  modelProvider: ModelProvider;
  apiKey: string;
  registry: ToolRegistry;
  // NEW:
  quota: TenantQuota;             // populated by handler after checkQuota
  audit: AuditCollector;          // populated by handler
  meter: (event: UsageEvent) => Promise<void>;  // populated by handler — see §8
}
```

These are passed through to the planner / executor / synthesizer / critic so
they can record usage and audit events without reaching for the handler.

---

## 7. The runtime client (`packages/shell/src/client.ts`) — what changes?

### 7.1 `createAgentClient` API

The `run()` method's return type doesn't change — still
`AsyncIterable<AgentEvent>`. The *new* event types (`rate_limited`,
`quota_exceeded`, `usage`) are added to the `AgentEvent` union exported from
`@blackrock-ai/agent-runtime`, so existing TypeScript consumers will see a
type-narrowing diff but no runtime break.

For consumers who want cost back from the run, the recommended pattern is to
listen for the `final` event:

```ts
for await (const event of client.run({ tenantId, message })) {
  if (event.type === "final" && event.cost !== undefined) {
    setRunCost(event.cost);
    setRunDuration(event.durationMs ?? 0);
  }
}
```

No new method on the client. We *considered* a `runWithResult()` helper that
returns a `Promise<{ events, final }>`, but that's a UX concern and belongs
in the shell's host app rather than the data layer.

### 7.2 New events the consumer should handle

The Admin UX team should add UI for:

| Event | UI |
|---|---|
| `rate_limited` | Inline toast: "Rate-limited. Retry in {retryAfterSeconds}s." with countdown. Disables the composer for the duration. |
| `quota_exceeded` | Block UI: "Daily quota reached." with link to billing settings. |
| `usage` | Running-total chip in the chat header. Updates on every `usage` event. |

The shell exposes a typed `AgentEvent` so missing cases are compile errors —
consumers who currently `switch (event.type)` without a `default` branch
will get a TS narrowing error when they upgrade. **That is intentional:**
unhandled new events should fail loudly at compile time, not silently at
runtime.

### 7.3 Backward-compatible additions only

`CreateAgentClientOptions` is unchanged. `RunInput` is unchanged. The only
breakage is the discriminated-union narrowing in `for await`, which is the
desired behavior.

---

## 8. Tool changes

### 8.1 Should built-in tools be metered?

**Yes.** A naïve "tools cost zero" model is fine for `data_query` and
`doc_generate` (they're SQL / template work), but it materially understates
the cost of:

- `web_search` (Brave) — flat per-query fee.
- `hubspot_query` — counted against the tenant's HubSpot API quota; if we
  want to enforce a *runtime-side* cap we need per-call accounting.
- `m365_mail` — same.
- `http_request` — could be anything; default to zero, let the tenant
  configure a per-host cost in `tenant_tools.config`.

### 8.2 The `meter` callback in `ToolContext`

Extend the `Tool` interface (in `@blackrock-ai/agent-tools`) so tools can
report per-call usage:

```ts
// packages/tools/src/registry.ts
export interface ToolMeter {
  (event: {
    /** Provider being billed — distinct from the tool key. */
    provider: string;        // 'hubspot' | 'brave' | 'm365' | 'internal'
    cost: number;            // USD; 0 if unknown
    durationMs: number;
    meta?: Record<string, unknown>;
  }): void;
}

export interface ToolContext {
  tenantId: string;
  /** NEW in 0.2.0. Optional — tools must tolerate it being undefined. */
  meter?: ToolMeter;
  [key: string]: unknown;
}
```

**Runtime wires it up** by populating `ctx.meter` per tool invocation in
`executor.ts`:

```ts
// executor.ts (inside the per-task try)
const startedAt = Date.now();
const output = await ctx.registry.run(t.tool, t.input, {
  tenantId: ctx.tenantId,
  meter: (event) => {
    ctx.meter(buildToolUsageEvent({
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      tool: t.tool,
      provider: event.provider,
      cost: event.cost,
      durationMs: event.durationMs,
      meta: event.meta,
    }));
  },
});
```

**Per-tool changes:**

- `web_search`: after the Brave call, `ctx.meter?.({ provider: "brave", cost: BRAVE_PER_QUERY, durationMs })`.
- `hubspot_query`: `ctx.meter?.({ provider: "hubspot", cost: 0, durationMs, meta: { resource, resultCount } })`. Cost is 0 because HubSpot charges per seat, not per call; the `meta` is still useful for the rate-limiter on the HubSpot side.
- `m365_mail`: same shape.
- `data_query` / `doc_generate` / `http_request`: opt-in. Skip in 0.2.0 unless a tenant asks.

### 8.3 Or infer from `agent_messages`?

Considered. Rejected because:

- `agent_messages` already exists and carries the tool name, but doesn't
  carry duration or provider. We'd still need to add columns.
- `agent_messages` is debug-grade, not billing-grade — it can be missing on
  best-effort failure. `usage_events` should be a separate stream that
  metering can rely on.
- The `meter` callback is the same pattern as the LLM-call instrumentation in
  `callModel`, so the surface stays symmetric.

### 8.4 Backward compatibility for the tools package

`ctx.meter` is optional. Tools that don't call it (including any third-party
tools tenants register via custom registries) continue to work — they just
won't show up in `usage_events` with `kind='tool'`. The runtime will still
write a synthetic `kind='tool', provider='internal', cost=0` event per tool
call so the usage stream has a complete picture.

---

## 9. New tests

### 9.1 Unit tests

| File | What it tests |
|---|---|
| `__tests__/metering.test.ts` | `estimateCost` math: per-provider price rows, longest-prefix match, cache discount (Anthropic 1.25× create / 0.1× read), unknown model → cost 0. |
| `__tests__/metering.test.ts` | `buildLlmUsageEvent` shape with and without cache fields. |
| `__tests__/rate-limiter.test.ts` | Mock the `check_rate_limit` RPC to return: allow with remaining=N, deny with retryAfter, RPC error → fail-open (allow with a logged error — Security team to confirm fail-open vs fail-closed). |
| `__tests__/rate-limiter.test.ts` | Sliding-window race: 10 concurrent `checkRateLimit` calls against a mock that increments a counter; assert at most `limit` succeed. (Tests our concurrency assumptions, not Postgres's — the RPC is authoritative; this test pins down the runtime's behavior when the RPC happens to return parallel allow decisions.) |
| `__tests__/quota.test.ts` | `checkQuota` returns `unlimited` for missing rows. `QuotaExceededError` formats. |
| `__tests__/audit.test.ts` | `openAuditCollector` batches, flushes once, swallows DB errors. |
| `__tests__/events.test.ts` (extend) | Round-trip the three new event types (`rate_limited`, `quota_exceeded`, `usage`). |

### 9.2 Integration test — "tenant hits rate limit mid-stream"

New file: `__tests__/handler-rate-limit.integration.test.ts`.

Spins up the handler with a mock `checkRateLimit` and a mock `loadTenantContext`.

**Test 1 — denial before context load:**

- `checkRateLimit` returns `{ allowed: false, retryAfter: 30, ... }`.
- Assert: response is 200, SSE stream contains exactly two frames
  (`rate_limited`, `error`), `loadTenantContext` is **never called**,
  `finalizeRun` is **never called**.

**Test 2 — tokens-per-run quota tripped mid-pipeline:**

- `loadTenantContext` returns a normal ctx with `quota.maxTokensPerRun=1000`.
- Mock `callModel` to return 800 tokens on plan + 800 tokens on synthesize.
- Assert: after synthesize, the handler emits `event: error` with
  `quota_exceeded`, calls `finalizeRun` with `status='failed'` and
  `error='quota_tokens_per_run'`, and `settleRateLimit` is still called.

**Test 3 — happy path produces a `usage` event per phase:**

- Assert: stream contains `usage` events with `phase` set to `plan`,
  `synthesize`, `critic` in that order.
- Assert: the `final` event's `cost` equals the sum of the `usage` event
  costs (within 1e-9 USD).

### 9.3 What we are explicitly *not* testing

- End-to-end DB writes: those are exercised by
  `packages/schema/scripts/verify-streaming.ts` and the live
  `verify-persistence-live.sh`. We won't duplicate them in unit tests.
- The DB-side rate-limit RPC itself: owned by Security + DB Eng.
- Cache hit accuracy against real Anthropic responses: covered by a manual
  smoke test in the runbook, not CI.

---

## 10. Version bump

### 10.1 Runtime version: `0.1.2` → `0.2.0`

**Minor (not patch)** because:

- New SSE event types in the `AgentEvent` union.
- New fields on `final` / `tool_end`.
- New exports from the package (`metering`, `rate-limiter`, `quota`, `audit`).
- New optional field on `ToolContext` (technically additive but consumed by
  tooling).

No breaking changes — additive only — so semver minor is correct.

### 10.2 Lockstep with other packages

Recommended bumps for Sprint 6:

| Package | From | To | Reason |
|---|---|---|---|
| `@blackrock-ai/agent-runtime` | 0.1.2 | **0.2.0** | This doc. |
| `@blackrock-ai/agent-tools` | 0.1.x | **0.2.0** | `ToolContext.meter` is additive but the typed interface change warrants a minor bump. Tools depending on the meter wire-up must declare `>= 0.2.0`. |
| `@blackrock-ai/agent-core` (shell) | 0.1.x | **0.2.0** | Re-exports `AgentEvent` with new types; consumers' `switch` blocks will warn. |
| `@blackrock-ai/agent-schema` | — | **0.2.0** | New migrations 0008 (rate_limit_state), 0009 (usage_events), 0010 (audit_log), 0011 (tenant_quotas). DB Eng confirms numbering. |

**Recommend a coordinated `0.2.0` release across all four packages**
(documented in the Sprint 6 release runbook). Reason: the new SSE events
require all-of-runtime + all-of-shell to be on `0.2.0` for the Admin UX
features to light up. Mixing `runtime@0.2.0` with `shell@0.1.x` works
(forward-compatible: shell ignores the new fields) but no new UX appears
until the shell also upgrades.

### 10.3 Deprecation policy for `0.1.x`

**Yes — 6-month support window.** Concretely:

- `0.1.x` continues to receive security patches until **2026-11-24**.
- New tenants installed after `0.2.0` GA get `0.2.0`.
- Existing tenants (BlackRock currently) stay on `0.1.2` until they're ready
  to upgrade. The DB-side migration is forward-compatible (additive
  columns), so we can apply migrations 0008-0011 to BlackRock's DB and leave
  the Edge Function on `0.1.2` for as long as they want.
- `0.1.x` does **not** get any of the Sprint 6 features back-ported. If a
  tenant wants rate-limiting they upgrade.

---

## 11. Migration path for existing tenants

### 11.1 BlackRock on `0.1.2` — what happens when we install `0.2.0`?

**The DB side migrates first.** DB Eng's migrations 0008-0011 apply against
BlackRock's existing Supabase project (the same `gsvhuzpysxaegoecwjmf`).
After migration:

- `agent_runs` gains the new nullable columns (`cache_creation_tokens`,
  `duration_ms`, etc.) — existing rows have them at default 0 / null.
  Existing dashboards on `agent_runs` keep working.
- `rate_limit_state`, `usage_events`, `audit_log`, `tenant_quotas` tables
  exist but are empty. No tenant has a `tenant_quotas` row → `checkQuota`
  returns "unlimited" for everyone. No tenant has a `rate_limit_state` row →
  `check_rate_limit` upserts on first call and allows by default.
- `agent_core.check_rate_limit` and `agent_core.get_tenant_quota_state` RPCs
  exist. The `0.1.2` runtime doesn't call them, so they sit unused.

**The runtime swaps second.** `supabase functions deploy agent` ships
`@0.2.0`. During the 5-10s deploy swap:

- In-flight `0.1.2` requests finish using the old code. They write to the
  new columns at default (0 / null). Safe.
- New requests hit `0.2.0`. They call `check_rate_limit` → no row → upsert +
  allow. They call `get_tenant_quota_state` → no row → unlimited. They run.

**Net effect for BlackRock:** zero feature change until an admin explicitly
populates `tenant_quotas` for them. Rate-limit is enforced from the first
0.2.0 request, but with the default infinite-quota policy it never denies.

### 11.2 Configuring rate limits for BlackRock

Two paths:

1. **Permissive bootstrap (recommended):** ship `0.2.0` with no
   `tenant_quotas` row for BlackRock. Allows them to validate the new SSE
   events without operational risk. Add a quota row later via the admin UI
   when we're confident in the rollup numbers.
2. **Conservative bootstrap:** insert a `tenant_quotas` row at
   migration-apply time with generous defaults (`runs_per_day=10000`,
   `cost_per_day=100.00`, `tokens_per_run=200000`). Catches a runaway loop
   but won't bite normal use.

Recommend (1) for BlackRock specifically, given they're our only production
tenant. New tenants installed post-0.2.0 should default to (2) — the
`cli/install.sh` script can seed a row.

### 11.3 Backfilling rollups for existing `agent_runs`

**Yes, but with caveats.**

`usage_events` is event-sourced going forward. Pre-0.2.0 runs have no
per-call data — only the aggregate in `agent_runs.tokens_in` /
`tokens_out` / `cost_estimate`. The backfill plan:

- DB Eng writes a one-shot migration script that, for each existing
  `agent_runs` row, inserts a single synthetic `usage_events` row with
  `kind='llm'`, `provider=agent_runs.model_provider`, `model=agent_runs.model`,
  the aggregate tokens, and `meta = { backfilled: true }`.
- This loses per-phase granularity (plan vs synth) but preserves cost
  totals for historical dashboards.
- The backfill is **idempotent** (keyed on `(run_id, meta->>'backfilled')`)
  so re-running it doesn't duplicate.
- Skip the backfill for `agent_runs.status = 'running'` and for runs older
  than 90 days (DB Eng's call on the retention window).

The runtime is **not involved** in the backfill — it's a DB-side script.

### 11.4 Rollback plan

If `0.2.0` misbehaves in production, the rollback is:

1. `supabase functions deploy agent` with the pinned `@0.1.2` bundle.
2. Leave the migrations in place. `0.1.2` doesn't write to the new columns
   but doesn't crash on them either (they have defaults).
3. New tables (`rate_limit_state`, `usage_events`, etc.) sit unused. No
   harm.

The rollback window is bounded by the standard Supabase Edge Function
deploy time (~10s). No data is lost; the new tables simply stop accruing
rows until `0.2.0` is redeployed.

---

## Appendix A — File-by-file change summary

| File | Change | LoC delta (est.) |
|---|---|---|
| `packages/runtime/src/handler.ts` | Insert rate-limit + quota + audit hooks; expand `final` event | +120 / -10 |
| `packages/runtime/src/context.ts` | Optional cache plumbing; emit audit on credential resolve | +60 / -5 |
| `packages/runtime/src/model.ts` | Surface cache + finishReason; delegate cost to metering | +40 / -20 |
| `packages/runtime/src/persistence.ts` | New columns; new `recordUsageEvent`; new `recordAuditBatch` | +80 / -0 |
| `packages/runtime/src/events.ts` | New event union members | +30 / -0 |
| `packages/runtime/src/executor.ts` | Wire `meter` callback per tool; emit `tool_end.durationMs` | +20 / -2 |
| `packages/runtime/src/types.ts` | `RunContext` gains quota / audit / meter / runId | +10 / -0 |
| `packages/runtime/src/index.ts` | Re-export new modules | +20 / -0 |
| `packages/runtime/src/metering.ts` | **NEW** | +180 |
| `packages/runtime/src/rate-limiter.ts` | **NEW** | +90 |
| `packages/runtime/src/quota.ts` | **NEW** | +110 |
| `packages/runtime/src/audit.ts` | **NEW** | +120 |
| `packages/runtime/src/_supabase.ts` | **NEW** — extracted client cache | +30 |
| `packages/runtime/src/__tests__/metering.test.ts` | **NEW** | +200 |
| `packages/runtime/src/__tests__/rate-limiter.test.ts` | **NEW** | +180 |
| `packages/runtime/src/__tests__/quota.test.ts` | **NEW** | +120 |
| `packages/runtime/src/__tests__/audit.test.ts` | **NEW** | +90 |
| `packages/runtime/src/__tests__/handler-rate-limit.integration.test.ts` | **NEW** | +260 |
| `packages/runtime/src/__tests__/events.test.ts` | Add 3 new event round-trips | +40 |
| `packages/tools/src/registry.ts` | `ToolContext.meter` optional callback | +12 |
| `packages/tools/src/builtins/web-search.ts` | Call `ctx.meter` after Brave fetch | +8 |
| `packages/tools/src/builtins/hubspot-query.ts` | Call `ctx.meter` after HubSpot fetch | +8 |
| `packages/tools/src/builtins/m365-mail.ts` | Call `ctx.meter` after Graph send | +8 |
| `packages/shell/src/client.ts` | No code change (union expansion is transitive) | 0 |

Approx total: **+1,756 / -37 LoC** across 24 files.

---

## Appendix B — Open questions for parallel specialists

1. **Security:** Should `checkRateLimit` fail open or fail closed when the RPC errors? Default in this design is fail-open (logged). Confirm.
2. **Security:** Audit log retention — does the audit table get a TTL? If yes, the runtime needs to know nothing; if no, ops needs a manual cleanup job. Confirm.
3. **Metering:** Cache discount math — Anthropic publishes 1.25× input cost for cache *creation* and 0.1× input cost for cache *read*. Should `metering.ts` hard-code those multipliers or read them from the price table? Recommend hard-code; revisit if a future provider differs.
4. **Admin UX:** Do you want a `usage` event per LLM call (current proposal — emits 3-5 per run), or a single `usage` event emitted at the end with all phases? Per-call is more granular but chattier on the wire.
5. **DB Eng:** Migration numbering — Sprint 6 needs four new migrations (0008-0011 by current numbering). Confirm.
6. **DB Eng:** Should `usage_events.meta` be a `jsonb` or a `jsonb not null default '{}'`? Recommend the latter so the runtime can always insert without a null-check.

---

**End of design.**
