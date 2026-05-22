#!/usr/bin/env bash
# Agent Core — install into a client app. Run from the CLIENT repo root.
set -euo pipefail

echo "Installing Agent Core into: $(pwd)"
echo

bun add @blackrock/agent-core
echo "-> @blackrock/agent-core added (the shell)."
echo

echo "Remaining steps are environment-specific — run them yourself:"
echo
echo "  1. Copy migrations into this repo's Supabase project:"
echo "       cp node_modules/@blackrock/agent-schema/migrations/* supabase/migrations/"
echo
echo "  2. Push the schema:"
echo "       supabase db push"
echo
echo "  3. Add the Edge Function at supabase/functions/agent/index.ts"
echo "     (snippet below), then deploy it:"
echo "       supabase functions deploy agent"
echo
echo "  4. Set THIS client's own keys (their subscriptions, their bill):"
echo "       supabase secrets set ANTHROPIC_KEY=... OPENAI_KEY=..."
echo
echo "  5. Add a per-client config and render the shell — see"
echo "     examples/client-config.example.ts in blackrock-agent-core."
echo
echo "---- supabase/functions/agent/index.ts -----------------------------"
cat <<'SNIPPET'
import { createAgentHandler } from "npm:@blackrock/agent-runtime";

Deno.serve(createAgentHandler());
SNIPPET
echo "--------------------------------------------------------------------"
