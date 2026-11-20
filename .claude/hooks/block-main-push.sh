#!/usr/bin/env bash
# PreToolUse hook (protective): block direct pushes to main from Claude's Bash tool.
# Exit 2 blocks the tool call and shows stderr to Claude; exit 1 would NOT block.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"

[[ -z "$cmd" ]] && exit 0

# Ignore quoted prose so text like a PR body or commit message that *mentions*
# pushing to main doesn't trigger a block. Stripped:
#   - quoted strings containing whitespace ("fix the push to main docs")
#   - heredoc bodies (git commit -F - <<'EOF' ... EOF)
# Kept (so they can't be used to sneak a push past the check):
#   - quoted strings without whitespace, e.g. git push origin "main"
#   - anything when the text is executed as code: bash/sh/zsh -c, shell heredocs, eval
scan="$cmd"
shell_exec='(^|[;&|(`[:space:]])(bash|sh|zsh)([[:space:]]+-[[:alnum:]]*c|[[:space:]]*<<)|(^|[;&|(`[:space:]])eval([[:space:]]|$)'
if ! [[ "$cmd" =~ $shell_exec ]]; then
  scan="$(printf '%s' "$cmd" | perl -0777 -pe '
    # heredoc bodies: <<WORD, <<-WORD, <<"WORD", <<'\''WORD'\''
    s/<<-?\s*([\x27"]?)(\w+)\1([^\n]*)\n.*?\n[ \t]*\2[ \t]*(\n|\z)/<<HEREDOC$3\n/sg;
    # double-quoted strings (with escapes) containing whitespace
    s/"((?:[^"\\]|\\.)*)"/ my $s = $1; $s =~ m{\s} ? q{""} : $s /sge;
    # single-quoted strings containing whitespace
    s/\x27([^\x27]*)\x27/ my $s = $1; $s =~ m{\s} ? q{\x27\x27} : $s /sge;
  ')"
fi

# Only care about commands that run `git ... push` (allowing global flags like -C dir).
# A leading quote counts as a boundary so `bash -c "git push ..."` is caught.
git_push=$'(^|[;&|(`"\'[:space:]])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+push([[:space:]]|$)'
[[ "$scan" =~ $git_push ]] || exit 0

block() {
  echo "BLOCKED: direct push to main is forbidden. Push a feature branch and open a PR instead. ($1)" >&2
  exit 2
}

# Explicit main refspec: `origin main`, `HEAD:main`, `+main`, `refs/heads/main`, `main:main`.
main_ref=$'(^|[[:space:]:+/"\'])main([[:space:]:;&|)"\']|$)'
[[ "$scan" =~ $main_ref ]] && block "command targets main"

# Pushes that include every branch.
[[ "$scan" =~ [[:space:]]--(all|mirror)([[:space:]]|$) ]] && block "--all/--mirror includes main"

# Bare `git push` / `git push origin` while main is checked out.
branch="$(git -C "$root" branch --show-current 2>/dev/null)"
[[ "$branch" == "main" ]] && block "current branch is main"

exit 0
