#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Independent runtime/domain: a ShellBeam Agent signature cannot authorize this binary. */
export function canonicalCompatibleAgent(m) {
  return Buffer.from('shellbeam/komari-agent/v1\n' + JSON.stringify({ runtime: m.runtime, version: m.version, platform: m.platform, architecture: m.architecture, url: m.url, sha256: m.sha256, sizeBytes: m.sizeBytes }))
}
export function signCompatibleAgent({ bytes, version, architecture, url, expectedSha256, expectedSize, privateKey }) {
  const parsed = new URL(url)
  if (!/^1\.5\.\d+$/.test(version) || !['amd64', 'arm64'].includes(architecture) || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('invalid_release')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024 || sha256 !== expectedSha256 || bytes.length !== expectedSize) throw new Error('upstream_artifact_mismatch')
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('ed25519_key_required')
  const manifest = { runtime: 'komari', version, platform: 'linux', architecture, url, sha256, sizeBytes: bytes.length }
  return { ...manifest, signature: sign(null, canonicalCompatibleAgent(manifest), key).toString('base64') }
}
export function canonicalCompatibleCatalog(c) {
  return Buffer.from('shellbeam/komari-agent-catalog/v1\n' + JSON.stringify({ schemaVersion: c.schemaVersion, keyId: c.keyId, channel: c.channel, sequence: c.sequence, publishedAt: c.publishedAt, expiresAt: c.expiresAt, artifacts: c.artifacts }))
}
export function signCompatibleCatalog({ artifacts, keyId, sequence, publishedAt, expiresAt }, privateKey, expectedPublicKey) {
  const key = createPrivateKey(privateKey)
  const actual = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  if (actual !== expectedPublicKey || key.asymmetricKeyType !== 'ed25519') throw new Error('production_key_mismatch')
  const c = { schemaVersion: 1, keyId, channel: 'stable', sequence, publishedAt, expiresAt, artifacts }
  const signed = { ...c, signature: sign(null, canonicalCompatibleCatalog(c), key).toString('base64') }
  verifyCompatibleCatalog(signed, { keyId, publicKey: expectedPublicKey, minimumSequence: 1 }, publishedAt)
  return signed
}
export function verifyCompatibleCatalog(c, root, now = Date.now()) {
  const fields = ['schemaVersion', 'keyId', 'channel', 'sequence', 'publishedAt', 'expiresAt', 'artifacts', 'signature']
  if (!c || Object.keys(c).length !== fields.length || fields.some(f => !(f in c)) || c.schemaVersion !== 1 || c.keyId !== root.keyId || c.channel !== 'stable'
    || !Number.isSafeInteger(c.sequence) || c.sequence < root.minimumSequence || !Number.isSafeInteger(c.publishedAt) || !Number.isSafeInteger(c.expiresAt)
    || c.publishedAt <= 0 || c.publishedAt > now + 300000 || c.expiresAt <= now || c.expiresAt <= c.publishedAt || c.expiresAt - c.publishedAt > 180 * 86400000
    || c.artifacts?.length !== 2 || c.artifacts[0]?.architecture !== 'amd64' || c.artifacts[1]?.architecture !== 'arm64' || c.artifacts[0].version !== c.artifacts[1].version) throw new Error('official_catalog_invalid')
  const raw = Buffer.from(root.publicKey, 'base64'); if (raw.length !== 32) throw new Error('production_key_invalid')
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki', format: 'der' })
  if (!verify(null, canonicalCompatibleCatalog(c), key, Buffer.from(c.signature, 'base64'))) throw new Error('catalog_signature_invalid')
  for (const m of c.artifacts) {
    const keys = ['runtime', 'version', 'platform', 'architecture', 'url', 'sha256', 'sizeBytes', 'signature']
    if (Object.keys(m).length !== keys.length || keys.some(k => !(k in m)) || m.runtime !== 'komari' || m.platform !== 'linux' || !/^1\.5\.\d+$/.test(m.version)
      || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.sizeBytes) || m.sizeBytes <= 0 || m.sizeBytes > 32 * 1024 * 1024) throw new Error('official_artifact_invalid')
    const prefix = `https://github.com/0xJean/shellbeam/releases/download/monitoring-probe-v${m.version}-r`
    if (!m.url.startsWith(prefix) || !new RegExp(`^\\d+/komari-agent-linux-${m.architecture}$`).test(m.url.slice(prefix.length))) throw new Error('official_artifact_url_invalid')
    if (!verify(null, canonicalCompatibleAgent(m), key, Buffer.from(m.signature, 'base64'))) throw new Error('artifact_signature_invalid')
  }
  return c
}
async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 6 || args[0] !== '--spec' || args[2] !== '--key' || args[4] !== '--out') throw new Error('usage: --spec specification.json --key private-key.pem --out catalog.json')
  const keyPath = resolve(args[3]); const stat = await lstat(keyPath)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16384) throw new Error('private_key_file_requires_private_permissions')
  const privateKey = await readFile(keyPath); const spec = JSON.parse(await readFile(resolve(args[1]), 'utf8'))
  if (!Array.isArray(spec.artifacts) || spec.artifacts.length === 0 || spec.artifacts.length > 32) throw new Error('invalid_specification')
  const artifacts = []; const identities = new Set()
  for (const entry of spec.artifacts) {
    const identity = `${entry.version}/${entry.architecture}`
    if (identities.has(identity)) throw new Error('duplicate_release')
    identities.add(identity)
    const stat = await lstat(entry.file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('invalid_artifact_file')
    artifacts.push(signCompatibleAgent({ ...entry, bytes: await readFile(entry.file), privateKey }))
  }
  const publicKey = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  let catalog = { artifacts }
  if (spec.official) {
    const root = JSON.parse(await readFile(new URL('../src-tauri/src/data/komari_agent/official-trust.json', import.meta.url)))
    if (spec.keyId !== root.keyId) throw new Error('production_key_mismatch')
    catalog = signCompatibleCatalog({ ...spec, artifacts }, privateKey, root.publicKey)
  }
  await writeFile(resolve(args[5]), JSON.stringify(catalog, null, 2) + '\n', { mode: 0o644, flag: 'wx' })
  console.log(JSON.stringify({ signedArtifacts: artifacts.length, publicKey }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main() } catch (error) { console.error(error instanceof Error && /^[a-z0-9_: .-]+$/i.test(error.message) ? error.message : 'compatible_agent_publication_failed'); process.exitCode = 1 }
}
