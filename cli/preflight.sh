#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=false
CONFIG_PATH="$SCRIPT_DIR/install.config"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    *)
      echo "FAIL: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

step_ok() {
  echo "OK"
}

step_would() {
  echo "OK (dry-run: would execute remote check)"
}

echo "[CHECK 1] Config loaded ..."
[[ -f "$CONFIG_PATH" ]] || fail "Install config not found at $CONFIG_PATH"
# shellcheck disable=SC1090
source "$CONFIG_PATH"
required_vars=(TARGET_REPO TENANT_SLUG SUPABASE_PROJECT_REF TARGET_WEB_DIR MIGRATION_STYLE)
for var_name in "${required_vars[@]}"; do
  [[ -n "${!var_name:-}" ]] || fail "Missing required variable: $var_name"
done
[[ "$MIGRATION_STYLE" == "sequential" || "$MIGRATION_STYLE" == "supabase_timestamp" ]] || fail "MIGRATION_STYLE must be 'sequential' or 'supabase_timestamp'"
step_ok

echo "[CHECK 2] Target repo exists and is a git repo ..."
[[ -d "$TARGET_REPO" ]] || fail "TARGET_REPO does not exist: $TARGET_REPO"
git -C "$TARGET_REPO" rev-parse --show-toplevel >/dev/null 2>&1 || fail "TARGET_REPO is not a git repo: $TARGET_REPO"
step_ok

echo "[CHECK 3] Target has supabase/ directory ..."
[[ -d "$TARGET_REPO/supabase" ]] || fail "Missing supabase/ at $TARGET_REPO/supabase"
step_ok

echo "[CHECK 4] Target has web source directory ..."
[[ -d "$TARGET_REPO/$TARGET_WEB_DIR" ]] || fail "Missing TARGET_WEB_DIR at $TARGET_REPO/$TARGET_WEB_DIR"
step_ok

echo "[CHECK 5] Supabase CLI present ..."
command -v supabase >/dev/null 2>&1 || fail "Supabase CLI not found. Install from https://supabase.com/docs/guides/cli"
SUPABASE_VERSION="$(supabase --version)"
echo "Supabase CLI version: $SUPABASE_VERSION"
step_ok

echo "[CHECK 6] Supabase CLI can reach project ref ..."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Would run: supabase projects list | grep $SUPABASE_PROJECT_REF"
  step_would
else
  projects_output="$(supabase projects list 2>&1)" || fail "Supabase CLI not logged in or project ref not visible — run \
\`supabase login\`"
  echo "$projects_output" | grep -q "$SUPABASE_PROJECT_REF" || fail "Supabase CLI not logged in or project ref not visible — run \`supabase login\`"
  step_ok
fi

echo "[CHECK 7] supabase_vault extension enabled ..."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Would run remote query: select 1 from pg_extension where extname='supabase_vault';"
  step_would
else
  # 2.98.x: `db query --linked` (JSON via Management API). Parse rows array
  # via python — passing text by env var to avoid heredoc escaping hazards.
  vault_query_output="$(supabase db query "select 1 as ok from pg_extension where extname='supabase_vault';" --linked --workdir "$TARGET_REPO" 2>&1 || true)"
  vault_count=$(SUPA_OUT="$vault_query_output" python3 -c "$(cat <<'PY'
import json, os, re
text = os.environ.get('SUPA_OUT', '')
try:
    m = re.search(r'\{.*\}', text, re.S)
    obj = json.loads(m.group(0)) if m else {}
    print(len(obj.get('rows', [])))
except Exception:
    print(0)
PY
)")
  if [[ "$vault_count" == "0" ]]; then
    # Legacy CLI fallback
    vault_query_output="$(supabase db remote query --project-ref "$SUPABASE_PROJECT_REF" "select 1 from pg_extension where extname='supabase_vault';" 2>&1 || true)"
    if ! echo "$vault_query_output" | grep -Eq '(^|\s)1(\s|$)'; then
      fail "supabase_vault extension is required — enable it in the Supabase dashboard under Database > Extensions before installing. (CLI output: ${vault_query_output:0:200})"
    fi
  fi
  step_ok
fi

echo "[CHECK 8] GitHub Packages token + scope ..."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Would verify GITHUB_TOKEN and call GitHub API for x-oauth-scopes"
  step_would
else
  [[ -n "${GITHUB_TOKEN:-}" ]] || fail "GITHUB_TOKEN is missing or empty. Create/update token at https://github.com/settings/tokens"
  headers_file="$(mktemp)"
  body_file="$(mktemp)"
  http_code="$(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user)"
  if [[ "$http_code" != "200" ]]; then
    rm -f "$headers_file" "$body_file"
    fail "GITHUB_TOKEN failed GitHub auth check. Update token at https://github.com/settings/tokens"
  fi
  scopes_line="$(grep -i '^x-oauth-scopes:' "$headers_file" || true)"
  rm -f "$headers_file" "$body_file"
  echo "$scopes_line" | grep -Eiq '(read:packages|repo)' || fail "GITHUB_TOKEN lacks read:packages scope (or repo). Update token at https://github.com/settings/tokens"
  step_ok
fi

echo "[CHECK 9] Existing agent_core schema safety check ..."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Would run remote query: select 1 from information_schema.schemata where schema_name='agent_core';"
  echo "Would validate existing install manifest for same tenantSlug + supabaseProjectRef"
  step_would
else
  # 2.98.x: `db query --linked` (JSON via Management API). Parse rows array
  # via python — passing text by env var to avoid heredoc escaping hazards.
  schema_check_output="$(supabase db query "select 1 as exists_flag from information_schema.schemata where schema_name='agent_core';" --linked --workdir "$TARGET_REPO" 2>&1 || true)"
  schema_count=$(SUPA_OUT="$schema_check_output" python3 -c "$(cat <<'PY'
import json, os, re
text = os.environ.get('SUPA_OUT', '')
try:
    m = re.search(r'\{.*\}', text, re.S)
    obj = json.loads(m.group(0)) if m else {}
    print(len(obj.get('rows', [])))
except Exception:
    print(-1)
PY
)")
  if [[ "$schema_count" == "-1" ]]; then
    # Legacy CLI fallback
    schema_check_output="$(supabase db remote query --project-ref "$SUPABASE_PROJECT_REF" "select 1 from information_schema.schemata where schema_name='agent_core';" 2>&1 || true)"
    if echo "$schema_check_output" | grep -Eq '(^|\s)1(\s|$)'; then
      schema_count=1
    else
      schema_count=0
    fi
  fi
  if [[ "$schema_count" -ge 1 ]]; then
    manifest_path="$TARGET_REPO/.agent-core-install/install-manifest.json"
    if [[ -f "$manifest_path" ]]; then
      manifest_tenant="$(python3 - "$manifest_path" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
obj = json.loads(path.read_text())
print(obj.get("tenantSlug", ""))
PY
)"
      manifest_ref="$(python3 - "$manifest_path" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
obj = json.loads(path.read_text())
print(obj.get("supabaseProjectRef", ""))
PY
)"

      if [[ "$manifest_tenant" == "$TENANT_SLUG" && "$manifest_ref" == "$SUPABASE_PROJECT_REF" ]]; then
        echo "NOTICE: agent_core schema already exists and matching install manifest found; allowing idempotent re-run."
        step_ok
      else
        fail "agent_core schema already exists on $SUPABASE_PROJECT_REF — existing install manifest is missing or does not match tenant/project. Refusing to proceed."
      fi
    else
      fail "agent_core schema already exists on $SUPABASE_PROJECT_REF — existing install manifest is missing or does not match tenant/project. Refusing to proceed."
    fi
  else
    step_ok
  fi
fi

echo "[CHECK 10] Final preflight verdict ..."
echo "PREFLIGHT OK — target ready for install"
step_ok
