#!/usr/bin/env bash
# release.sh — publish-preparation runbook for Agent Core packages.
#
# What this script DOES:
# - Installs dependencies and runs typecheck/test/build gates.
# - Runs npm pack --dry-run for each publishable package.
# - Validates tarball naming and expected packaged file surface.
# - Prints the exact operator-run npm publish commands in dependency order.
#
# What this script DOES NOT do:
# - It does not execute npm publish.
# - It does not push tags or change package versions.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

bun install --frozen-lockfile
bun run typecheck
bun test
bun run build

packages=(
  "tools:@blackrock-ai/agent-tools:packages/tools:dist"
  "runtime:@blackrock-ai/agent-runtime:packages/runtime:dist"
  "shell:@blackrock-ai/agent-core:packages/shell:dist"
  "admin:@blackrock-ai/agent-admin:packages/admin:dist"
  "schema:@blackrock-ai/agent-schema:packages/schema:migrations"
)

declare -a summary_rows=()
failures=0

for entry in "${packages[@]}"; do
  IFS=":" read -r package_key scoped_name package_dir expected_path <<< "$entry"

  cd "$repo_root/$package_dir"
  pack_output="$(npm pack --dry-run 2>&1)"
  cd "$repo_root"

  tarball_name="$(printf '%s\n' "$pack_output" | awk '/^npm notice filename:/{print $4}' | tail -n1)"
  expected_prefix="blackrock-ai-"
  tarball_ok="✓"

  if [[ -z "$tarball_name" || "$tarball_name" != ${expected_prefix}* ]]; then
    tarball_ok="✗"
  fi

  if ! printf '%s\n' "$pack_output" | grep -q "npm notice .* ${expected_path}"; then
    tarball_ok="✗"
  fi

  version="$(node -p "require('./${package_dir}/package.json').version")"
  if [[ "$tarball_ok" != "✓" ]]; then
    failures=$((failures + 1))
  fi

  summary_rows+=("$package_key|$scoped_name|$version|$tarball_ok")
done

printf '\n%-10s | %-32s | %-7s | %-10s\n' "package" "scoped name" "version" "tarball ok"
printf '%s\n' "-----------|----------------------------------|---------|-----------"
for row in "${summary_rows[@]}"; do
  IFS='|' read -r package_key scoped_name version tarball_ok <<< "$row"
  printf '%-10s | %-32s | %-7s | %-10s\n' "$package_key" "$scoped_name" "$version" "$tarball_ok"
done

printf '\nPublish commands (run manually, in order):\n'
printf '%s\n' "cd packages/tools  && npm publish && cd ../.."
printf '%s\n' "cd packages/runtime && npm publish && cd ../.."
printf '%s\n' "cd packages/shell  && npm publish && cd ../.."
printf '%s\n' "cd packages/admin  && npm publish && cd ../.."
printf '%s\n' "cd packages/schema && npm publish && cd ../.."

if [[ "$failures" -gt 0 ]]; then
  printf '\nPack validation failed for %s package(s). DO NOT publish.\n' "$failures"
  exit 1
fi

printf '\nGITHUB_TOKEN must be set with write:packages scope. This script DID NOT publish. Operator runs the commands above watching.\n'