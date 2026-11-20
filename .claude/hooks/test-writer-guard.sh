#!/usr/bin/env bash
# PreToolUse guard for the test-writer agent (isolated RED): keeps it blind to source.
# Registered project-wide in .claude/settings.json; acts only when the hook input's
# agent_type is "test-writer" (Claude Code sets agent_type for subagent tool calls).
# Agent-frontmatter hooks were tried first and did not fire (Claude Code 2.1.329).
#   Read / Grep / Glob : allowlisted paths only (tests, prisma schema, test config, docs)
#   Write / Edit       : api/tests/ only
#   Bash / web tools   : blocked
#   anything else      : allowed (harness-internal tools such as the report hand-back)
# Exit 2 blocks the tool call and tells the agent why.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
input="$(cat)"

[[ "$(printf '%s' "$input" | jq -r '.agent_type // empty')" == "test-writer" ]] || exit 0

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"

block() {
  echo "BLOCKED (test-writer guard): $1. test-writer is blind to source: it may read only api/tests/, api/prisma/, api/jest.config.js, api/tsconfig.json, CLAUDE.md, README.md, .prettierrc, and may write only under api/tests/." >&2
  exit 2
}

# Normalise to a repo-relative path; reject traversal and paths outside the repo.
rel_of() {
  local p="$1"
  [[ -z "$p" ]] && { printf '%s' "."; return; }
  [[ "$p" == *".."* ]] && block "path traversal ('..') is not allowed: $p"
  [[ "$p" != /* ]] && p="$root/$p"
  p="${p%/}"
  if [[ "$p" == "$root" ]]; then printf '%s' "."; return; fi
  [[ "$p" == "$root"/* ]] || block "path outside the repo: $p"
  printf '%s' "${p#"$root"/}"
}

readable() { # file or directory the agent may read/search
  case "$1" in
    api/tests | api/tests/* | api/prisma | api/prisma/*) return 0 ;;
    api/jest.config.js | api/tsconfig.json | CLAUDE.md | README.md | .prettierrc) return 0 ;;
  esac
  return 1
}

case "$tool" in
  Read)
    rel="$(rel_of "$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')")"
    readable "$rel" || block "Read of '$rel' is not allowed"
    ;;
  Write | Edit | MultiEdit | NotebookEdit)
    rel="$(rel_of "$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')")"
    [[ "$rel" == api/tests/* ]] || block "$tool of '$rel' is not allowed"
    ;;
  Grep | Glob)
    rel="$(rel_of "$(printf '%s' "$input" | jq -r '.tool_input.path // empty')")"
    readable "$rel" || block "$tool must target an allowed directory via 'path' (got '$rel')"
    # patterns/globs must not climb out of the allowed directory
    for field in pattern glob; do
      v="$(printf '%s' "$input" | jq -r --arg f "$field" '.tool_input[$f] // empty')"
      [[ "$tool" == "Glob" || "$field" == "glob" ]] || continue
      [[ "$v" == *".."* || "$v" == /* ]] && block "$tool $field may not use '..' or absolute paths: $v"
    done
    ;;
  Bash | PowerShell | WebFetch | WebSearch)
    block "tool '$tool' is not permitted for test-writer"
    ;;
  *)
    # Harness-internal tools (e.g. the report hand-back, ToolSearch) must pass,
    # or the agent can't deliver its result. The agent's own tool list is fixed
    # in its frontmatter; this guard only polices file access.
    ;;
esac

exit 0
