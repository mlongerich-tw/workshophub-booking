#!/usr/bin/env bash
# PostToolUse hook (assistive): format the file Claude just wrote with Prettier.
# Uses the owning package's pinned Prettier (not npx latest) and the repo .prettierrc.
# Silent and never blocks: always exits 0.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
file="$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)"

[[ -z "$file" || ! -f "$file" ]] && exit 0

rel="${file#"$root"/}"
case "$rel" in
  api/*) pkg="api" ;;
  app/*) pkg="app" ;;
  *) exit 0 ;; # only app/ and api/ are covered by make format-check
esac

prettier="$root/$pkg/node_modules/.bin/prettier"
[[ -x "$prettier" ]] || exit 0

(cd "$root/$pkg" && "$prettier" --write --ignore-unknown --log-level silent "$file") >/dev/null 2>&1 || true
exit 0
