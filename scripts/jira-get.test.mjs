// Tests for jira-get.mjs URL validation. Run: node --test 'scripts/*.test.mjs' (part of `make test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildUrl, toGateway, GATEWAY, SITE } from './jira-get.mjs'

const SCRIPT = fileURLToPath(new URL('./jira-get.mjs', import.meta.url))

const allowed = [
  '/rest/agile/1.0/board/22687/configuration',
  '/rest/api/3/issue/LATC-2/transitions',
  '/rest/api/3/myself',
  '/rest/api/2/issue/LATC-2?fields=summary,status',
  '/rest/api/3/search/jql?jql=project%20%3D%20LATC',
]
for (const path of allowed) {
  test(`allows ${path}`, () => {
    const url = buildUrl(path)
    assert.equal(url.origin, SITE)
  })
}

const rejected = [
  'https://evil.example.com/rest/api/3/myself',
  '//evil.example.com/rest/api/3/myself',
  'rest/api/3/myself',
  '/rest/api/3/../../wiki/rest/api/content',
  '/rest/api/3/%2e%2e/%2e%2e/secure',
  '/rest/api/3\\..\\x',
  '/wiki/rest/api/content',
  '/rest/auth/1/session',
  '/',
  '/rest/api/3/issue/LATC-2 extra',
  '/rest/api/3/./myself',
]
for (const path of rejected) {
  test(`rejects ${path}`, () => assert.throws(() => buildUrl(path)))
}

test('cli: usage error without a path, no network', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /usage/)
})

test('cli: refuses another host before touching the Keychain', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'https://evil.example.com/rest/api/3/myself'], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /jira-get: path must start/)
})

test('gateway URL keeps path and query on api.atlassian.com', () => {
  const id = '11111111-2222-3333-4444-555555555555'
  const url = toGateway(buildUrl('/rest/api/3/issue/LATC-2/transitions?expand=x'), id)
  assert.equal(url.origin, GATEWAY)
  assert.equal(url.pathname, `/ex/jira/${id}/rest/api/3/issue/LATC-2/transitions`)
  assert.equal(url.search, '?expand=x')
})
