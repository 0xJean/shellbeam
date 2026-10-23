import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { signCompatibleAgent, signCompatibleCatalog, verifyCompatibleCatalog } from './publish-komari-agent.mjs'
import { requireForwardCatalog, validateResumedCatalog } from './promote-komari-agent-release.mjs'
const pair = generateKeyPairSync('ed25519'); const key = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
const root = { keyId: 'isolated-test', publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'), minimumSequence: 1 }
const now = 1790000000000
function catalog(sequence = 1, version = '1.5.11') {
  const artifacts = ['amd64', 'arm64'].map(architecture => {
    const bytes = Buffer.from(`isolated ${architecture}`)
    return signCompatibleAgent({ bytes, version, architecture, url: `https://github.com/0xJean/shellbeam/releases/download/monitoring-probe-v${version}-r1/komari-agent-linux-${architecture}`, expectedSha256: createHash('sha256').update(bytes).digest('hex'), expectedSize: bytes.length, privateKey: key })
  })
  return signCompatibleCatalog({ artifacts, keyId: root.keyId, sequence, publishedAt: now, expiresAt: now + 90 * 86400000 }, key, root.publicKey)
}
test('catalog binds both reviewed architectures, channel, key and validity', () => {
  const c = catalog(); assert.equal(verifyCompatibleCatalog(c, root, now), c)
  for (const patch of [{ channel: 'canary' }, { keyId: 'another' }, { sequence: 2 }, { publishedAt: now + 300001 }, { expiresAt: now + 181 * 86400000 }, { artifacts: [c.artifacts[0]] }, { unrecognized: true }]) assert.throws(() => verifyCompatibleCatalog({ ...c, ...patch }, root, now))
  assert.throws(() => verifyCompatibleCatalog(c, root, c.expiresAt))
  assert.throws(() => signCompatibleCatalog(c, key, Buffer.alloc(32).toString('base64')))
})
test('correct publisher signatures cannot move the built-in source to another repo', () => {
  const c = catalog(); c.artifacts[0] = { ...c.artifacts[0], url: c.artifacts[0].url.replace('0xJean/shellbeam', 'another/repo') }
  assert.throws(() => signCompatibleCatalog(c, key, root.publicKey))
})
test('promotion refuses catalog replay, same-sequence replacement and version rollback', () => {
  const c = catalog(10)
  assert.throws(() => requireForwardCatalog(c, catalog(9)))
  assert.throws(() => requireForwardCatalog(c, catalog(10)))
  assert.throws(() => requireForwardCatalog(c, catalog(11, '1.5.10')))
  assert.doesNotThrow(() => requireForwardCatalog(c, catalog(11)))
})
test('public cross-language fixture and production root are distinct', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/official-compatible-catalog-test.json', import.meta.url)))
  verifyCompatibleCatalog(fixture.catalog, fixture.root, fixture.catalog.publishedAt)
  const production = JSON.parse(await readFile(new URL('../src-tauri/src/data/komari_agent/official-trust.json', import.meta.url)))
  assert.notEqual(production.publicKey, fixture.root.publicKey)
  assert.throws(() => verifyCompatibleCatalog(fixture.catalog, production, fixture.catalog.publishedAt))
})
test('workflow retry reuses signed bytes only for the exact reviewed release, while rejecting expiry', () => {
  const c = catalog(10)
  const spec = { artifacts: c.artifacts.map(m => ({ version: m.version, architecture: m.architecture, url: m.url, expectedSha256: m.sha256, expectedSize: m.sizeBytes })) }
  assert.equal(validateResumedCatalog(c, spec, root, now), c)
  for (const patch of [{ version: '1.5.12' }, { url: spec.artifacts[0].url.replace('-r1/', '-r2/') }, { expectedSha256: '0'.repeat(64) }, { expectedSize: 1 }, { architecture: 'arm64' }]) {
    assert.throws(() => validateResumedCatalog(c, { artifacts: [{ ...spec.artifacts[0], ...patch }, spec.artifacts[1]] }, root, now), /resumed_catalog_mismatch/)
  }
  assert.throws(() => validateResumedCatalog(c, spec, root, c.expiresAt))
  assert.throws(() => validateResumedCatalog({ ...c, sequence: 11 }, spec, root, now))
})
