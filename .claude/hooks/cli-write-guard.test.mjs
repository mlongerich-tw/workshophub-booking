// Tests for cli-write-guard.mjs. Run: node --test .claude/hooks/ (part of `make test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evaluate, loadAllowlist } from './cli-write-guard.mjs'

const HOOK = fileURLToPath(new URL('./cli-write-guard.mjs', import.meta.url))
const allowlist = loadAllowlist()
const decide = (cmd) => evaluate(cmd, allowlist).decision

const cases = {
  none: [
    // not a CLI call at all
    'git status --short',
    'grep -rn acli .claude',
    'echo "please run gh pr merge yourself"',
    'ls ~/.gh-cache',
    // Jira reads (everything kickoff reads)
    'acli --version',
    'acli jira auth status',
    'acli jira workitem view LATC-2 --fields "*all" --json',
    'acli jira workitem view LATC-2',
    'acli jira workitem search --jql "project = LATC AND issue in linkedIssues(LATC-2)" --fields summary,status,issuelinks --json',
    'acli jira workitem link list --key LATC-12 --json',
    'acli jira workitem link type --json',
    'acli jira workitem comment list --key LATC-12',
    'acli jira board view --id 22687 --json',
    'acli confluence page view --id 123',
    '/opt/homebrew/bin/acli jira workitem view LATC-2',
    'ACLI_X=1 acli jira workitem view LATC-2',
    // help is always fine
    'acli jira workitem create --help',
    'gh pr merge -h',
    // GitHub reads
    'gh auth status',
    'gh pr view 8 --json title,state',
    'gh pr list --state all --limit 3',
    'gh pr diff 8',
    'gh pr checks 8',
    'gh issue list',
    'gh repo view --json nameWithOwner',
    'gh run list --limit 5',
    'gh search prs --repo mlongerich-tw/workshophub-booking foo',
    'gh api repos/mlongerich-tw/workshophub-booking/pulls',
    'gh api -X GET repos/o/r/issues',
    'gh api --method=get repos/o/r',
    // reads mixed with other shell
    'acli jira workitem view LATC-2 --json | jq .fields.summary',
    'gh pr list && git branch --show-current',
    // prose that mentions a write
    "git commit -m 'run gh pr create later'",
    'acli jira workitem view LATC-2 > "/tmp/story with spaces.json"',
  ],
  ask: [
    // Jira writes kickoff performs
    'acli jira workitem create --project LATC --type Story --summary "[Mike] Register" --description-file /tmp/d.json --json',
    'acli jira workitem link create --out LATC-12 --in LATC-2 --type clones --yes',
    'acli jira workitem transition --key LATC-12 --status "In Progress" --yes',
    'acli jira workitem comment create --key LATC-12 --body "Kickoff re-run"',
    'acli jira workitem edit --key LATC-12 --summary x',
    'acli jira workitem delete --key LATC-12',
    'acli jira auth login --web',
    'acli confluence page create',
    'acli rovodev run',
    // GitHub writes
    'gh pr create --title "x" --body "y"',
    'gh pr merge 8 --squash',
    'gh pr comment 8 --body hi',
    'gh issue create --title x',
    'gh repo delete mlongerich-tw/workshophub-booking',
    'gh api -X POST repos/o/r/issues',
    'gh api repos/o/r/issues -f title=x',
    'gh api graphql -F query=@q.graphql',
    'gh api repos/o/r/pulls --input body.json',
    'gh auth login',
    // writes hidden behind other commands
    'acli jira workitem view LATC-2; acli jira workitem delete --key LATC-2',
    'gh pr list && gh pr merge 8',
    'echo LATC-12 | xargs acli jira workitem delete --key',
    'find . -name x -exec gh pr close 8 \\;',
    'bash -c "gh pr merge 8"',
    'eval "acli jira workitem transition --key LATC-12 --status Done"',
    'X=$(gh pr create --fill)',
    'cd api && gh release create v1',
    // unknown commands count as writes
    'acli jira workitem frobnicate',
    'gh',
  ],
  deny: [
    'acli jira workitem transition --jql "project = LATC" --status Done --yes',
    'acli jira workitem comment create --jql "project = LATC" --body x',
    'acli jira workitem edit --filter 10001 --summary x',
    'acli jira workitem transition --key "LATC-2,LATC-12" --status Done',
    'acli jira workitem transition --key LATC-2,LATC-12 --status Done',
    'acli jira workitem delete --key "LATC-2, LATC-12"',
    'acli jira workitem comment create --key=LATC-2,LATC-3 --body x',
    'acli jira workitem view LATC-2 && acli jira workitem transition --jql=project=LATC --status Done',
  ],
}

for (const [want, cmds] of Object.entries(cases)) {
  for (const cmd of cmds) {
    test(`${want}: ${cmd}`, () => assert.equal(decide(cmd), want))
  }
}

const run = (input) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' })

test('hook: read exits 0 with no output', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'gh pr list' } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('hook: write exits 0 with a PreToolUse "ask" decision', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 8' } })
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout).hookSpecificOutput
  assert.equal(out.hookEventName, 'PreToolUse')
  assert.equal(out.permissionDecision, 'ask')
  assert.match(out.permissionDecisionReason, /gh pr merge/)
})

test('hook: bulk Jira write exits 2 with a reason on stderr', () => {
  const r = run({
    tool_name: 'Bash',
    tool_input: { command: 'acli jira workitem transition --jql "project = LATC" --status Done' },
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /BLOCKED: bulk Jira write/)
})

test('hook: non-Bash or malformed input is ignored', () => {
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: 'x' } }).status, 0)
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' })
  assert.equal(r.status, 0)
})

test('allowlist has no write commands', () => {
  for (const p of allowlist) {
    assert.doesNotMatch(
      p,
      /\b(create|edit|delete|transition|merge|close|login|update|archive)\b/,
      p
    )
  }
})
