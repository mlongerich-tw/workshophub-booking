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
# Usage: scripts/reasons-lint.sh [--dir <canvas dir>] [--branch <name>]
#                                [--staged | --rev <commit> | --pre-push] [-- <changed path>...]
#   --dir       default spdd/prompt
#   --branch    default the current branch
#   (no mode)   lint the working copy; changes = everything since the merge base with
#               main (committed, staged, unstaged, untracked). Used by `make reasons-lint`.
#   --staged    lint the canvases as staged (what `git commit` will record); changes =
#               merge base..index. Used by the pre-commit hook.
#   --rev C     lint the canvases in commit C; changes = merge base..C.
#   --pre-push  read git's pre-push stdin (<local ref> <sha> <remote ref> <sha>) and run
#               --rev for every pushed branch commit, with that branch's name. Used by
#               the pre-push hook. Deletions and tags are skipped.
#   -- paths    override the changed-file list
# Exit 0 = ok, 1 = violations (listed on stderr), 2 = usage error.
set -u

SECTIONS="Requirements Entities Approach Structure Operations Norms Safeguards"
dir=spdd/prompt
branch=
branch_set=0
changed_set=0
changed=()
mode=worktree
modes=0
rev=

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir=${2:?--dir needs a value}; shift 2 ;;
    --branch) branch=${2-}; branch_set=1; shift 2 ;;
    --staged) mode=index; modes=$((modes + 1)); shift ;;
    --rev) mode=rev; rev=${2:?--rev needs a commit}; modes=$((modes + 1)); shift 2 ;;
    --pre-push) mode=pre-push; modes=$((modes + 1)); shift ;;
    --) shift; changed_set=1; changed=("$@"); break ;;
    *) echo "reasons-lint: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
dir=${dir%/}

if [ "$modes" -gt 1 ]; then
  echo "reasons-lint: use only one of --staged, --rev, --pre-push" >&2
  exit 2
fi

# --- pre-push: lint every pushed branch tip ---------------------------------
if [ "$mode" = pre-push ]; then
  status=0
  while read -r lref lsha _rref _rsha; do
    [ -n "${lref:-}" ] || continue
    case "${lsha:-}" in *[!0]*) ;; *) continue ;; esac # all zeros = branch deletion
    case "$lref" in refs/heads/*) ;; *) continue ;; esac
    bash "$0" --dir "$dir" --branch "${lref#refs/heads/}" --rev "$lsha" </dev/null || status=1
  done
  exit $status
fi

if [ "$mode" = rev ] && ! git rev-parse --verify --quiet "$rev^{commit}" >/dev/null; then
  echo "reasons-lint: '$rev' is not a commit" >&2
  exit 2
fi

[ "$branch_set" = 1 ] || branch=$(git branch --show-current 2>/dev/null || true)

# Changed paths for the chosen mode, relative to the merge base with main.
changed_files() {
  case "$mode" in
    worktree)
      [ -n "$base" ] && git diff --name-only "$base"
      git diff --cached --name-only
      git ls-files --others --exclude-standard
      ;;
    index)
      if [ -n "$base" ]; then git diff --cached --name-only "$base"; else git diff --cached --name-only; fi
      ;;
    rev)
      if [ -n "$base" ]; then git diff --name-only "$base" "$rev"; else git show --name-only --pretty= "$rev"; fi
      ;;
  esac
}

# --- changed files ----------------------------------------------------------
if [ "$changed_set" = 0 ]; then
  tip=HEAD
  [ "$mode" = rev ] && tip=$rev
  base=
  for ref in main origin/main; do
    if base=$(git merge-base "$ref" "$tip" 2>/dev/null); then break; fi
    base=
  done
  list=$(changed_files 2>/dev/null | sort -u)
  while IFS= read -r line; do
    [ -n "$line" ] && changed+=("$line")
  done <<<"$list"
fi

# --- canvases in the chosen source (working copy, index or commit) ----------
names=()
case "$mode" in
  worktree)
    shopt -s nullglob
    for f in "$dir"/*.md; do names+=("$(basename "$f")"); done
    ;;
  index | rev)
    if [ "$mode" = index ]; then
      listing=$(git ls-files -- "$dir" 2>/dev/null)
    else
      listing=$(git ls-tree -r --name-only "$rev" -- "$dir" 2>/dev/null)
    fi
    while IFS= read -r p; do
      rel=${p#"$dir"/}
      case "$rel" in */* | "") continue ;; *.md) names+=("$rel") ;; esac
    done <<<"$listing"
    ;;
esac

read_canvas() {
  case "$mode" in
    worktree) cat "$dir/$1" ;;
    index) git show ":$dir/$1" ;;
    rev) git show "$rev:$dir/$1" ;;
  esac
}

case "$mode" in
  worktree) where="working copy" ;;
  index) where="staged" ;;
  rev) where="commit $(git rev-parse --short "$rev")" ;;
esac

errors=0
fail() {
  echo "reasons-lint: $1" >&2
  errors=$((errors + 1))
}

# --- 1. Structure of every canvas -------------------------------------------
for name in ${names[@]+"${names[@]}"}; do
  problems=$(
    read_canvas "$name" | awk -v expected="$SECTIONS" '
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
    '
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
    found=0
    for name in ${names[@]+"${names[@]}"}; do
      case "$name" in "$key"-*.md) found=1 ;; esac
    done
    if [ "$found" = 0 ]; then
      fail "no REASONS canvas for $key in $dir/ ($where), but this branch changes api/src or app/src. Create one with /spdd-reasons-canvas."
    fi
  fi
fi

if [ "$errors" -gt 0 ]; then
  echo "reasons-lint: $errors problem(s) found ($where)." >&2
  [ "$mode" = index ] && echo "reasons-lint: the staged version is checked; fix the canvas, then git add it." >&2
  exit 1
fi
echo "reasons-lint: ok (${#names[@]} canvas(es) checked, $where)"
