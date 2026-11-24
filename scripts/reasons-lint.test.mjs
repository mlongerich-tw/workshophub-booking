// Tests for reasons-lint.sh. Run: node --test 'scripts/*.test.mjs' (part of `make test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

// --- git modes: --staged, --rev, --pre-push --------------------------------
// Each test gets a throwaway repo on `main`, so the lint reads real index/commit content.
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'reasons-lint-git-'))
  const git = (...args) => {
    const r = spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, encoding: 'utf8' }
    )
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const lint = (args, input) =>
    spawnSync('bash', [SCRIPT, '--dir', 'spdd/prompt', ...args], {
      cwd: root,
      encoding: 'utf8',
      input,
    })
  git('init', '-q', '-b', 'main')
  write('README.md', 'x\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'init')
  git('switch', '-q', '-c', 'latc-64-waitlist')
  return { root, git, write, lint, done: () => rmSync(root, { recursive: true, force: true }) }
}

const CANVAS = `spdd/prompt/${NAME}`
const broken = canvas(SECTIONS.filter((s) => s !== 'Norms'))

test('--staged: fails on a broken staged canvas even when the working copy is fixed', () => {
  const r = gitRepo()
  try {
    r.write(CANVAS, broken)
    r.git('add', CANVAS)
    r.write(CANVAS, canvas())
    const out = r.lint(['--staged'])
    assert.equal(out.status, 1)
    assert.match(out.stderr, /missing section: Norms/)
  } finally {
    r.done()
  }
})

test('--staged: passes a fixed staged canvas even when the working copy is broken', () => {
  const r = gitRepo()
  try {
    r.write(CANVAS, canvas())
    r.git('add', CANVAS)
    r.write(CANVAS, broken)
    const out = r.lint(['--staged'])
    assert.equal(out.status, 0, out.stderr)
  } finally {
    r.done()
  }
})

test('--staged: ignores a broken canvas that is not staged', () => {
  const r = gitRepo()
  try {
    r.write('spdd/prompt/LATC-44-1-[Feat]-x.md', broken)
    const out = r.lint(['--staged'])
    assert.equal(out.status, 0, out.stderr)
  } finally {
    r.done()
  }
})

test('--staged: staged source needs a staged canvas for the branch card', () => {
  const r = gitRepo()
  try {
    r.write(CANVAS, canvas()) // untracked only
    r.write('api/src/x.ts', 'x\n')
    r.git('add', 'api/src/x.ts')
    const out = r.lint(['--staged'])
    assert.equal(out.status, 1)
    assert.match(out.stderr, /no REASONS canvas for LATC-64/)
  } finally {
    r.done()
  }
})

test('--staged: source committed earlier on the branch still needs a canvas', () => {
  const r = gitRepo()
  try {
    r.write('api/src/x.ts', 'x\n')
    r.git('add', 'api/src/x.ts')
    r.git('commit', '-q', '-m', 'src')
    r.write('README.md', 'y\n')
    r.git('add', 'README.md')
    const out = r.lint(['--staged'])
    assert.equal(out.status, 1)
    assert.match(out.stderr, /no REASONS canvas for LATC-64/)
  } finally {
    r.done()
  }
})

test('--rev: lints the committed canvas, not the working copy', () => {
  const r = gitRepo()
  try {
    r.write(CANVAS, broken)
    r.git('add', CANVAS)
    r.git('commit', '-q', '-m', 'canvas')
    r.write(CANVAS, canvas())
    const out = r.lint(['--rev', 'HEAD'])
    assert.equal(out.status, 1)
    assert.match(out.stderr, /missing section: Norms/)
  } finally {
    r.done()
  }
})

test('--rev: source committed without a canvas fails', () => {
  const r = gitRepo()
  try {
    r.write('app/src/App.tsx', 'x\n')
    r.git('add', 'app/src/App.tsx')
    r.git('commit', '-q', '-m', 'src')
    const out = r.lint(['--rev', 'HEAD'])
    assert.equal(out.status, 1)
    assert.match(out.stderr, /no REASONS canvas for LATC-64/)
  } finally {
    r.done()
  }
})

test('--rev: an unknown revision is a usage error', () => {
  const r = gitRepo()
  try {
    assert.equal(r.lint(['--rev', 'no-such-rev']).status, 2)
  } finally {
    r.done()
  }
})

test('--staged and --rev together is a usage error', () => {
  const r = gitRepo()
  try {
    assert.equal(r.lint(['--staged', '--rev', 'HEAD']).status, 2)
  } finally {
    r.done()
  }
})

const ZERO = '0'.repeat(40)

test('--pre-push: fails when a pushed commit has a broken canvas', () => {
  const r = gitRepo()
  try {
    r.write(CANVAS, broken)
    r.git('add', CANVAS)
    r.git('commit', '-q', '-m', 'canvas')
    const sha = r.git('rev-parse', 'HEAD')
    r.git('switch', '-q', 'main') // pushed ref, not the checkout, decides
    const out = r.lint(['--pre-push'], `refs/heads/latc-64-waitlist ${sha} refs/heads/latc-64-waitlist ${ZERO}\n`)
    assert.equal(out.status, 1)
    assert.match(out.stderr, /missing section: Norms/)
  } finally {
    r.done()
  }
})

test('--pre-push: uses the pushed branch name for the canvas requirement', () => {
  const r = gitRepo()
  try {
    r.write('api/src/x.ts', 'x\n')
    r.git('add', 'api/src/x.ts')
    r.git('commit', '-q', '-m', 'src')
    const sha = r.git('rev-parse', 'HEAD')
    const out = r.lint(['--pre-push'], `refs/heads/latc-64-waitlist ${sha} refs/heads/latc-64-waitlist ${ZERO}\n`)
    assert.equal(out.status, 1)
    assert.match(out.stderr, /no REASONS canvas for LATC-64/)
  } finally {
    r.done()
  }
})

test('--pre-push: passes a good push and skips deletions and tags', () => {
  const r = gitRepo()
  try {
    r.write(CANVAS, canvas())
    r.git('add', CANVAS)
    r.git('commit', '-q', '-m', 'canvas')
    const sha = r.git('rev-parse', 'HEAD')
    const input = [
      `refs/heads/latc-64-waitlist ${sha} refs/heads/latc-64-waitlist ${ZERO}`,
      `(delete) ${ZERO} refs/heads/old ${sha}`,
      `refs/tags/v1 ${sha} refs/tags/v1 ${ZERO}`,
      '',
    ].join('\n')
    const out = r.lint(['--pre-push'], input)
    assert.equal(out.status, 0, out.stderr)
  } finally {
    r.done()
  }
})

test('--pre-push: no input (nothing to push) passes', () => {
  const r = gitRepo()
  try {
    assert.equal(r.lint(['--pre-push'], '').status, 0)
  } finally {
    r.done()
  }
})
