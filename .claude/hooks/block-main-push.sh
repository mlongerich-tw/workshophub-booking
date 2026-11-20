#!/usr/bin/env bash
# PreToolUse hook (protective): block direct pushes to main from Claude's Bash tool.
# Exit 2 blocks the tool call and shows stderr to Claude; exit 1 would NOT block.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"

[[ -z "$cmd" ]] && exit 0

# Only care about commands that run `git ... push` (allowing global flags like -C dir).
git_push='(^|[;&|(`[:space:]])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+push([[:space:]]|$)'
[[ "$cmd" =~ $git_push ]] || exit 0

block() {
  echo "BLOCKED: direct push to main is forbidden. Push a feature branch and open a PR instead. ($1)" >&2
  exit 2
}

# Explicit main refspec: `origin main`, `HEAD:main`, `+main`, `refs/heads/main`, `main:main`.
main_ref='(^|[[:space:]:+/])main([[:space:]:;&|)]|$)'
[[ "$cmd" =~ $main_ref ]] && block "command targets main"

# Pushes that include every branch.
[[ "$cmd" =~ [[:space:]]--(all|mirror)([[:space:]]|$) ]] && block "--all/--mirror includes main"

# Bare `git push` / `git push origin` while main is checked out.
branch="$(git -C "$root" branch --show-current 2>/dev/null)"
[[ "$branch" == "main" ]] && block "current branch is main"

exit 0
