// Tests for branch-name-check.sh. Run: node --test 'scripts/*.test.mjs' (part of `make test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./branch-name-check.sh', import.meta.url))

const run = (branch) => spawnSync('bash', [SCRIPT, branch], { encoding: 'utf8' })

const allowed = [
  'latc-64-waitlist-full-training-session',
  'latc-2-registration',
  'latc-123-a',
  'latc-xx-dev-sensors',
  'latc-7-v2-api',
]
for (const branch of allowed) {
  test(`allows ${branch}`, () => {
    const r = run(branch)
    assert.equal(r.status, 0, r.stderr)
  })
}

const rejected = [
  'main',
  'feature/LATC-44-session-registration',
  'chore/spdd-tdd-agents',
  'LATC-64-waitlist',
  'latc-64',
  'latc-64-',
  'latc--waitlist',
  'latc-x-waitlist',
  'latc-64-Waitlist',
  'latc-64-waitlist_full',
  'latc-64--double',
  'latc-64-trailing-',
  'latc-64-waitlist/sub',
]
for (const branch of rejected) {
  test(`rejects ${branch}`, () => {
    const r = run(branch)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /latc-<n>-<slug>/)
  })
}

test('rejects an empty name (detached HEAD)', () => {
  const r = run('')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /detached HEAD|no branch/i)
})

// --pre-push: git's pre-push stdin is "<local ref> <local sha> <remote ref> <remote sha>".
// The REMOTE branch name is checked: it is what lands on GitHub and what CI checks.
const SHA = 'a'.repeat(40)
const ZERO = '0'.repeat(40)
const prePush = (lines) =>
  spawnSync('bash', [SCRIPT, '--pre-push'], { encoding: 'utf8', input: lines.join('\n') + '\n' })

test('--pre-push: passes a good remote branch name', () => {
  const r = prePush([`refs/heads/whatever ${SHA} refs/heads/latc-64-waitlist ${ZERO}`])
  assert.equal(r.status, 0, r.stderr)
})

test('--pre-push: fails a bad remote branch name even from a good local branch', () => {
  const r = prePush([`refs/heads/latc-64-waitlist ${SHA} refs/heads/chore/x ${ZERO}`])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /'chore\/x' does not match latc-<n>-<slug>/)
})

test('--pre-push: fails if any one of several pushed branches is bad', () => {
  const r = prePush([
    `refs/heads/a ${SHA} refs/heads/latc-1-ok ${ZERO}`,
    `refs/heads/b ${SHA} refs/heads/feature/bad ${ZERO}`,
  ])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /feature\/bad/)
})

test('--pre-push: skips deletions and tags', () => {
  const r = prePush([
    `(delete) ${ZERO} refs/heads/chore/old ${SHA}`,
    `refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}`,
  ])
  assert.equal(r.status, 0, r.stderr)
})

test('--pre-push: no input (nothing to push) passes', () => {
  const r = spawnSync('bash', [SCRIPT, '--pre-push'], { encoding: 'utf8', input: '' })
  assert.equal(r.status, 0, r.stderr)
})
