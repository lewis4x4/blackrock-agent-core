# blackrock-agent-core

The reusable AI workspace that gets embedded into every BlackRock AI client app.

**This repo is a package library, not an application.** Nothing here deploys
on its own, has a URL, or has users. It is built once, published, and imported
into client apps (QEP OS, Redex, Lewis Insurance, Circle of Life...). The
client app is the application; Agent Core is a part that lives inside it.

## Packages

| Package | Name | What it is |
|---|---|---|
| `packages/shell` | `@blackrock/agent-core` | The React workspace shell — the embeddable AI command-center UI. |
| `packages/runtime` | `@blackrock/agent-runtime` | The orchestrator — planner → executor → synthesizer → critic. Deploys into the client's own Supabase Edge Functions. |
| `packages/tools` | `@blackrock/agent-tools` | Tool registry + built-in tools. The orchestrator dispatches to these. |
| `packages/schema` | `@blackrock/agent-schema` | SQL migrations for the `agent_*` tables. Applied into each client's own Supabase project. |

## Layout

```
blackrock-agent-core/
├── packages/
│   ├── shell/      @blackrock/agent-core      <Workspace/> + config types
│   ├── runtime/    @blackrock/agent-runtime    createAgentHandler() + the loop
│   ├── tools/      @blackrock/agent-tools      ToolRegistry + builtins
│   └── schema/     @blackrock/agent-schema     agent_* migrations
├── cli/install.sh   wires Agent Core into a client repo
└── examples/        sample per-client config
```

## Build

```bash
bun install
bun run build
```

## Publish (order matters — dependents last)

```bash
cd packages/tools   && npm publish
cd packages/schema  && npm publish
cd packages/runtime && npm publish
cd packages/shell   && npm publish
```

## Install into a client app

Run from the client repo root:

```bash
bash path/to/cli/install.sh
```

Or manually:

```bash
bun add @blackrock/agent-core
cp node_modules/@blackrock/agent-schema/migrations/* supabase/migrations/
supabase db push
# add supabase/functions/agent/index.ts (see cli/install.sh snippet)
supabase functions deploy agent
supabase secrets set ANTHROPIC_KEY=...
```

## Add a new client

There is no code change to Agent Core. The client repo gets one config file
(see `examples/client-config.example.ts`) and renders `<Workspace config={...}/>`.
The "Connected" category in that config is the client's own subscriptions.

## What is real vs. Sprint 1

Real and complete in this scaffold: the shell UI, the `agent_*` schema with RLS,
the orchestrator control flow (plan → execute → synthesize → critique), the
multi-model call layer, the tool registry, and the `http_request` built-in tool.

Marked `SPRINT 1` in the code: per-tenant credential loading from Supabase Vault
(currently falls back to env vars), the full built-in tool catalog, and response
streaming. These are the first build sprint, not the scaffold.
