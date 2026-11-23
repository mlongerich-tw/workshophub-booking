#!/usr/bin/env node
// Read-only Jira REST helper for what acli can't do: board column configuration, a card's
// available transitions, and any other GET on the Jira Cloud REST API.
//
//   node scripts/jira-get.mjs /rest/agile/1.0/board/22687/configuration
//   node scripts/jira-get.mjs /rest/api/3/issue/LATC-2/transitions
//   node scripts/jira-get.mjs /rest/api/3/myself
//
// GET only, and only to https://thoughtworks.atlassian.net/rest/... . The API token comes from
// the macOS Keychain item "workshophub-jira" (account = your Atlassian email). It is read here,
// sent only in the Authorization header to that host (or Atlassian's API gateway for scoped
// tokens), and never printed. Store it once, in your own terminal. Don't type it at the
// interactive `-w` prompt: that prompt silently cuts input at 128 characters and API tokens
// are longer. Copy the token, then:
//
//   security add-generic-password -U -s workshophub-jira -a <you>@thoughtworks.com -w "$(pbpaste)"; pbcopy </dev/null
//
// `node scripts/jira-get.mjs --check` describes the stored item (lengths and booleans only).
//
// .claude/hooks/cli-write-guard.mjs blocks Claude from reading Keychain items directly.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SITE = 'https://thoughtworks.atlassian.net'
export const KEYCHAIN_SERVICE = 'workshophub-jira'
const ALLOWED_PREFIXES = ['/rest/api/3/', '/rest/api/2/', '/rest/agile/1.0/']

/**
 * Turn a user-supplied REST path into a URL on the Jira site, or throw.
 * Rejects absolute URLs, other hosts, path traversal and anything outside the REST APIs,
 * so the token can only ever be sent to Jira's read endpoints.
 * @param {string} path
 * @returns {URL}
 */
export function buildUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('path must start with a single "/", e.g. /rest/api/3/myself')
  }
  if (/[\s\\]/.test(path) || /(^|\/)\.\.?(\/|$|\?)/.test(path) || /%2e|%2f|%5c/i.test(path)) {
    throw new Error('path must not contain whitespace, backslashes, dot segments or encoded / . \\')
  }
  const url = new URL(path, SITE)
  if (url.origin !== SITE) throw new Error(`refusing to send credentials to ${url.origin}`)
  if (!ALLOWED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    throw new Error(`path must start with one of: ${ALLOWED_PREFIXES.join(', ')}`)
  }
  return url
}

/** Read the Atlassian email and API token from the Keychain. Never logs either. */
function credentials() {
  const run = (args) =>
    execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  let email
  let token
  try {
    email = run(['find-generic-password', '-s', KEYCHAIN_SERVICE]).match(
      /"acct"<blob>="([^"]+)"/
    )?.[1]
    token = run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']).trim()
  } catch {
    // fall through to the message below
  }
  if (!email || !token) {
    throw new Error(
      `no Keychain item "${KEYCHAIN_SERVICE}". Ask the user to copy their API token, then run ` +
        'in their own terminal:\n' +
        `  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a <their Atlassian email> -w "$(pbpaste)"; pbcopy </dev/null`
    )
  }
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
}

/**
 * Describe the Keychain item's shape without revealing it: for debugging a 401.
 * Prints booleans and lengths only, never the email or token.
 */
function check() {
  const run = (args) =>
    execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  let email = ''
  let raw = ''
  try {
    email =
      run(['find-generic-password', '-s', KEYCHAIN_SERVICE]).match(/"acct"<blob>="([^"]*)"/)?.[1] ??
      ''
    raw = run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']).replace(/\n$/, '')
  } catch {
    process.stdout.write(`Keychain item "${KEYCHAIN_SERVICE}": missing\n`)
    return 1
  }
  const facts = {
    accountLooksLikeEmail: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email),
    accountDomain: email.split('@')[1] ?? '',
    tokenLength: raw.length,
    tokenHasWhitespace: /\s/.test(raw),
    tokenLooksLikeAtlassianApiToken: /^ATATT[A-Za-z0-9_=-]+$/.test(raw.trim()),
  }
  process.stdout.write(JSON.stringify(facts, null, 2) + '\n')
  return 0
}

export const GATEWAY = 'https://api.atlassian.com'

/**
 * The same request through the API gateway: https://api.atlassian.com/ex/jira/<cloudId>/rest/...
 * The cloud id comes from the site's public, unauthenticated tenant_info endpoint.
 * @param {URL} url a URL already validated by buildUrl
 * @returns {Promise<URL | null>}
 */
export async function gatewayUrl(url) {
  const res = await fetch(`${SITE}/_edge/tenant_info`, { redirect: 'error' })
  if (!res.ok) return null
  const { cloudId } = /** @type {{ cloudId?: unknown }} */ (await res.json())
  if (typeof cloudId !== 'string' || !/^[0-9a-f-]{36}$/i.test(cloudId)) return null
  return toGateway(url, cloudId)
}

/** @param {URL} url @param {string} cloudId */
export function toGateway(url, cloudId) {
  const out = new URL(`/ex/jira/${cloudId}${url.pathname}${url.search}`, GATEWAY)
  if (out.origin !== GATEWAY) throw new Error('gateway URL escaped api.atlassian.com')
  return out
}

async function main() {
  const [path, ...extra] = process.argv.slice(2)
  if (!path || extra.length || path === '-h' || path === '--help') {
    process.stderr.write('usage: node scripts/jira-get.mjs /rest/<api>/<path>[?query]\n')
    return path === '-h' || path === '--help' ? 0 : 1
  }
  if (path === '--check') return check()
  const url = buildUrl(path)
  const auth = credentials()
  const get = (target) =>
    fetch(target, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: auth, Accept: 'application/json' },
    })
  let res = await get(url)
  // Scoped API tokens are only accepted through Atlassian's API gateway, not the site URL.
  if (res.status === 401) {
    const gateway = await gatewayUrl(url)
    if (gateway) res = await get(gateway)
  }
  const body = await res.text()
  let out = body
  try {
    out = JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    // not JSON; print as is
  }
  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status} for GET ${url.pathname}${url.search}\n${out}\n`)
    return 1
  }
  process.stdout.write(out + '\n')
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`jira-get: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  )
}
