#!/usr/bin/env node
// Download only reviewed bytes. This stage never receives signing credentials.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const architectures = ['amd64', 'arm64']
const forkRepository = '0xJean/shellbeam-monitoring-agent'
const assetLimit = 32 * 1024 * 1024
const sameFields = (value, expected) => value && Object.keys(value).length === Object.keys(expected).length && Object.entries(expected).every(([key, entry]) => value[key] === entry)
function checkedPin(pin, limit = assetLimit) {
  if (!pin || Object.keys(pin).length !== 2 || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '') || !Number.isSafeInteger(pin.size) || pin.size <= 0 || pin.size > limit) throw new Error('reviewed_asset_pin_required')
  return pin
}
export function verifyPinnedBytes(bytes, pin, limit = assetLimit) {
  checkedPin(pin, limit)
  if (!bytes.length || bytes.length !== pin.size || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('pinned_upstream_mismatch')
  return bytes
}
export async function downloadPinned(url, pin, limit = assetLimit) {
  let current = new URL(url); const signal = AbortSignal.timeout(120000)
  for (let hop = 0; hop < 6; hop++) {
    if (current.protocol !== 'https:' || current.username || current.password || current.hash || current.port || !['github.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com'].includes(current.hostname)) throw new Error('download_host_rejected')
    const response = await fetch(current, { signal, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); if (!location) throw new Error('redirect_invalid'); await response.body?.cancel(); current = new URL(location, current); continue }
    if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('download_failed')
    const chunks = []; let count = 0
    for await (const chunk of response.body) { count += chunk.length; if (count > limit) throw new Error('download_size_exceeded'); chunks.push(chunk) }
    const bytes = Buffer.concat(chunks)
    if (!count) throw new Error('pinned_upstream_mismatch')
    return pin ? verifyPinnedBytes(bytes, pin, limit) : bytes
  }
  throw new Error('redirect_limit')
}
export async function reviewedPins() {
  return JSON.parse(await readFile(new URL('../releases/compatible-probe-pins.json', import.meta.url)))
}
export function releasePlan(version, revision, pin) {
  if (!/^1\.5\.\d+$/.test(version) || !/^[1-9]\d{0,5}$/.test(revision)) throw new Error('invalid_release_identity')
  if (!pin) throw new Error('reviewed_version_required')
  const fork = pin.source !== undefined
  const fields = fork ? ['amd64', 'arm64', 'source', 'archives'] : ['amd64', 'arm64']
  if (Object.keys(pin).length !== fields.length || fields.some(key => !(key in pin))) throw new Error('reviewed_source_invalid')
  let source
  if (fork) {
    const s = pin.source
    const expected = { repository: forkRepository, tag: `v${version}`, commit: s?.commit, upstreamVersion: s?.upstreamVersion, upstreamCommit: s?.upstreamCommit }
    if (!sameFields(s, expected) || !/^[0-9a-f]{40}$/.test(s.commit ?? '') || !/^1\.5\.\d+$/.test(s.upstreamVersion ?? '') || !/^[0-9a-f]{40}$/.test(s.upstreamCommit ?? '')
      || !pin.archives || Object.keys(pin.archives).length !== 2 || architectures.some(arch => !(arch in pin.archives))) throw new Error('reviewed_source_invalid')
    source = expected
  }
  const repository = source?.repository ?? 'komari-monitor/komari-agent'
  const upstreamTag = source?.tag ?? version
  const tag = `monitoring-probe-v${version}-r${revision}`
  const baseUrl = `https://github.com/0xJean/shellbeam/releases/download/${tag}`
  const files = architectures.map(architecture => {
    const name = `komari-agent-linux-${architecture}`
    return { name, architecture, pin: checkedPin(pin[architecture]), sourceUrl: `https://github.com/${repository}/releases/download/${upstreamTag}/${name}`, url: `${baseUrl}/${name}` }
  })
  if (fork) for (const architecture of architectures) {
    const name = `shellbeam-monitoring-agent-${version}-linux-${architecture}.tar.gz`
    files.push({ name, architecture, archive: true, pin: checkedPin(pin.archives[architecture]), sourceUrl: `https://github.com/${repository}/releases/download/${upstreamTag}/${name}`, url: `${baseUrl}/${name}` })
  }
  return { version, revision, tag, baseUrl, source, files }
}
export function releaseAssetNames(version, pin) {
  const plan = releasePlan(version, '1', pin)
  return [...plan.files.filter(f => !f.archive).map(f => f.name), 'catalog.json', 'UPSTREAM-LICENSE.txt', ...plan.files.filter(f => f.archive).map(f => f.name)]
}
export function validateReviewedSpec(spec, pins) {
  if (!spec || spec.official !== true || spec.artifacts?.length !== 2) throw new Error('reviewed_spec_mismatch')
  const version = spec.artifacts[0]?.version
  const url = spec.artifacts[0]?.url
  const match = typeof url === 'string' && /^https:\/\/github\.com\/0xJean\/shellbeam\/releases\/download\/monitoring-probe-v(1\.5\.\d+)-r([1-9]\d{0,5})\/komari-agent-linux-amd64$/.exec(url)
  if (!match || match[1] !== version) throw new Error('release_identity_mismatch')
  const plan = releasePlan(version, match[2], pins?.versions?.[version])
  if ((plan.source && !sameFields(spec.source, plan.source)) || (!plan.source && spec.source !== undefined)) throw new Error('reviewed_source_mismatch')
  for (let i = 0; i < 2; i++) {
    const entry = spec.artifacts[i]; const file = plan.files[i]
    if (!entry || entry.version !== version || entry.architecture !== file.architecture || entry.url !== file.url || entry.expectedSha256 !== file.pin.sha256 || entry.expectedSize !== file.pin.size) throw new Error('reviewed_spec_mismatch')
  }
  return plan
}
async function githubJson(path) {
  const response = await fetch(`https://api.github.com/${path}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ShellBeam-probe-release' }, redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!response.ok || Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('source_tag_read_failed')
  const chunks = []; let length = 0
  for await (const chunk of response.body) { length += chunk.length; if (length > 1024 * 1024) throw new Error('source_tag_read_failed'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks))
}
// GitHub annotated tags can point to another tag. Resolve a bounded chain and
// compare the final commit, rather than trusting a movable release tag alone.
export async function verifySourceTag(source, request = githubJson) {
  if (!source) return
  if (source.repository !== forkRepository || !/^v1\.5\.\d+$/.test(source.tag ?? '') || !/^[0-9a-f]{40}$/.test(source.commit ?? '')) throw new Error('reviewed_source_invalid')
  let object = (await request(`repos/${forkRepository}/git/ref/tags/${encodeURIComponent(source.tag)}`))?.object
  const seen = new Set()
  for (let depth = 0; depth < 6; depth++) {
    if (!object || !/^[0-9a-f]{40}$/.test(object.sha ?? '') || seen.has(object.sha)) throw new Error('source_tag_invalid')
    if (object.type === 'commit') { if (object.sha !== source.commit) throw new Error('source_tag_commit_mismatch'); return object.sha }
    if (object.type !== 'tag') throw new Error('source_tag_invalid')
    seen.add(object.sha)
    object = (await request(`repos/${forkRepository}/git/tags/${object.sha}`))?.object
  }
  throw new Error('source_tag_depth_exceeded')
}
export async function prepareRelease(version, revision, output) {
  const pins = await reviewedPins()
  const plan = releasePlan(version, revision, pins.versions?.[version])
  await verifySourceTag(plan.source)
  const root = JSON.parse(await readFile(new URL('../src-tauri/src/data/komari_agent/official-trust.json', import.meta.url)))
  const directory = resolve(output); await mkdir(directory, { mode: 0o700 }) // refuse reused output
  const artifacts = []
  for (const asset of plan.files) {
    const bytes = await downloadPinned(asset.sourceUrl, asset.pin)
    const file = join(directory, asset.name); await writeFile(file, bytes, { mode: asset.archive ? 0o600 : 0o700, flag: 'wx' })
    if (!asset.archive) artifacts.push({ file, version, architecture: asset.architecture, url: asset.url, expectedSha256: asset.pin.sha256, expectedSize: asset.pin.size })
  }
  await writeFile(join(directory, 'UPSTREAM-LICENSE.txt'), await readFile(new URL('../releases/komari-agent-LICENSE.txt', import.meta.url)), { flag: 'wx' })
  const now = Date.now()
  await writeFile(join(directory, 'spec.json'), JSON.stringify({ official: true, keyId: root.keyId, sequence: now, publishedAt: now, expiresAt: now + 90 * 86400000, artifacts, ...(plan.source ? { source: plan.source } : {}) }, null, 2) + '\n', { flag: 'wx' })
  const provenance = plan.source
    ? `ShellBeam Monitoring Agent fork, built from ${plan.source.repository} tag ${plan.source.tag}, commit ${plan.source.commit}. Based on Komari Agent ${plan.source.upstreamVersion}, commit ${plan.source.upstreamCommit}. The numeric version identifies the independently maintained ShellBeam fork. Both complete native archives are included unchanged with the fork MIT license, original attribution, upstream provenance and dependency license texts. The komari-agent executable filenames retain the managed-client compatibility contract.`
    : 'Unmodified upstream komari-monitor/komari-agent executables. Original MIT license included.'
  await writeFile(join(directory, 'release-notes.md'), `ShellBeam compatible monitoring probe ${version}, release ${revision}.\n\n${provenance}\n\nAll executables and archives are verified against reviewed SHA-256 and size pins. The signed catalog authorizes Linux amd64/arm64 only. Installation and upgrade require an explicit host operation confirmation. Existing nodes, credentials, history and audit are retained.\n`, { flag: 'wx' })
  return { tag: plan.tag, directory, artifacts: artifacts.length, assets: releaseAssetNames(version, pins.versions[version]).length }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv.length !== 5) throw new Error('version_revision_output_required'); console.log(JSON.stringify(await prepareRelease(...process.argv.slice(2)))) }
  catch (error) { console.error(/^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'compatible_release_preparation_failed'); process.exitCode = 1 }
}
