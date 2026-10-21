#!/usr/bin/env node
// Publish a verified draft first, then atomically advance the signed feed.
// This script never reads the signing key or any application Vault.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { downloadPinned } from './prepare-komari-agent-release.mjs'
import { verifyCompatibleCatalog } from './publish-komari-agent.mjs'
const repo = '0xJean/shellbeam'; const branch = 'monitoring-probe-releases'
function gh(args, input) { return execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024, timeout: 180000 }) }
function api(path, body, method) { return JSON.parse(gh(['api', `repos/${repo}/${path}`, ...(body ? ['--method', method ?? 'POST', '--input', '-'] : [] )], body ? JSON.stringify(body) : undefined)) }
function optional(path) {
  try { return api(path) } catch (error) { if (String(error.stderr).includes('HTTP 404')) return null; throw new Error('release_read_failed') }
}
function releaseByTag(tag) {
  // GitHub's tag endpoint does not resolve an unpublished draft's tag.
  const published = optional(`releases/tags/${tag}`)
  if (published) return published
  const drafts = api('releases?per_page=100').filter(r => r.draft && r.tag_name === tag)
  if (drafts.length > 1) throw new Error('ambiguous_release_draft')
  return drafts[0] ?? null
}
export function requireForwardCatalog(previous, next) {
  if (previous && (next.sequence <= previous.sequence || Number(next.artifacts[0].version.split('.')[2]) < Number(previous.artifacts[0].version.split('.')[2]))) throw new Error('catalog_not_forward')
}
export function validateResumedCatalog(catalog, spec, root, now = Date.now()) {
  verifyCompatibleCatalog(catalog, root, now)
  if (spec.artifacts.length !== catalog.artifacts.length || spec.artifacts.some((entry, i) => {
    const m = catalog.artifacts[i]
    return entry.version !== m.version || entry.architecture !== m.architecture || entry.url !== m.url || entry.expectedSha256 !== m.sha256 || entry.expectedSize !== m.sizeBytes
  })) throw new Error('resumed_catalog_mismatch')
  return catalog
}
export async function resumeCatalog(directory, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('source_commit_required')
  const spec = JSON.parse(await readFile(join(directory, 'spec.json')))
  const tag = new URL(spec.artifacts[0].url).pathname.split('/')[5]
  if (!/^monitoring-probe-v1\.5\.\d+-r[1-9]\d{0,5}$/.test(tag)) throw new Error('release_identity_mismatch')
  const release = releaseByTag(tag)
  if (!release) return { resumed: false }
  if (release.target_commitish !== commit) throw new Error('release_target_changed')
  if (!release.assets.some(a => a.name === 'catalog.json')) {
    if (!release.draft) throw new Error('published_asset_missing')
    return { resumed: false }
  }
  const raw = gh(['release', 'download', tag, '--repo', repo, '--pattern', 'catalog.json', '--output', '-'])
  if (Buffer.byteLength(raw) > 65536) throw new Error('catalog_size_exceeded')
  const root = JSON.parse(await readFile(new URL('../src-tauri/src/data/komari_agent/official-trust.json', import.meta.url)))
  const catalog = validateResumedCatalog(JSON.parse(raw), spec, root)
  await writeFile(join(directory, 'catalog.json'), raw, { flag: 'wx', mode: 0o644 })
  return { resumed: true, sequence: catalog.sequence }
}
export async function promote(directory, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('source_commit_required')
  const root = JSON.parse(await readFile(new URL('../src-tauri/src/data/komari_agent/official-trust.json', import.meta.url)))
  const catalogBytes = await readFile(join(directory, 'catalog.json'))
  const catalog = verifyCompatibleCatalog(JSON.parse(catalogBytes), root)
  const tag = new URL(catalog.artifacts[0].url).pathname.split('/')[5]
  if (!/^monitoring-probe-v1\.5\.\d+-r[1-9]\d{0,5}$/.test(tag) || catalog.artifacts.some(m => !m.url.includes(`/download/${tag}/`))) throw new Error('release_identity_mismatch')
  const feedPath = `contents/stable/catalog.json?ref=${branch}`
  const prior = optional(feedPath)
  let alreadyAdvertised = false
  if (prior) {
    const previous = JSON.parse(Buffer.from(prior.content, 'base64'))
    verifyCompatibleCatalog(previous, root, previous.publishedAt)
    alreadyAdvertised = previous.sequence === catalog.sequence && previous.signature === catalog.signature
    if (!alreadyAdvertised) requireForwardCatalog(previous, catalog)
  }
  for (const m of catalog.artifacts) {
    const bytes = await readFile(join(directory, `komari-agent-linux-${m.architecture}`))
    if (bytes.length !== m.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== m.sha256) throw new Error('local_artifact_mismatch')
  }
  let release = releaseByTag(tag)
  if (!release) {
    gh(['release', 'create', tag, '--repo', repo, '--draft', '--latest=false', '--target', commit, '--title', `Compatible monitoring probe ${catalog.artifacts[0].version}`, '--notes-file', join(directory, 'release-notes.md')])
    release = releaseByTag(tag)
  }
  if (release.target_commitish !== commit) throw new Error('release_target_changed')
  const names = ['komari-agent-linux-amd64', 'komari-agent-linux-arm64', 'catalog.json', 'UPSTREAM-LICENSE.txt']
  if (release.assets.some(a => !names.includes(a.name))) throw new Error('unexpected_release_asset')
  for (const name of names) {
    if (!release.assets.some(a => a.name === name)) {
      if (!release.draft) throw new Error('published_asset_missing')
      gh(['release', 'upload', tag, join(directory, name), '--repo', repo])
    }
  }
  const checkDir = await mkdtemp(join(tmpdir(), 'shellbeam-probe-release-verify-'))
  try {
    gh(['release', 'download', tag, '--repo', repo, '--dir', checkDir])
    for (const name of names) {
      if (!(await readFile(join(directory, name))).equals(await readFile(join(checkDir, name)))) throw new Error('uploaded_asset_mismatch')
    }
  } finally { await rm(checkDir, { recursive: true, force: true }) }
  if (release.draft) gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest=false'])
  // Do not advertise a release that anonymous application downloads cannot read.
  for (const m of catalog.artifacts) await downloadPinned(m.url, { size: m.sizeBytes, sha256: m.sha256 })
  const content = catalogBytes.toString('base64')
  if (alreadyAdvertised) {
    // A retry after the feed response was lost only verifies existing bytes.
  } else if (prior) {
    api('contents/stable/catalog.json', { branch, sha: prior.sha, message: `Publish signed probe catalog ${catalog.sequence}`, content }, 'PUT')
  } else {
    // Refuse to adopt an unrelated existing branch or recreate missing history.
    if (optional(`git/ref/heads/${branch}`)) throw new Error('feed_history_missing')
    const blob = api('git/blobs', { content, encoding: 'base64' })
    const tree = api('git/trees', { tree: [{ path: 'stable/catalog.json', mode: '100644', type: 'blob', sha: blob.sha }] })
    const head = api('git/commits', { message: 'Initialize signed compatible probe feed', tree: tree.sha, parents: [] })
    api('git/refs', { ref: `refs/heads/${branch}`, sha: head.sha })
  }
  const published = verifyCompatibleCatalog(JSON.parse(await downloadPinned(root.catalogUrl, null, 65536)), root)
  if (published.sequence !== catalog.sequence || published.signature !== catalog.signature) throw new Error('feed_publication_not_verified')
  return { tag, sequence: catalog.sequence, published: true, catalogVerified: true }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2); const resume = args[0] === '--resume-catalog'; if (resume) args.shift()
    if (args.length !== 2) throw new Error('directory_commit_required')
    console.log(JSON.stringify(await (resume ? resumeCatalog : promote)(resolve(args[0]), args[1])))
  }
  catch (error) { console.error(/^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'compatible_release_promotion_failed'); process.exitCode = 1 }
}
