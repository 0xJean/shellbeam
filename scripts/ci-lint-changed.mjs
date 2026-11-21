#!/usr/bin/env node
// Runs ESLint with --max-warnings=0 on TS/TSX files added or modified since a
// base ref, so PRs cannot introduce new lint errors or warnings while legacy
// baseline debt is paid down separately.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const IGNORED_PREFIXES = ['dist/', 'node_modules/', 'src-tauri/target/']

export function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function filterLintTargets(paths, fileExists = existsSync) {
  const seen = new Set()
  const targets = []
  for (const raw of paths) {
    const p = normalizePath(raw.trim())
    if (!p || seen.has(p)) continue
    if (IGNORED_PREFIXES.some((prefix) => p.startsWith(prefix))) continue
    if (!/\.(ts|tsx)$/.test(p)) continue
    if (!fileExists(p)) continue
    seen.add(p)
    targets.push(p)
  }
  return targets
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
  const targets = filterLintTargets(listChangedFiles(base))
  if (targets.length === 0) {
    console.log(`No changed TS/TSX files against ${base}; skipping ESLint.`)
    return
  }
  console.log(`Running ESLint (--max-warnings=0) on ${targets.length} changed file(s)...`)
  const eslintBin = resolve('node_modules', 'eslint', 'bin', 'eslint.js')
  const result = spawnSync(process.execPath, [eslintBin, '--max-warnings=0', ...targets], {
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
