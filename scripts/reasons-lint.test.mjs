// Tests for reasons-lint.sh. Run: node --test 'scripts/*.test.mjs' (part of `make test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./reasons-lint.sh', import.meta.url))
const SECTIONS = [
  'Requirements',
  'Entities',
  'Approach',
  'Structure',
  'Operations',
  'Norms',
  'Safeguards',
]

const canvas = (sections = SECTIONS, body = (s) => `Content for ${s}.`) =>
  `# Title\n\n${sections.map((s) => `## ${s}\n\n${body(s)}\n`).join('\n')}`

// files: { name: content }. changed: list of changed paths passed after `--`.
function lint({ files = {}, branch = 'latc-64-waitlist', changed = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reasons-lint-'))
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    return spawnSync('bash', [SCRIPT, '--dir', dir, '--branch', branch, '--', ...changed], {
      encoding: 'utf8',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const NAME = 'LATC-64-202611231436-[Feat]-api-waitlist.md'

test('passes a complete canvas', () => {
  const r = lint({ files: { [NAME]: canvas() } })
  assert.equal(r.status, 0, r.stderr)
})

test('passes with no canvases and no source changes', () => {
  const r = lint({ changed: ['README.md', 'api/tests/unit/x.test.ts'] })
  assert.equal(r.status, 0, r.stderr)
})

for (const missing of SECTIONS) {
  test(`fails when ## ${missing} is missing`, () => {
    const r = lint({ files: { [NAME]: canvas(SECTIONS.filter((s) => s !== missing)) } })
    assert.equal(r.status, 1)
    assert.match(r.stderr, new RegExp(`missing section: ${missing}`))
    assert.match(r.stderr, new RegExp(NAME.replace(/[[\]]/g, '\\$&')))
  })
}

test('fails when sections are out of order', () => {
  const swapped = [...SECTIONS]
  ;[swapped[1], swapped[2]] = [swapped[2], swapped[1]]
  const r = lint({ files: { [NAME]: canvas(swapped) } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /out of order/)
})

test('fails when a section is empty', () => {
  const r = lint({ files: { [NAME]: canvas(SECTIONS, (s) => (s === 'Norms' ? '   ' : 'x')) } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /empty section: Norms/)
})

test('a section holding only ### subheadings counts as empty', () => {
  const r = lint({ files: { [NAME]: canvas(SECTIONS, (s) => (s === 'Approach' ? '### Sub' : 'x')) } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /empty section: Approach/)
})

test('ignores ## lines inside code fences', () => {
  const body = (s) => (s === 'Entities' ? '```\n## Approach\n```' : 'x')
  const r = lint({ files: { [NAME]: canvas(SECTIONS, body) } })
  assert.equal(r.status, 0, r.stderr)
})

test('fails when a section is duplicated', () => {
  const r = lint({ files: { [NAME]: canvas([...SECTIONS, 'Norms']) } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /duplicate section: Norms/)
})

test('checks every canvas, not only the branch one', () => {
  const r = lint({
    files: { [NAME]: canvas(), 'LATC-44-1-[Feat]-x.md': canvas(SECTIONS.slice(0, 3)) },
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /LATC-44-1-\[Feat\]-x\.md/)
})

test('requires a canvas for the branch card when api/src changes', () => {
  const r = lint({ changed: ['api/src/services/registrationService.ts'] })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no REASONS canvas for LATC-64/)
})

test('requires a canvas for the branch card when app/src changes', () => {
  const r = lint({ files: { 'LATC-44-1-[Feat]-x.md': canvas() }, changed: ['app/src/App.tsx'] })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no REASONS canvas for LATC-64/)
})

test('passes source changes when the branch card has a canvas', () => {
  const r = lint({ files: { [NAME]: canvas() }, changed: ['api/src/routes/x.ts'] })
  assert.equal(r.status, 0, r.stderr)
})

test('does not match a canvas for a card with a longer number (LATC-640)', () => {
  const r = lint({
    files: { 'LATC-640-1-[Feat]-x.md': canvas() },
    changed: ['api/src/routes/x.ts'],
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no REASONS canvas for LATC-64/)
})

test('latc-xx branches never require a canvas', () => {
  const r = lint({ branch: 'latc-xx-dev-sensors', changed: ['api/src/routes/x.ts'] })
  assert.equal(r.status, 0, r.stderr)
})

test('non-story branches never require a canvas', () => {
  const r = lint({ branch: 'main', changed: ['api/src/routes/x.ts'] })
  assert.equal(r.status, 0, r.stderr)
})
