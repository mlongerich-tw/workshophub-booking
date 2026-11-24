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
