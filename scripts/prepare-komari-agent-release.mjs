#!/usr/bin/env node
// Download only reviewed, pinned upstream bytes. No signing key in this stage.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
export async function downloadPinned(url, pin, limit = 32 * 1024 * 1024) {
  let current = new URL(url); const signal = AbortSignal.timeout(120000)
  for (let hop = 0; hop < 6; hop++) {
    if (current.protocol !== 'https:' || current.username || current.password || current.hash || !['github.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com'].includes(current.hostname)) throw new Error('download_host_rejected')
    const response = await fetch(current, { signal, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); if (!location) throw new Error('redirect_invalid'); await response.body?.cancel(); current = new URL(location, current); continue }
    if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('download_failed')
    const chunks = []; let count = 0
    for await (const chunk of response.body) { count += chunk.length; if (count > limit) throw new Error('download_size_exceeded'); chunks.push(chunk) }
    const bytes = Buffer.concat(chunks)
    if (!count || (pin && (count !== pin.size || createHash('sha256').update(bytes).digest('hex') !== pin.sha256))) throw new Error('pinned_upstream_mismatch')
    return bytes
  }
  throw new Error('redirect_limit')
}
export async function prepareRelease(version, revision, output) {
  if (!/^1\.5\.\d+$/.test(version) || !/^[1-9]\d{0,5}$/.test(revision)) throw new Error('invalid_release_identity')
  const pins = JSON.parse(await readFile(new URL('../releases/compatible-probe-pins.json', import.meta.url)))
  const pin = pins.versions[version]; if (!pin) throw new Error('reviewed_version_required')
  const root = JSON.parse(await readFile(new URL('../src-tauri/src/data/komari_agent/official-trust.json', import.meta.url)))
  const directory = resolve(output); await mkdir(directory, { mode: 0o700 }) // refuse reused output
  const tag = `monitoring-probe-v${version}-r${revision}`; const artifacts = []
  for (const architecture of ['amd64', 'arm64']) {
    const name = `komari-agent-linux-${architecture}`
    const bytes = await downloadPinned(`https://github.com/komari-monitor/komari-agent/releases/download/${version}/${name}`, pin[architecture])
    const file = join(directory, name); await writeFile(file, bytes, { mode: 0o700, flag: 'wx' })
    artifacts.push({ file, version, architecture, url: `https://github.com/0xJean/shellbeam/releases/download/${tag}/${name}`, expectedSha256: pin[architecture].sha256, expectedSize: pin[architecture].size })
  }
  // The MIT notice accompanies the unmodified upstream executables.
  await writeFile(join(directory, 'UPSTREAM-LICENSE.txt'), await readFile(new URL('../releases/komari-agent-LICENSE.txt', import.meta.url)), { flag: 'wx' })
  const now = Date.now()
  await writeFile(join(directory, 'spec.json'), JSON.stringify({ official: true, keyId: root.keyId, sequence: now, publishedAt: now, expiresAt: now + 90 * 86400000, artifacts }, null, 2) + '\n', { flag: 'wx' })
  await writeFile(join(directory, 'release-notes.md'), `ShellBeam compatible monitoring probe ${version}, release ${revision}.\n\nUnmodified upstream komari-monitor/komari-agent executables, verified against reviewed SHA-256 and size pins. MIT license included. The signed catalog authorizes Linux amd64/arm64 only. Installation and upgrade still require an explicit host operation confirmation. Existing nodes, credentials, history and audit are retained.\n`, { flag: 'wx' })
  return { tag, directory, artifacts: artifacts.length }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv.length !== 5) throw new Error('version_revision_output_required'); console.log(JSON.stringify(await prepareRelease(...process.argv.slice(2)))) }
  catch { console.error('compatible_release_preparation_failed'); process.exitCode = 1 }
}
