import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { canonicalCompatibleAgent, signCompatibleAgent } from './publish-komari-agent.mjs'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const bytes = Buffer.from('isolated artifact fixture')
const options = { bytes, version: '1.5.11', architecture: 'amd64', url: 'https://release.test/agent', expectedSha256: createHash('sha256').update(bytes).digest('hex'), expectedSize: bytes.length, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
test('publisher verifies pinned bytes and signs the native canonical domain', () => {
  const m = signCompatibleAgent(options)
  assert.equal(canonicalCompatibleAgent(m).toString(), 'shellbeam/komari-agent/v1\n' + JSON.stringify({ runtime: 'komari', version: '1.5.11', platform: 'linux', architecture: 'amd64', url: options.url, sha256: options.expectedSha256, sizeBytes: bytes.length }))
  assert.ok(verify(null, canonicalCompatibleAgent(m), publicKey, Buffer.from(m.signature, 'base64')))
  assert.ok(!verify(null, canonicalCompatibleAgent({ ...m, runtime: 'shellbeam' }), publicKey, Buffer.from(m.signature, 'base64')))
  assert.ok(!verify(null, Buffer.from(JSON.stringify(m)), publicKey, Buffer.from(m.signature, 'base64')))
})
test('refuses mismatched upstream digests, sizes, architectures and unsafe URLs', () => {
  for (const change of [{ expectedSha256: '0'.repeat(64) }, { expectedSize: bytes.length + 1 }, { architecture: 'x86' }, { version: '1.6.0' }, { url: 'http://release.test/a' }, { url: 'https://u:p@release.test/a' }, { url: 'https://release.test/a?token=private' }]) assert.throws(() => signCompatibleAgent({ ...options, ...change }))
})
