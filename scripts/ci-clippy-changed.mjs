#!/usr/bin/env node
// Runs cargo clippy on src-tauri and fails if any compiler or clippy warning
// or error originates in a Rust file added or modified since a base ref.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function filterRustTargets(paths, fileExists = existsSync) {
  const seen = new Set()
  const targets = []
  for (const raw of paths) {
    const p = normalizePath(raw.trim())
    if (!p || seen.has(p)) continue
    if (!p.startsWith('src-tauri/') || !p.endsWith('.rs')) continue
    if (!fileExists(p)) continue
    seen.add(p)
    targets.push(p)
  }
  return targets
}

export function toRepoRustPath(spanFileName) {
  const normalized = normalizePath(spanFileName)
  if (normalized.startsWith('src-tauri/')) return normalized
  return `src-tauri/${normalized}`
}

export function extractMatchingDiagnostics(jsonLines, changedRustFiles) {
  const changedSet = new Set(changedRustFiles.map(normalizePath))
  const matches = []
  for (const line of jsonLines.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let entry
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (entry.reason !== 'compiler-message' || !entry.message) continue
    const { level, spans = [], rendered, message } = entry.message
    if (level !== 'warning' && level !== 'error') continue
    const hitsChanged = spans.some((span) => {
      if (!span || !span.file_name) return false
      return changedSet.has(toRepoRustPath(span.file_name))
    })
    if (hitsChanged) {
      matches.push({ level, rendered: rendered || message || '' })
    }
  }
  return matches
}

export function parseArgs(argv) {
  let base = process.env.GITHUB_BASE_SHA || 'origin/main'
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base' && argv[i + 1]) {
      base = argv[i + 1]
      i += 1
    }
  }
  return { base }
}

function listChangedFiles(base) {
  let diff = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], {
    encoding: 'utf8',
  })
  if (diff.status !== 0) {
    diff = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD'], {
      encoding: 'utf8',
    })
  }
  if (diff.status !== 0) {
    throw new Error(`git diff failed against ${base}: ${(diff.stderr || '').trim()}`)
  }
  return diff.stdout.split(/\r?\n/).filter(Boolean)
}

function main() {
  const { base } = parseArgs(process.argv.slice(2))
  const targets = filterRustTargets(listChangedFiles(base))
  if (targets.length === 0) {
    console.log(`No changed src-tauri Rust files against ${base}; skipping clippy gate.`)
    return
  }
  console.log(`Running cargo clippy gate for ${targets.length} changed Rust file(s)...`)
  const result = spawnSync(
    'cargo',
    [
      'clippy',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--locked',
      '--all-targets',
      '--message-format=json',
      '--',
      '-W',
      'clippy::all',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.error) throw result.error

  const matches = extractMatchingDiagnostics(result.stdout || '', targets)
  if (matches.length > 0) {
    console.error(`Found ${matches.length} clippy/compiler diagnostic(s) in changed Rust files:\n`)
    for (const item of matches) {
      console.error(item.rendered)
    }
    process.exit(1)
  }

  if (result.status !== 0) {
    console.error(result.stderr || 'cargo clippy failed with non-zero exit status')
    process.exit(result.status ?? 1)
  }

  console.log(`Clippy gate passed: 0 warnings/errors in ${targets.length} changed Rust file(s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
