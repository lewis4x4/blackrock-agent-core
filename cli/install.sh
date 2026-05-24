#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY_RUN=false
SKIP_VERIFY=false
SOFT_VERIFY=false
ASSUME_EXPOSED=false
REQUIRE_ANON_KEY=false
CONFIG_PATH="$SCRIPT_DIR/install.config"

is_rerun() {
  [[ -f "$TARGET_REPO/.agent-core-install/install-manifest.json" ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-verify)
      SKIP_VERIFY=true
      shift
      ;;
    --soft-verify)
      SOFT_VERIFY=true
      shift
      ;;
    --config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --assume-exposed)
      ASSUME_EXPOSED=true
      shift
      ;;
    --require-anon-key)
      REQUIRE_ANON_KEY=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

step() {
  echo "==> [$1/12] $2"
}

step 1 "Load config"
[[ -f "$CONFIG_PATH" ]] || { echo "Missing config: $CONFIG_PATH" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG_PATH"

required_vars=(TARGET_REPO TENANT_SLUG SUPABASE_PROJECT_REF TARGET_WEB_DIR MIGRATION_STYLE)
for var_name in "${required_vars[@]}"; do
  [[ -n "${!var_name:-}" ]] || { echo "Missing required variable in config: $var_name" >&2; exit 1; }
done

INSTALL_DIR="$TARGET_REPO/.agent-core-install"
MANIFEST_PATH="$INSTALL_DIR/install-manifest.json"
MIGRATIONS_MANIFEST_PATH="$INSTALL_DIR/migrations-manifest.json"

RERUN=false
if is_rerun; then
  RERUN=true
fi
prepared_new_files=false

step 2 "Preflight"
if [[ "$DRY_RUN" == "true" ]]; then
  "$SCRIPT_DIR/preflight.sh" --dry-run --config "$CONFIG_PATH"
else
  "$SCRIPT_DIR/preflight.sh" --config "$CONFIG_PATH"
fi

# Resolve the directory where `npm install` should run: nearest package.json
# walking up from $TARGET_REPO/$TARGET_WEB_DIR toward $TARGET_REPO. This
# handles both root-level package.json (e.g. Next.js at repo root) and
# nested layouts (e.g. apps/web/package.json, or Vite under web/).
resolve_pkg_install_dir() {
  local web_abs="$TARGET_REPO/$TARGET_WEB_DIR"
  local cur="$web_abs"
  while [[ "$cur" != "$TARGET_REPO" && "$cur" != "/" ]]; do
    if [[ -f "$cur/package.json" ]]; then
      echo "$cur"
      return 0
    fi
    cur=$(dirname "$cur")
  done
  if [[ -f "$TARGET_REPO/package.json" ]]; then
    echo "$TARGET_REPO"
    return 0
  fi
  echo "ERROR: no package.json found between $web_abs and $TARGET_REPO" >&2
  return 1
}
PKG_INSTALL_DIR=$(resolve_pkg_install_dir)

step 3 "Configure target .npmrc"
# Place .npmrc next to the package.json where the install actually runs.
# (npm/bun/pnpm read .npmrc from cwd upward; co-locating with package.json
#  is the predictable, idiomatic location.)
NPMRC_PATH="$PKG_INSTALL_DIR/.npmrc"
REGISTRY_LINE="@blackrock-ai:registry=https://npm.pkg.github.com"
TOKEN_LINE='//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}'
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] ensure lines exist in $NPMRC_PATH"
else
  mkdir -p "$(dirname "$NPMRC_PATH")"
  touch "$NPMRC_PATH"
  grep -qxF "$REGISTRY_LINE" "$NPMRC_PATH" || echo "$REGISTRY_LINE" >> "$NPMRC_PATH"
  grep -qxF "$TOKEN_LINE" "$NPMRC_PATH" || echo "$TOKEN_LINE" >> "$NPMRC_PATH"
fi

step 4 "Install packages in target"
pkgs=(
  "@blackrock-ai/agent-core"
  "@blackrock-ai/agent-runtime"
  "@blackrock-ai/agent-tools"
  "@blackrock-ai/agent-schema"
)

declare -a INSTALL_CMD
if [[ -f "$PKG_INSTALL_DIR/bun.lock" ]]; then
  INSTALL_CMD=(bun add "${pkgs[@]}")
elif [[ -f "$PKG_INSTALL_DIR/pnpm-lock.yaml" ]]; then
  INSTALL_CMD=(pnpm add "${pkgs[@]}")
elif [[ -f "$PKG_INSTALL_DIR/package-lock.json" ]]; then
  INSTALL_CMD=(npm install "${pkgs[@]}")
elif [[ -f "$PKG_INSTALL_DIR/yarn.lock" ]]; then
  INSTALL_CMD=(yarn add "${pkgs[@]}")
else
  if command -v bun >/dev/null 2>&1; then
    INSTALL_CMD=(bun add "${pkgs[@]}")
  elif command -v pnpm >/dev/null 2>&1; then
    INSTALL_CMD=(pnpm add "${pkgs[@]}")
  elif command -v npm >/dev/null 2>&1; then
    INSTALL_CMD=(npm install "${pkgs[@]}")
  elif command -v yarn >/dev/null 2>&1; then
    INSTALL_CMD=(yarn add "${pkgs[@]}")
  else
    echo "No supported package manager found (bun/pnpm/npm/yarn)" >&2
    exit 1
  fi
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] cd '$PKG_INSTALL_DIR' && ${INSTALL_CMD[*]}"
else
  (
    cd "$PKG_INSTALL_DIR"
    "${INSTALL_CMD[@]}"
  )
fi

step 5 "Prepare migrations"
if [[ "$DRY_RUN" != "true" ]]; then
  mkdir -p "$INSTALL_DIR"
fi
PM_ARGS=(--style "$MIGRATION_STYLE" --target-dir "$TARGET_REPO/supabase/migrations" --out "$MIGRATIONS_MANIFEST_PATH")
if [[ "$DRY_RUN" == "true" ]]; then
  PM_ARGS+=(--dry-run)
  if [[ "$MIGRATION_STYLE" == "supabase_timestamp" ]]; then
    PM_ARGS+=(--timestamp-seed 1700000000000)
  fi
fi

if [[ "$RERUN" == "true" ]]; then
  rerun_meta="$(python3 - "$MANIFEST_PATH" "$REPO_ROOT/packages/schema/migrations" <<'PY'
import json
import re
import sys
from pathlib import Path

manifest = Path(sys.argv[1])
source_dir = Path(sys.argv[2])

data = json.loads(manifest.read_text())
mappings = data.get("migrationsApplied") or []
applied_from = sorted({m.get("from") for m in mappings if isinstance(m, dict) and m.get("from")})

source_files = sorted(
    [p.name for p in source_dir.glob("*.sql") if re.match(r"^\d+_", p.name)],
    key=lambda n: int(re.match(r"^(\d+)_", n).group(1)),
)

pending = [name for name in source_files if name not in set(applied_from)]
print("PENDING=" + ",".join(pending))
print("APPLIED=" + "\n".join(applied_from))
PY
  )"

  pending_sources="$(printf '%s\n' "$rerun_meta" | awk -F= '/^PENDING=/{print $2}')"
  applied_sources="$(printf '%s\n' "$rerun_meta" | awk 'BEGIN{seen=0} /^APPLIED=/{seen=1; sub(/^APPLIED=/,""); print; next} seen{print}')"

  if [[ -z "$pending_sources" ]]; then
    echo "All Agent Core migrations already in target; nothing to prepare"
    prepared_new_files=false
  else
    if [[ -n "$applied_sources" ]]; then
      PM_ARGS+=(--applied-source-basenames "$applied_sources")
    fi
    SUPABASE_PROJECT_REF="$SUPABASE_PROJECT_REF" TARGET_REPO="$TARGET_REPO" bun "$SCRIPT_DIR/prepare-migrations.ts" "${PM_ARGS[@]}"
    prepared_new_files=true
  fi
else
  SUPABASE_PROJECT_REF="$SUPABASE_PROJECT_REF" TARGET_REPO="$TARGET_REPO" bun "$SCRIPT_DIR/prepare-migrations.ts" "${PM_ARGS[@]}"
  prepared_new_files=true
fi

step 6 "Apply migrations"
if [[ "$prepared_new_files" != "true" ]]; then
  echo "No new Agent Core migrations prepared; skipping supabase db push"
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] cd '$TARGET_REPO' && supabase db push"
else
  (
    cd "$TARGET_REPO"
    supabase db push
  )
fi

step 7 "Register agent_core in PostgREST exposed schemas"
CONFIG_TOML="$TARGET_REPO/supabase/config.toml"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] would edit $CONFIG_TOML [api].schemas to include \"agent_core\""
elif [[ ! -f "$CONFIG_TOML" ]]; then
  echo "NOTE: $CONFIG_TOML does not exist (host project doesn't use a local supabase config.toml)."
  echo "The dashboard exposed-schemas setting is the only place 'agent_core' needs to be added."
  echo "Manual dashboard step required: https://supabase.com/dashboard/project/$SUPABASE_PROJECT_REF/settings/api"
else
  python3 - "$CONFIG_TOML" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
api_match = re.search(r"(?ms)^\[api\]\n(.*?)(?=^\[|\Z)", text)
if not api_match:
    raise SystemExit("[api] section not found in supabase/config.toml")
api_block = api_match.group(1)
schemas_match = re.search(r'^schemas\s*=\s*\[(.*?)\]\s*$', api_block, re.M | re.S)
if not schemas_match:
    raise SystemExit("schemas = [...] line not found under [api]")
inner = schemas_match.group(1)
items = [i.strip().strip('"') for i in inner.split(',') if i.strip()]
if "agent_core" not in items:
    items.append("agent_core")
replacement = 'schemas = [' + ', '.join(f'"{i}"' for i in items) + ']'
start, end = schemas_match.span()
new_api_block = api_block[:start] + replacement + api_block[end:]
new_text = text[:api_match.start(1)] + new_api_block + text[api_match.end(1):]
path.write_text(new_text)
PY
fi
echo "Manual dashboard step required: add agent_core in Exposed schemas at https://supabase.com/dashboard/project/$SUPABASE_PROJECT_REF/settings/api"
if [[ "$ASSUME_EXPOSED" == "true" ]]; then
  echo "Assuming exposed-schema step already complete (--assume-exposed)."
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] would prompt operator to confirm exposed-schema step"
else
  read -r -p "Have you added 'agent_core' to Settings > API > Exposed schemas for project $SUPABASE_PROJECT_REF? [y/N]: " confirm_exposed
  case "${confirm_exposed,,}" in
    y|yes)
      ;;
    *)
      echo "Cannot proceed without exposed-schema confirmation. Re-run after completing the dashboard step." >&2
      exit 1
      ;;
  esac
fi

step 8 "Deploy agent Edge Function"
FUNCTION_DIR="$TARGET_REPO/supabase/functions/agent"
FUNCTION_PATH="$FUNCTION_DIR/index.ts"
# Prefer the self-contained Deno bundle (dist/edge.js); fall back to dist/index.js
# for older runtime versions (<0.1.2). The edge bundle inlines all sub-deps
# (@supabase/supabase-js, @blackrock-ai/agent-tools, etc.) so Deno Deploy can
# bundle the function without resolving anything from GitHub Packages.
RUNTIME_EDGE_SRC="$PKG_INSTALL_DIR/node_modules/@blackrock-ai/agent-runtime/dist/edge.js"
RUNTIME_INDEX_SRC="$PKG_INSTALL_DIR/node_modules/@blackrock-ai/agent-runtime/dist/index.js"
RUNTIME_BUNDLE_DST="$FUNCTION_DIR/agent-runtime.js"
FUNCTION_CONTENT='// Auto-generated by Agent Core installer. Do not edit by hand.
//
// Imports the runtime from a sibling bundle (copied from
// node_modules/@blackrock-ai/agent-runtime/dist/edge.js — the Deno-targeted
// self-contained bundle) because Deno Deploy cannot auth to GitHub Packages.
// @ts-ignore — relative .js import resolves at deploy time.
import { createAgentHandler } from "./agent-runtime.js";
Deno.serve(createAgentHandler());
'
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] would write $FUNCTION_PATH"
  echo "[dry-run] would copy runtime bundle (edge): $RUNTIME_EDGE_SRC -> $RUNTIME_BUNDLE_DST"
  echo "[dry-run] would run: cd '$TARGET_REPO' && supabase functions deploy agent"
else
  mkdir -p "$FUNCTION_DIR"
  printf "%s" "$FUNCTION_CONTENT" > "$FUNCTION_PATH"
  if [[ -f "$RUNTIME_EDGE_SRC" ]]; then
    cp "$RUNTIME_EDGE_SRC" "$RUNTIME_BUNDLE_DST"
    echo "Copied runtime edge bundle: $RUNTIME_BUNDLE_DST ($(wc -c < "$RUNTIME_BUNDLE_DST") bytes)"
  elif [[ -f "$RUNTIME_INDEX_SRC" ]]; then
    cp "$RUNTIME_INDEX_SRC" "$RUNTIME_BUNDLE_DST"
    echo "WARNING: edge bundle (dist/edge.js) not found; fell back to dist/index.js."
    echo "         The deployed function will fail at Deno bundle time because the"
    echo "         externalized deps (@supabase/supabase-js, etc.) cannot resolve."
    echo "         Upgrade to @blackrock-ai/agent-runtime@^0.1.2 for the edge bundle."
  else
    echo "WARNING: neither edge nor index bundle found at $RUNTIME_EDGE_SRC / $RUNTIME_INDEX_SRC"
    echo "Edge Function deploy will fail. Run \`bun install\` (or your pkg manager's install) inside $PKG_INSTALL_DIR first."
  fi
  if (
    cd "$TARGET_REPO"
    supabase functions deploy agent
  ); then
    echo "Edge Function deployed: agent"
  else
    echo "WARNING: supabase functions deploy failed. Check the output above."
    echo "You can re-deploy manually with: cd '$TARGET_REPO' && supabase functions deploy agent"
  fi
fi

step 9 "Scaffold config + mount snippet"
if [[ "$DRY_RUN" == "true" ]]; then
  bun "$SCRIPT_DIR/mount-shell.ts" --dry-run --config "$CONFIG_PATH"
else
  bun "$SCRIPT_DIR/mount-shell.ts" --config "$CONFIG_PATH"
fi

# Step 10 uses supabase-js/PostgREST and depends on agent_core being exposed in API settings.
# The prompt above gates progression so verify runs only after operator confirmation (or --assume-exposed).
step 10 "Run verify scripts against target"
verify_scripts=(
  "packages/schema/scripts/verify-isolation.ts"
  "packages/schema/scripts/verify-connections.ts"
  "packages/schema/scripts/verify-streaming.ts"
  "packages/schema/scripts/verify-tools.ts"
)

if [[ "$SKIP_VERIFY" == "true" ]]; then
  echo "Skipping verify scripts (--skip-verify)."
elif [[ "$DRY_RUN" == "true" ]]; then
  if [[ -z "${SUPABASE_ANON_KEY:-}" ]]; then
    if [[ "$REQUIRE_ANON_KEY" == "true" ]]; then
      echo "ERROR: SUPABASE_ANON_KEY not set and --require-anon-key enabled; cannot run verify-isolation with anon-denial invariant." >&2
      exit 1
    fi
    if [[ "$SOFT_VERIFY" != "true" ]]; then
      echo "WARNING: SUPABASE_ANON_KEY not set — verify-isolation's anon-denial invariant will be skipped. Set SUPABASE_ANON_KEY to fully verify tenant isolation." >&2
    fi
  fi
  for script in "${verify_scripts[@]}"; do
    echo "[dry-run] would run: SUPABASE_URL=https://$SUPABASE_PROJECT_REF.supabase.co SUPABASE_SERVICE_ROLE_KEY=<resolved> bun $script"
  done
else
  SUPABASE_URL="https://$SUPABASE_PROJECT_REF.supabase.co"
  if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" && -f "$TARGET_REPO/supabase/.env" ]]; then
    env_value="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$TARGET_REPO/supabase/.env" | tail -n1 || true)"
    if [[ -n "$env_value" ]]; then
      SUPABASE_SERVICE_ROLE_KEY="${env_value#SUPABASE_SERVICE_ROLE_KEY=}"
      SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY%\"}"
      SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY#\"}"
      export SUPABASE_SERVICE_ROLE_KEY
    fi
  fi

  if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
    echo "Set SUPABASE_SERVICE_ROLE_KEY env var to run target verify scripts. Re-run with --skip-verify to defer." >&2
    exit 1
  fi

  if [[ -z "${SUPABASE_ANON_KEY:-}" ]]; then
    if [[ "$REQUIRE_ANON_KEY" == "true" ]]; then
      echo "ERROR: SUPABASE_ANON_KEY not set and --require-anon-key enabled; cannot run verify-isolation with anon-denial invariant." >&2
      exit 1
    fi
    if [[ "$SOFT_VERIFY" != "true" ]]; then
      echo "WARNING: SUPABASE_ANON_KEY not set — verify-isolation's anon-denial invariant will be skipped. Set SUPABASE_ANON_KEY to fully verify tenant isolation." >&2
    fi
  fi

  failed_verifies=0
  for script in "${verify_scripts[@]}"; do
    echo "Running verify script: $script"
    if ! SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" bun "$script"; then
      echo "Verify failed: $script" >&2
      failed_verifies=$((failed_verifies + 1))
    fi
  done

  if [[ "$failed_verifies" -gt 0 ]]; then
    if [[ "$SOFT_VERIFY" == "true" ]]; then
      echo "WARNING: $failed_verifies verify script(s) failed (--soft-verify enabled); continuing." >&2
    else
      echo "ERROR: $failed_verifies verify script(s) failed. Install aborted." >&2
      exit 1
    fi
  fi
fi

step 11 "Write install manifest"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] would write $MANIFEST_PATH"
else
  mkdir -p "$INSTALL_DIR"
  GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if command -v jq >/dev/null 2>&1; then
    migrations_json='[]'
    if [[ -f "$MIGRATIONS_MANIFEST_PATH" ]]; then
      mappings_array="$(jq -c '.mappings // []' "$MIGRATIONS_MANIFEST_PATH")"
      migrations_json="$(jq -cn --argjson mappings "$mappings_array" '$mappings | map({from: .from, to: .to})')"
    fi

    jq -n \
      --arg installedAt "$INSTALLED_AT" \
      --arg agentCoreSha "$GIT_SHA" \
      --arg agentCoreVersion "0.1.0" \
      --arg targetRepo "$TARGET_REPO" \
      --arg tenantSlug "$TENANT_SLUG" \
      --arg supabaseProjectRef "$SUPABASE_PROJECT_REF" \
      --arg targetWebDir "$TARGET_WEB_DIR" \
      --arg migrationStyle "$MIGRATION_STYLE" \
      --arg schema "agent_core" \
      --arg pkgAgentCore "0.1.0" \
      --arg pkgAgentRuntime "0.1.0" \
      --arg pkgAgentTools "0.1.0" \
      --arg pkgAgentSchema "0.1.0" \
      --argjson migrationsApplied "$migrations_json" \
      '{
        installedAt: $installedAt,
        agentCoreSha: $agentCoreSha,
        agentCoreVersion: $agentCoreVersion,
        targetRepo: $targetRepo,
        tenantSlug: $tenantSlug,
        supabaseProjectRef: $supabaseProjectRef,
        targetWebDir: $targetWebDir,
        migrationStyle: $migrationStyle,
        schema: $schema,
        packages: {
          "@blackrock-ai/agent-core": $pkgAgentCore,
          "@blackrock-ai/agent-runtime": $pkgAgentRuntime,
          "@blackrock-ai/agent-tools": $pkgAgentTools,
          "@blackrock-ai/agent-schema": $pkgAgentSchema
        },
        migrationsApplied: $migrationsApplied
      }' > "$MANIFEST_PATH"
  else
    migrations_applied='[]'
    if [[ -f "$MIGRATIONS_MANIFEST_PATH" ]]; then
      mappings_block="$(python3 - "$MIGRATIONS_MANIFEST_PATH" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
print(json.dumps([{"from": x.get("from"), "to": x.get("to")} for x in data.get("mappings", [])]))
PY
)"
      migrations_applied="$mappings_block"
    fi

    cat > "$MANIFEST_PATH" <<JSON
{
  "installedAt": "$INSTALLED_AT",
  "agentCoreSha": "$GIT_SHA",
  "agentCoreVersion": "0.1.0",
  "targetRepo": "$TARGET_REPO",
  "tenantSlug": "$TENANT_SLUG",
  "supabaseProjectRef": "$SUPABASE_PROJECT_REF",
  "targetWebDir": "$TARGET_WEB_DIR",
  "migrationStyle": "$MIGRATION_STYLE",
  "schema": "agent_core",
  "packages": {
    "@blackrock-ai/agent-core": "0.1.0",
    "@blackrock-ai/agent-runtime": "0.1.0",
    "@blackrock-ai/agent-tools": "0.1.0",
    "@blackrock-ai/agent-schema": "0.1.0"
  },
  "migrationsApplied": $migrations_applied
}
JSON
  fi
fi

step 12 "Final summary + next steps"
echo "Install flow complete (dry-run=$DRY_RUN)"
echo "Target repo: $TARGET_REPO"
echo "Supabase project ref: $SUPABASE_PROJECT_REF"
echo "Dashboard API URL: https://supabase.com/dashboard/project/$SUPABASE_PROJECT_REF/settings/api"
echo "Mount snippet path: $TARGET_REPO/.agent-core-install/MOUNT_SNIPPET.md"
echo "Runbook: $REPO_ROOT/docs/install-runbook.md"
