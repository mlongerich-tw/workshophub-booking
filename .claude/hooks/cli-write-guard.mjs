#!/usr/bin/env node
// PreToolUse hook (Bash): Jira/GitHub writes through the acli and gh CLIs need the user's OK.
//
//   read-only command (listed in cli-readonly-commands.txt, --help, or a GET `gh api`)  → no decision
//   bulk Jira write (--jql / --filter / several keys)                                     → BLOCK (exit 2)
//   any other acli / gh command                                                         → "ask"
//
// CLAUDE.md lists every Jira/GitHub write under AGENT_BOUNDARY ("ask before doing"); this hook
// enforces it. In OpenCode the bridge runs this hook too (exit 2 blocks); the "ask" half is
// native there: scripts/sync-opencode.mjs turns the same allowlist into opencode.json rules.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ALLOWLIST = join(HERE, 'cli-readonly-commands.txt')

// Words that can follow `acli` / `gh` as a command. A bare `acli`/`gh` token followed by one of
// these (or by a flag) counts as a CLI call even when it is not at the start of a segment,
// e.g. `xargs acli jira ...` or `find . -exec gh pr merge ...`.
const SUBCOMMANDS = {
  acli: new Set([
    'jira',
    'confluence',
    'admin',
    'auth',
    'guard',
    'rovodev',
    'config',
    'feedback',
    'help',
  ]),
  gh: new Set([
    'agent-task',
    'alias',
    'api',
    'attestation',
    'auth',
    'browse',
    'cache',
    'co',
    'codespace',
    'completion',
    'config',
    'copilot',
    'extension',
    'gist',
    'gpg-key',
    'help',
    'issue',
    'label',
    'org',
    'pr',
    'preview',
    'project',
    'release',
    'repo',
    'ruleset',
    'run',
    'search',
    'secret',
    'ssh-key',
    'status',
    'variable',
    'workflow',
  ]),
}

/** @returns {string[]} command prefixes from the allowlist file */
export function loadAllowlist(file = ALLOWLIST) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

const SHELL_EXEC = /(^|[;&|(`\s])(bash|sh|zsh)(\s+-[A-Za-z]*c|\s*<<)|(^|[;&|(`\s])eval(\s|$)/

/**
 * Remove text that is prose rather than code, so a comment body or PR description that merely
 * mentions `gh pr merge` doesn't trigger the guard. Same rules as block-main-push.sh:
 * heredoc bodies and quoted strings containing whitespace become empty; quoted strings without
 * whitespace are unquoted. Nothing is stripped when the text is executed as code (bash -c, eval).
 */
export function stripProse(cmd) {
  if (SHELL_EXEC.test(cmd)) return cmd
  return cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(\n|$)/g, '<<HEREDOC$3\n')
    .replace(/"((?:[^"\\]|\\.)*)"/g, (_, s) => (/\s/.test(s) ? '""' : s))
    .replace(/'([^']*)'/g, (_, s) => (/\s/.test(s) ? "''" : s))
}

const base = (tok) => tok.replace(/^.*\//, '')

/** Find every acli / gh invocation in a shell command. @returns {{ cli: string, args: string[] }[]} */
export function findCalls(cmd) {
  const calls = []
  // Quotes only separate commands when the text runs as code (bash -c "gh pr merge 1").
  // Otherwise stripProse has already emptied or unquoted them, and `--key ""` must survive.
  const sep = SHELL_EXEC.test(cmd) ? /\|\||&&|\$\(|[;&|\n(){}`"']/ : /\|\||&&|\$\(|[;&|\n(){}`]/
  const segments = stripProse(cmd).split(sep)
  for (const seg of segments) {
    const toks = seg.trim().split(/\s+/).filter(Boolean)
    let first = 0
    while (first < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[first])) first++
    for (let i = 0; i < toks.length; i++) {
      const cli = base(toks[i])
      if (cli !== 'acli' && cli !== 'gh') continue
      const next = toks[i + 1]
      if (
        i === first ||
        (next !== undefined && (SUBCOMMANDS[cli].has(next) || next.startsWith('-')))
      ) {
        calls.push({ cli, args: toks.slice(i + 1) })
        break
      }
    }
  }
  return calls
}

const isHelp = (args) => args.some((a) => a === '--help' || a === '-h') || args[0] === 'help'

/** `gh api` is a read only as a GET without request fields or a request body. */
function isReadOnlyGhApi(args) {
  if (args[0] !== 'api') return false
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    const method =
      a === '-X' || a === '--method' ? args[i + 1] : a.match(/^(?:-X|--method=)(.+)$/)?.[1]
    if (method !== undefined && method.toUpperCase() !== 'GET') return false
    if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF]./.test(a)) return false
  }
  return true
}

/** A Jira write that targets more than one work item, or an open-ended query of them. */
function bulkJiraWrite(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (/^--(jql|filter)(=|$)/.test(a)) return `${a.split('=')[0]} selects work items by query`
    const key = a === '-k' || a === '--key' ? args[i + 1] : a.match(/^(?:-k|--key=)(.+)$/)?.[1]
    if (key !== undefined && (key.includes(',') || key === '""' || key === "''")) {
      return 'several work item keys'
    }
  }
  return null
}

/** @returns {{ decision: 'allow' | 'ask' | 'deny', reason: string }} for one call */
export function classify({ cli, args }, allowlist) {
  const line = [cli, ...args].join(' ')
  if (isHelp(args)) return { decision: 'allow', reason: 'help' }
  if (allowlist.some((p) => line === p || line.startsWith(p + ' '))) {
    return { decision: 'allow', reason: 'read-only' }
  }
  if (cli === 'gh' && isReadOnlyGhApi(args)) return { decision: 'allow', reason: 'GET gh api' }
  if (cli === 'acli') {
    const bulk = bulkJiraWrite(args)
    if (bulk) {
      return {
        decision: 'deny',
        reason:
          `bulk Jira write (${bulk}); Jira writes must name exactly one work item with --key so ` +
          "they can never touch the original LATC card or other people's cards",
      }
    }
  }
  return { decision: 'ask', reason: `${line.split(' ').slice(0, 4).join(' ')} may write` }
}

/** @returns {{ decision: 'none' | 'ask' | 'deny', reasons: string[] }} for a whole command */
const KEYCHAIN_READS = new Set([
  'find-generic-password',
  'find-internet-password',
  'dump-keychain',
  'export',
])

/** `security find-generic-password ...` and friends would put a stored token in the transcript. */
export function keychainReads(cmd) {
  const sep = SHELL_EXEC.test(cmd) ? /\|\||&&|\$\(|[;&|\n(){}`"']/ : /\|\||&&|\$\(|[;&|\n(){}`]/
  return stripProse(cmd)
    .split(sep)
    .map((seg) => seg.trim().split(/\s+/))
    .filter((toks) =>
      toks.some((t, i) => base(t) === 'security' && KEYCHAIN_READS.has(toks[i + 1]))
    )
    .map(() => ({
      decision: 'deny',
      reason:
        'reading the macOS Keychain would expose stored credentials (use node scripts/jira-get.mjs for Jira reads)',
    }))
}

export function evaluate(cmd, allowlist = loadAllowlist()) {
  const results = [...keychainReads(cmd), ...findCalls(cmd).map((c) => classify(c, allowlist))]
  const pick = (d) => results.filter((r) => r.decision === d).map((r) => r.reason)
  if (pick('deny').length) return { decision: 'deny', reasons: pick('deny') }
  if (pick('ask').length) return { decision: 'ask', reasons: pick('ask') }
  return { decision: 'none', reasons: [] }
}

function main() {
  let cmd = ''
  try {
    cmd = JSON.parse(readFileSync(0, 'utf8') || '{}')?.tool_input?.command ?? ''
  } catch {
    return 0
  }
  if (typeof cmd !== 'string' || !/(^|[^\w-])(acli|gh|security)([^\w-]|$)/.test(cmd)) return 0

  const { decision, reasons } = evaluate(cmd)
  if (decision === 'deny') {
    process.stderr.write(`BLOCKED: ${reasons.join('; ')}.\n`)
    return 2
  }
  if (decision === 'ask') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `Jira/GitHub write needs your OK (CLAUDE.md AGENT_BOUNDARY): ${reasons.join('; ')}`,
        },
      }) + '\n'
    )
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
