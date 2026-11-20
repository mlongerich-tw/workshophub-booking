#!/usr/bin/env bash
# PreToolUse guard for the test-writer agent (isolated RED): keeps it blind to source.
# Registered project-wide in .claude/settings.json; acts only when the hook input's
# agent_type is "test-writer" (Claude Code sets agent_type for subagent tool calls).
# Agent-frontmatter hooks were tried first and did not fire (Claude Code 2.1.329).
#   Read / Grep / Glob : "read" entries in test-writer-allowlist.txt only
#   Write / Edit       : "write" entries in test-writer-allowlist.txt only
# Also runs under OpenCode via .opencode/plugins/claude-hooks-bridge.ts.
#   Bash / web tools   : blocked
#   anything else      : allowed (harness-internal tools such as the report hand-back)
# Exit 2 blocks the tool call and tells the agent why.
set -uo pipefail

input="$(cat)"

# Identify the calling agent. agent_type is what Claude Code sends today; the
# alternatives are tolerated in case the field is renamed. If detection ever
# breaks entirely, the agent's canary read (see test-writer.md) reports
# GUARD INACTIVE and /tdd halts, so failure is loud, not silent.
agent="$(printf '%s' "$input" | jq -r '.agent_type // .subagent_type // .agent_name // .agent.type // empty')"
[[ "$agent" == "test-writer" ]] || exit 0

# Resolve symlinks: real path of the nearest existing ancestor + the not-yet-existing rest.
resolve() {
  perl -MCwd=abs_path -e '
    my $p = shift; my @rest;
    while (!-e $p && $p =~ m{^(.*)/([^/]+)$}) { unshift @rest, $2; $p = $1 eq "" ? "/" : $1 }
    my $r = abs_path($p) // $p; $r =~ s{/$}{};
    print join("/", $r, @rest);
  ' "$1"
}

root="$(resolve "${CLAUDE_PROJECT_DIR:-$(pwd)}")"

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"

# Allowlist: single source shared with scripts/sync-opencode.mjs (OpenCode permissions).
allowlist="$(dirname "${BASH_SOURCE[0]}")/test-writer-allowlist.txt"
entries() { grep -E "^$1[[:space:]]+[^[:space:]]" "$allowlist" 2>/dev/null | awk '{print $2}'; }
summary() { entries "$1" | paste -sd ',' - | sed 's/,/, /g'; }

block() {
  echo "BLOCKED (test-writer guard): $1. test-writer is blind to source: it may read only $(summary read), and may write only under $(summary write)." >&2
  exit 2
}

# Fail closed: no allowlist means no access, not unrestricted access.
[[ -r "$allowlist" ]] || {
  echo "BLOCKED (test-writer guard): allowlist missing at $allowlist" >&2
  exit 2
}

# Normalise to a repo-relative path with symlinks resolved, so a link inside
# api/tests/ that points into api/src/ is judged by where it really points.
# Rejects traversal and anything that resolves outside the repo.
rel_of() {
  local p="$1"
  [[ -z "$p" ]] && { printf '%s' "."; return; }
  [[ "$p" == *".."* ]] && block "path traversal ('..') is not allowed: $p"
  [[ "$p" != /* ]] && p="$root/$p"
  p="$(resolve "${p%/}")"
  if [[ "$p" == "$root" ]]; then printf '%s' "."; return; fi
  [[ "$p" == "$root"/* ]] || block "path outside the repo: $p"
  printf '%s' "${p#"$root"/}"
}

readable() { # file or directory the agent may read/search: an entry or anything beneath it
  local p
  while read -r p; do
    [[ "$1" == "$p" || "$1" == "$p"/* ]] && return 0
  done < <(entries read)
  return 1
}

writable() { # strictly inside a write directory, or exactly a write file entry
  local p
  while read -r p; do
    [[ "$1" == "$p"/* ]] && return 0
    [[ "$1" == "$p" && ! -d "$root/$p" ]] && return 0
  done < <(entries write)
  return 1
}

case "$tool" in
  Read)
    rel="$(rel_of "$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')")"
    readable "$rel" || block "Read of '$rel' is not allowed"
    ;;
  Write | Edit | MultiEdit | NotebookEdit)
    rel="$(rel_of "$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')")"
    writable "$rel" || block "$tool of '$rel' is not allowed"
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
