import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { formatOutputs, selectSuites, suitesForPath, SUITES } from './ci-acceptance-scope.mjs'

const names = (paths) => Object.entries(selectSuites(paths)).filter(([, on]) => on).map(([suite]) => suite)

test('a colour-only change runs no suite', () => {
  assert.deepEqual(names(['src/styles/theme-palettes.css']), [])
  assert.match(formatOutputs(selectSuites(['src/styles/theme-palettes.css'])), /build=false/)
})

test('docs, unit tests and surfaces no journey opens run no suite', () => {
  assert.deepEqual(names(['docs/ci-cd.md', 'README.md', 'src/components/host-card.test.tsx', 'src/components/sftp-dual-pane.tsx', 'src/components/ai-command-bar.tsx', 'src/components/workspace/mobile/foo.tsx']), [])
})

test('layout CSS and shared components run every suite', () => {
  for (const path of ['src/index.css', 'src/styles/ui-styles.css', 'tailwind.config.ts', 'src/components/host-card.tsx', 'src/components/workspace/workspace-desktop-shell.tsx', 'src/lib/locales/en.ts', 'src/App.tsx']) {
    assert.deepEqual(suitesForPath(path), SUITES, path)
  }
})

test('native code, dependencies and the version bump run every suite', () => {
  for (const path of ['src-tauri/src/ssh/transport.rs', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/capabilities/default.json', 'package.json', 'package-lock.json']) {
    assert.deepEqual(suitesForPath(path), SUITES, path)
  }
})

test('the acceptance workflow and its helpers run every suite', () => {
  for (const path of ['.github/workflows/packaged-acceptance.yml', '.github/actions/packaged-acceptance-setup/action.yml', 'scripts/ci-with-installed-package.sh', 'scripts/ci-ubuntu-mirror.py', 'scripts/ci-acceptance-scope.mjs', 'src-tauri/tests/fixtures/notifications-session.conf']) {
    assert.deepEqual(suitesForPath(path), SUITES, path)
  }
  assert.deepEqual(suitesForPath('.github/workflows/build.yml'), [])
})

test('surface-specific paths run only the suites that open them', () => {
  assert.deepEqual(names(['src/components/notification-settings-section.tsx']), ['ops'])
  assert.deepEqual(names(['scripts/ops-ui-journey.mjs']), SUITES)
  assert.deepEqual(names(['src/components/probe-transfer-panel.tsx']), ['agent', 'probe'])
  assert.deepEqual(names(['src/components/komari-settings-section.tsx']), ['agent', 'probe', 'extension'])
  assert.deepEqual(names(['monitoring-extension/manifest.json']), ['agent', 'extension'])
  assert.deepEqual(names(['releases/compatible-probe-pins.json']), ['agent', 'probe'])
})

test('a path no rule names runs every suite', () => {
  assert.deepEqual(names(['something/new.txt']), SUITES)
})

function harnessFiles(entry) {
  const seen = new Set()
  const visit = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const [, target] of readFileSync(file, 'utf8').matchAll(/from '\.\/([^']+)'/g)) visit(join(dirname(file), target))
  }
  visit(entry)
  return seen
}

test('every script a suite imports selects that suite', () => {
  const entries = { ops: 'scripts/run-ops-ui-live.mjs', agent: 'scripts/run-monitoring-agent-ui.mjs', probe: 'scripts/run-probe-transfer-ui.mjs', extension: 'scripts/run-extension-ui.mjs' }
  for (const [suite, entry] of Object.entries(entries)) {
    for (const file of harnessFiles(entry)) assert.ok(suitesForPath(file).includes(suite), `${file} must select ${suite}`)
  }
  const opsDynamic = readFileSync(entries.ops, 'utf8').matchAll(/import\('\.\/([^']+)'\)/g)
  for (const [, target] of opsDynamic) {
    for (const file of harnessFiles(`scripts/${target}`)) assert.ok(suitesForPath(file).includes('ops'), `${file} must select ops`)
  }
})

test('each journey shell entry selects its suite', () => {
  assert.ok(suitesForPath('scripts/ci-ops-ui-live.sh').includes('ops'))
  assert.ok(suitesForPath('scripts/ci-monitoring-agent-ui.sh').includes('agent'))
  assert.ok(suitesForPath('scripts/ci-probe-transfer-ui.sh').includes('probe'))
  assert.ok(suitesForPath('scripts/ci-extension-ui.sh').includes('extension'))
})
