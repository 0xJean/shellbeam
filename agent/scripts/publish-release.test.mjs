import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { signedRelease, artifactPayload, releasePayload, parsePublisherOptions } from './publish-release.mjs'
test('publisher binds exact bytes/platform/channel/rollout to distinct Ed25519 signatures',()=>{
  const artifact=generateKeyPairSync('ed25519');const release=generateKeyPairSync('ed25519')
  const input={bytes:Buffer.from('actual executable bytes'),version:'0.1.0',platform:'linux',architecture:'x86_64',url:'https://example.com/agent',artifactKey:artifact.privateKey.export({type:'pkcs8',format:'pem'}),releaseKey:release.privateKey.export({type:'pkcs8',format:'pem'}),now:1234567890000}
  const manifest=signedRelease(input)
  assert(verify(null,Buffer.from(artifactPayload(manifest.artifact)),artifact.publicKey,Buffer.from(manifest.artifact.signature,'base64')))
  assert(verify(null,Buffer.from(releasePayload(manifest)),release.publicKey,Buffer.from(manifest.releaseSignature,'base64')))
  assert(!verify(null,Buffer.from(releasePayload({...manifest,channel:'canary'})),release.publicKey,Buffer.from(manifest.releaseSignature,'base64')))
  assert.throws(()=>signedRelease({...input,url:'http://example.com/agent'}))
  assert.throws(()=>signedRelease({...input,version:'bad; shell'}))
  assert.throws(()=>signedRelease({...input,releaseKey:input.artifactKey}),/independent_signing_keys_required/)
})

const required = ['--input-dir', 'dist', '--output', 'catalog.json', '--version', '0.1.0', '--base-url', 'https://example.com/agent']
test('publisher validates rollout and per-target previous hashes before signing', () => {
  assert.equal(parsePublisherOptions(required).rolloutPercentage, 100)
  assert.equal(parsePublisherOptions([...required, '--rollout-percentage', '0']).rolloutPercentage, 0)
  assert.equal(parsePublisherOptions([...required, '--rollout-percentage', '25']).rolloutPercentage, 25)
  for (const value of ['-1', '101', '1.5', 'NaN', '1e2', '']) assert.throws(() => parsePublisherOptions([...required, '--rollout-percentage', value]))
  for (const value of ['null', '[]', '{', '{"all":"' + 'a'.repeat(64) + '"}', '{"shellbeam-agent-linux-x86_64":"short"}']) {
    assert.throws(() => parsePublisherOptions([...required, '--previous-hashes', value]), /previous_hashes_invalid/)
  }
  assert.throws(() => parsePublisherOptions([...required, '--channel']))
  assert.throws(() => parsePublisherOptions([...required, '--version', '0.2.0']))
  assert.throws(() => parsePublisherOptions([...required, '--unknown', 'value']))
})

test('actual CLI publishes four independently verified manifests with target-specific upgrade guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shellbeam-publisher-'))
  try {
    const artifact = generateKeyPairSync('ed25519')
    const release = generateKeyPairSync('ed25519')
    const targets = ['linux-x86_64', 'linux-aarch64', 'macos-x86_64', 'macos-aarch64']
    for (const target of targets) await writeFile(join(directory, `shellbeam-agent-${target}`), `fixture executable for ${target}`)
    const previousHashes = Object.fromEntries(targets.map((target, index) => [`shellbeam-agent-${target}`, String(index + 1).repeat(64)]))
    const output = join(directory, 'catalog.json')
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./publish-release.mjs', import.meta.url)), '--input-dir', directory, '--output', output, '--version', '0.1.0', '--base-url', 'https://example.com/agent', '--channel', 'canary', '--rollout-percentage', '25', '--previous-hashes', JSON.stringify(previousHashes)], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_ARTIFACT_SIGNING_KEY_PEM: artifact.privateKey.export({ type: 'pkcs8', format: 'pem' }), AGENT_RELEASE_SIGNING_KEY_PEM: release.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stderr, '')
    assert(!child.stdout.includes('PRIVATE KEY'))
    const catalog = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(catalog.manifests.length, 4)
    for (const manifest of catalog.manifests) {
      assert.equal(manifest.channel, 'canary')
      assert.equal(manifest.rollout.percentage, 25)
      assert.equal(manifest.previousSha256, previousHashes[manifest.artifact.artifactId])
      assert(verify(null, Buffer.from(artifactPayload(manifest.artifact)), artifact.publicKey, Buffer.from(manifest.artifact.signature, 'base64')))
      assert(verify(null, Buffer.from(releasePayload(manifest)), release.publicKey, Buffer.from(manifest.releaseSignature, 'base64')))
      assert(!verify(null, Buffer.from(releasePayload({ ...manifest, rollout: { ...manifest.rollout, percentage: 100 } })), release.publicKey, Buffer.from(manifest.releaseSignature, 'base64')))
      assert(!verify(null, Buffer.from(releasePayload({ ...manifest, previousSha256: 'f'.repeat(64) })), release.publicKey, Buffer.from(manifest.releaseSignature, 'base64')))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
