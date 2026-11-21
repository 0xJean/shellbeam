import assert from 'node:assert/strict'
import test from 'node:test'
import { filterLintTargets } from './ci-lint-changed.mjs'
import { extractMatchingDiagnostics, filterRustTargets } from './ci-clippy-changed.mjs'

test('filterLintTargets keeps only existing TS/TSX files outside ignored dirs', () => {
  const files = [
    'src/App.tsx',
    'src\\lib\\command-risk.ts',
    'dist/index.ts',
    'README.md',
    'src-tauri/src/lib.rs',
    'src/App.tsx',
    'src/deleted.ts',
  ]
  const existing = new Set(['src/App.tsx', 'src/lib/command-risk.ts'])
  assert.deepEqual(
    filterLintTargets(files, (p) => existing.has(p)),
    ['src/App.tsx', 'src/lib/command-risk.ts'],
  )
})

test('filterRustTargets keeps only existing src-tauri Rust files', () => {
  const files = [
    'src-tauri/src/ai_cli.rs',
    'src-tauri\\src\\bar_layout.rs',
    'agent/src/main.rs',
    'src-tauri/Cargo.toml',
    'src-tauri/src/removed.rs',
  ]
  const existing = new Set(['src-tauri/src/ai_cli.rs', 'src-tauri/src/bar_layout.rs'])
  assert.deepEqual(
    filterRustTargets(files, (p) => existing.has(p)),
    ['src-tauri/src/ai_cli.rs', 'src-tauri/src/bar_layout.rs'],
  )
})

test('extractMatchingDiagnostics reports warnings/errors only in changed Rust files', () => {
  const payload = [
    JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'warning',
        rendered: 'warning: dead_code in bar_layout.rs',
        spans: [{ file_name: 'src/bar_layout.rs' }],
      },
    }),
    JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'warning',
        rendered: 'warning: legacy clippy in untouched.rs',
        spans: [{ file_name: 'src/untouched.rs' }],
      },
    }),
    JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'note',
        rendered: 'note: informational',
        spans: [{ file_name: 'src/bar_layout.rs' }],
      },
    }),
    JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'error',
        rendered: 'error: windows path match',
        spans: [{ file_name: 'src-tauri\\src\\ai_cli.rs' }],
      },
    }),
  ].join('\n')

  const matches = extractMatchingDiagnostics(payload, [
    'src-tauri/src/bar_layout.rs',
    'src-tauri/src/ai_cli.rs',
  ])
  assert.equal(matches.length, 2)
  assert.equal(matches[0].level, 'warning')
  assert.equal(matches[1].level, 'error')
})
