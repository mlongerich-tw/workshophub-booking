#!/usr/bin/env bash
# Sensor: enforce the SPDD REASONS-Canvas structure.
#
# 1. Every canvas in spdd/prompt/*.md has the seven `## ` sections, in order, each
#    exactly once and non-empty: Requirements, Entities, Approach, Structure,
#    Operations, Norms, Safeguards. `## ` lines inside code fences are ignored.
# 2. On a latc-<n>-<slug> branch whose changes touch api/src/ or app/src/, a canvas
#    for that card (spdd/prompt/LATC-<n>-*.md) must exist. latc-xx and other
#    branches are exempt (branch-name-check.sh polices names).
#
# Usage: scripts/reasons-lint.sh [--dir <canvas dir>] [--branch <name>] [-- <changed path>...]
#   --dir     default spdd/prompt
#   --branch  default the current branch
#   -- paths  changed files to check; default: everything changed since the merge
#             base with main (committed, staged, unstaged and untracked)
# Exit 0 = ok, 1 = violations (listed on stderr), 2 = usage error.
set -u

SECTIONS="Requirements Entities Approach Structure Operations Norms Safeguards"
dir=spdd/prompt
branch=
branch_set=0
changed_set=0
changed=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir=${2:?--dir needs a value}; shift 2 ;;
    --branch) branch=${2-}; branch_set=1; shift 2 ;;
    --) shift; changed_set=1; changed=("$@"); break ;;
    *) echo "reasons-lint: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

[ "$branch_set" = 1 ] || branch=$(git branch --show-current 2>/dev/null || true)

if [ "$changed_set" = 0 ]; then
  base=
  for ref in main origin/main; do
    if base=$(git merge-base "$ref" HEAD 2>/dev/null); then break; fi
    base=
  done
  list=$(
    {
      [ -n "$base" ] && git diff --name-only "$base"
      git diff --cached --name-only
      git ls-files --others --exclude-standard
    } 2>/dev/null | sort -u
  )
  while IFS= read -r line; do
    [ -n "$line" ] && changed+=("$line")
  done <<<"$list"
fi

errors=0
fail() {
  echo "reasons-lint: $1" >&2
  errors=$((errors + 1))
}

# --- 1. Structure of every canvas -------------------------------------------
shopt -s nullglob
canvases=("$dir"/*.md)
for file in ${canvases[@]+"${canvases[@]}"}; do
  name=$(basename "$file")
  problems=$(
    awk -v expected="$SECTIONS" '
      BEGIN { n = split(expected, want, " "); for (i = 1; i <= n; i++) idx[want[i]] = i }
      /^[ \t]*(```|~~~)/ { fence = !fence; if (cur != "") body[cur]++; next }
      !fence && /^## / {
        title = substr($0, 4); sub(/[ \t]+$/, "", title)
        if (title in idx) {
          if (title in seen) print "duplicate section: " title
          seen[title] = 1
          order[++count] = title
          cur = title
        } else cur = ""
        next
      }
      cur != "" && /[^ \t]/ && !/^#+[ \t]/ { body[cur]++ }
      END {
        for (i = 1; i <= n; i++) {
          if (!(want[i] in seen)) print "missing section: " want[i]
          else if (!(want[i] in body)) print "empty section: " want[i]
        }
        last = 0
        for (i = 1; i <= count; i++) {
          if (idx[order[i]] < last) { print "sections out of order (expected " expected ")"; break }
          last = idx[order[i]]
        }
      }
    ' "$file"
  )
  while IFS= read -r p; do
    [ -n "$p" ] && fail "$name: $p"
  done <<<"$problems"
done

# --- 2. Canvas required for the branch card ---------------------------------
if [[ "$branch" =~ ^latc-([0-9]+)- ]]; then
  key="LATC-${BASH_REMATCH[1]}"
  touches_src=0
  for path in ${changed[@]+"${changed[@]}"}; do
    case "$path" in api/src/* | app/src/*) touches_src=1 ;; esac
  done
  if [ "$touches_src" = 1 ]; then
    found=("$dir/$key"-*.md)
    if [ ${#found[@]} -eq 0 ]; then
      fail "no REASONS canvas for $key in $dir/, but this branch changes api/src or app/src. Create one with /spdd-reasons-canvas."
    fi
  fi
fi

if [ "$errors" -gt 0 ]; then
  echo "reasons-lint: $errors problem(s) found." >&2
  exit 1
fi
echo "reasons-lint: ok (${#canvases[@]} canvas(es) checked)"
