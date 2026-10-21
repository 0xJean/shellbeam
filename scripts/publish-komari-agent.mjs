#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
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
  await writeFile(resolve(args[5]), JSON.stringify({ artifacts }, null, 2) + '\n', { mode: 0o644, flag: 'wx' })
  console.log(JSON.stringify({ signedArtifacts: artifacts.length, publicKey }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main() } catch (error) { console.error(error instanceof Error && /^[a-z0-9_: .-]+$/i.test(error.message) ? error.message : 'compatible_agent_publication_failed'); process.exitCode = 1 }
}
