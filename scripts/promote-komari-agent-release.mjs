#!/usr/bin/env node
// Publish a verified draft first, then atomically advance the signed feed.
// This script never reads the signing key or any application Vault.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm, lstat, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { downloadPinned, reviewedPins, releaseAssetNames, validateReviewedSpec, verifyPinnedBytes, verifySourceTag } from './prepare-komari-agent-release.mjs'
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
export function validateExistingRelease(release, commit, names, complete = false) {
  if (release.target_commitish !== commit) throw new Error('release_target_changed')
  const present = release.assets.map(asset => asset.name)
  if (new Set(present).size !== present.length || present.some(name => !names.includes(name))) throw new Error('unexpected_release_asset')
  if ((complete || !release.draft) && names.some(name => !present.includes(name))) throw new Error('published_asset_missing')
}
async function regularAsset(directory, name) {
  const file = join(directory, name)
  const stat = await lstat(file)
  const limit = name === 'catalog.json' ? 65536 : 32 * 1024 * 1024
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > limit) throw new Error('invalid_release_asset_file')
  return readFile(file)
}
// Pinned archive bytes are checked exactly like executable bytes. The complete
// native archives carry the fork attribution and dependency license texts.
export async function validateLocalRelease(directory, spec, pins) {
  const plan = validateReviewedSpec(spec, pins)
  for (const file of plan.files) {
    verifyPinnedBytes(await regularAsset(directory, file.name), file.pin)
    if (!file.archive && resolve(spec.artifacts.find(a => a.architecture === file.architecture).file ?? '') !== resolve(directory, file.name)) throw new Error('reviewed_spec_file_mismatch')
  }
  const license = await readFile(new URL('../releases/komari-agent-LICENSE.txt', import.meta.url))
  if (!license.equals(await regularAsset(directory, 'UPSTREAM-LICENSE.txt'))) throw new Error('release_license_mismatch')
  return plan
}
export async function verifyAssetCopies(directory, copyDirectory, names) {
  const actual = await readdir(copyDirectory)
  if (actual.length !== names.length || actual.some(name => !names.includes(name))) throw new Error('unexpected_release_asset')
  for (const name of names) {
    if (!(await regularAsset(directory, name)).equals(await regularAsset(copyDirectory, name))) throw new Error('uploaded_asset_mismatch')
  }
}
async function existingAssetCopies(directory, release, tag, skipCatalog = false) {
  const names = release.assets.map(asset => asset.name)
  if (!names.length) return null
  const checkDir = await mkdtemp(join(tmpdir(), 'shellbeam-probe-release-verify-'))
  try {
    gh(['release', 'download', tag, '--repo', repo, '--dir', checkDir])
    if (!skipCatalog) { await verifyAssetCopies(directory, checkDir, names); return null }
    const actual = await readdir(checkDir)
    if (actual.length !== names.length || actual.some(name => !names.includes(name))) throw new Error('unexpected_release_asset')
    let catalog
    for (const name of names) {
      const bytes = await regularAsset(checkDir, name)
      if (name === 'catalog.json' && skipCatalog) catalog = bytes
      else if (!(await regularAsset(directory, name)).equals(bytes)) throw new Error('uploaded_asset_mismatch')
    }
    return catalog
  } finally { await rm(checkDir, { recursive: true, force: true }) }
}
async function workspace(directory) {
  const spec = JSON.parse(await readFile(join(directory, 'spec.json')))
  const pins = await reviewedPins()
  const plan = await validateLocalRelease(directory, spec, pins)
  const root = JSON.parse(await readFile(new URL('../src-tauri/src/data/komari_agent/official-trust.json', import.meta.url)))
  if (spec.keyId !== root.keyId) throw new Error('production_key_mismatch')
  await verifySourceTag(plan.source)
  return { spec, plan, root, names: releaseAssetNames(plan.version, pins.versions[plan.version]) }
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
  const { spec, plan, root, names } = await workspace(directory)
  const tag = plan.tag
  const release = releaseByTag(tag)
  if (!release) return { resumed: false }
  validateExistingRelease(release, commit, names)
  const raw = await existingAssetCopies(directory, release, tag, true)
  if (!release.assets.some(a => a.name === 'catalog.json')) {
    return { resumed: false }
  }
  const catalog = validateResumedCatalog(JSON.parse(raw), spec, root)
  await writeFile(join(directory, 'catalog.json'), raw, { flag: 'wx', mode: 0o644 })
  return { resumed: true, sequence: catalog.sequence }
}
export async function promote(directory, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('source_commit_required')
  const { spec, plan, root, names } = await workspace(directory)
  const catalogBytes = await regularAsset(directory, 'catalog.json')
  const catalog = validateResumedCatalog(JSON.parse(catalogBytes), spec, root)
  const tag = plan.tag
  const feedPath = `contents/stable/catalog.json?ref=${branch}`
  const prior = optional(feedPath)
  let alreadyAdvertised = false
  if (prior) {
    const previous = JSON.parse(Buffer.from(prior.content, 'base64'))
    verifyCompatibleCatalog(previous, root, previous.publishedAt)
    alreadyAdvertised = previous.sequence === catalog.sequence && previous.signature === catalog.signature
    if (!alreadyAdvertised) requireForwardCatalog(previous, catalog)
  }
  let release = releaseByTag(tag)
  if (!release) {
    gh(['release', 'create', tag, '--repo', repo, '--draft', '--latest=false', '--target', commit, '--title', `Compatible monitoring probe ${catalog.artifacts[0].version}`, '--notes-file', join(directory, 'release-notes.md')])
    release = releaseByTag(tag)
  }
  validateExistingRelease(release, commit, names)
  // Never replace existing assets, including an interrupted draft. Compare all
  // present bytes before uploading any missing assets or publishing the release.
  await existingAssetCopies(directory, release, tag)
  for (const name of names) {
    if (!release.assets.some(a => a.name === name)) {
      gh(['release', 'upload', tag, join(directory, name), '--repo', repo])
    }
  }
  release = releaseByTag(tag)
  validateExistingRelease(release, commit, names, true)
  await existingAssetCopies(directory, release, tag)
  if (release.draft) gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest=false'])
  // Do not advertise a release that anonymous application downloads cannot read.
  for (const name of names) {
    const bytes = await regularAsset(directory, name)
    await downloadPinned(`${plan.baseUrl}/${name}`, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, name === 'catalog.json' ? 65536 : 32 * 1024 * 1024)
  }
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
