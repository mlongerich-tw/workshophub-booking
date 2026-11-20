#!/usr/bin/env bash
# PostToolUse hook: lint the file Claude just edited with that package's ESLint config.
# Exit 2 + stderr feeds lint errors back to Claude so it fixes them immediately.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
file="$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')"

[[ -z "$file" ]] && exit 0
[[ "$file" =~ \.(ts|tsx)$ ]] || exit 0

rel="${file#"$root"/}"
case "$rel" in
  api/*) pkg="api" ;;
  app/*) pkg="app" ;;
  *) exit 0 ;;
esac

[[ -f "$file" ]] || exit 0
[[ -d "$root/$pkg/node_modules" ]] || exit 0

if ! out="$(cd "$root/$pkg" && pnpm exec eslint "${rel#"$pkg"/}" 2>&1)"; then
  printf 'ESLint errors in %s (fix before continuing):\n%s\n' "$rel" "$out" >&2
  exit 2
fi
exit 0
