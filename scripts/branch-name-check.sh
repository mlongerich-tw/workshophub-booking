#!/usr/bin/env bash
# Sensor: the branch name must be latc-<n>-<slug> (story work, as /kickoff creates)
# or latc-xx-<slug> (tooling work with no Jira card).
#
# Usage: scripts/branch-name-check.sh [branch]   (default: the current branch)
#        scripts/branch-name-check.sh --pre-push  (reads git's pre-push stdin and checks
#        every pushed REMOTE branch name; deletions and tags are skipped)
# Exit 0 = ok, 1 = bad name. Run via `make branch-check` (pre-commit, pre-push) and CI.
set -u

if [ "${1-}" = --pre-push ]; then
  status=0
  while read -r _lref lsha rref _rsha; do
    case "${lsha:-}" in *[!0]*) ;; *) continue ;; esac # all zeros = branch deletion
    case "${rref:-}" in refs/heads/*) ;; *) continue ;; esac
    bash "$0" "${rref#refs/heads/}" </dev/null || status=1
  done
  exit $status
fi

if [ $# -ge 1 ]; then
  branch=$1
else
  branch=$(git branch --show-current)
fi

if [ -z "$branch" ]; then
  echo "branch-name-check: no branch (detached HEAD). Commit on a latc-<n>-<slug> branch." >&2
  exit 1
fi

if [[ "$branch" =~ ^latc-([0-9]+|xx)-[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "branch-name-check: ok ($branch)"
  exit 0
fi

cat >&2 <<EOF
branch-name-check: '$branch' does not match latc-<n>-<slug>.
  Story work:   latc-<n>-<slug>   e.g. latc-64-waitlist-full-training-session (/kickoff creates it)
  Tooling work: latc-xx-<slug>    e.g. latc-xx-dev-sensors
  <slug> is lowercase a-z, 0-9 and single hyphens.
  Rename with: git branch -m <new-name>
EOF
exit 1
