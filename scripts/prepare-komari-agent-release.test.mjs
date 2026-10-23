import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releasePlan, releaseAssetNames, validateReviewedSpec, verifySourceTag, verifyPinnedBytes } from './prepare-komari-agent-release.mjs'
import { validateExistingRelease, validateLocalRelease, verifyAssetCopies } from './promote-komari-agent-release.mjs'

const pin = value => ({ sha256: createHash('sha256').update(value).digest('hex'), size: Buffer.byteLength(value) })
const binaries = { amd64: Buffer.from('isolated reviewed amd64 executable'), arm64: Buffer.from('isolated reviewed arm64 executable') }
const archives = { amd64: Buffer.from('isolated full amd64 archive with licenses'), arm64: Buffer.from('isolated full arm64 archive with licenses') }
const source = { repository: '0xJean/shellbeam-monitoring-agent', tag: 'v1.5.12', commit: '4e81478e4bde5c22b7b65e422ae87ca40a6c877a', upstreamVersion: '1.5.11', upstreamCommit: 'c7bafb79b1a73ed9e14e2c248ae4d4163e506036' }
const oldPin = { amd64: pin(binaries.amd64), arm64: pin(binaries.arm64) }
const forkPin = { ...oldPin, source, archives: { amd64: pin(archives.amd64), arm64: pin(archives.arm64) } }
const pins = { versions: { '1.5.11': oldPin, '1.5.12': forkPin } }
const clone = value => structuredClone(value)
function specification(directory, version = '1.5.12') {
  const plan = releasePlan(version, '1', pins.versions[version])
  return { official: true, keyId: 'test-only', artifacts: plan.files.filter(f => !f.archive).map(f => ({ file: join(directory, f.name), version, architecture: f.architecture, url: f.url, expectedSha256: f.pin.sha256, expectedSize: f.pin.size })), ...(plan.source ? { source: plan.source } : {}) }
}
async function staged(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shellbeam-release-unit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = specification(directory)
  const plan = validateReviewedSpec(spec, pins)
  for (const file of plan.files) await writeFile(join(directory, file.name), file.archive ? archives[file.architecture] : binaries[file.architecture])
  await writeFile(join(directory, 'UPSTREAM-LICENSE.txt'), await readFile(new URL('../releases/komari-agent-LICENSE.txt', import.meta.url)))
  await writeFile(join(directory, 'catalog.json'), 'isolated signed-catalog placeholder')
  return { directory, spec, plan }
}
test('legacy reviewed pins keep the upstream source and four existing release assets', () => {
  const plan = releasePlan('1.5.11', '2', oldPin)
  assert.equal(plan.source, undefined)
  assert.equal(plan.files[0].sourceUrl, 'https://github.com/komari-monitor/komari-agent/releases/download/1.5.11/komari-agent-linux-amd64')
  assert.deepEqual(releaseAssetNames('1.5.11', oldPin), ['komari-agent-linux-amd64', 'komari-agent-linux-arm64', 'catalog.json', 'UPSTREAM-LICENSE.txt'])
  assert.equal(validateReviewedSpec(specification('/private/fixture', '1.5.11'), pins).version, '1.5.11')
})
test('fork source adds two exact pinned native archives without changing signed download paths', () => {
  const plan = releasePlan('1.5.12', '1', forkPin)
  assert.equal(plan.files.length, 4)
  assert.deepEqual(plan.source, source)
  assert.equal(plan.files[0].sourceUrl, 'https://github.com/0xJean/shellbeam-monitoring-agent/releases/download/v1.5.12/komari-agent-linux-amd64')
  assert.equal(plan.files[0].url, 'https://github.com/0xJean/shellbeam/releases/download/monitoring-probe-v1.5.12-r1/komari-agent-linux-amd64')
  assert.equal(plan.files[2].name, 'shellbeam-monitoring-agent-1.5.12-linux-amd64.tar.gz')
  assert.equal(releaseAssetNames('1.5.12', forkPin).length, 6)
})
test('preparation refuses nonreviewed sources, inconsistent tags, missing legal archives and invalid pins', () => {
  const changes = [
    p => { p.source.repository = 'someone/another-agent' },
    p => { p.source.tag = 'main' },
    p => { p.source.tag = 'v1.5.13' },
    p => { p.source.commit = '4e81478' },
    p => { p.source.upstreamCommit = 'invalid' },
    p => { p.source.extra = true },
    p => { delete p.archives },
    p => { delete p.archives.arm64 },
    p => { p.archives.amd64.sha256 = '0'.repeat(63) },
    p => { p.archives.arm64.size = 0 },
    p => { p.amd64.size = 32 * 1024 * 1024 + 1 },
    p => { p.amd64.sha256 = p.amd64.sha256.toUpperCase() },
    p => { p.unexpected = true },
  ]
  for (const change of changes) { const candidate = clone(forkPin); change(candidate); assert.throws(() => releasePlan('1.5.12', '1', candidate)) }
  for (const revision of ['0', '01', '1/extra', '1000000']) assert.throws(() => releasePlan('1.5.12', revision, forkPin), /invalid_release_identity/)
  assert.throws(() => releasePlan('1.5.12', '1', undefined), /reviewed_version_required/)
  assert.throws(() => releasePlan('1.5.11', '1', { ...oldPin, archives: forkPin.archives }), /reviewed_source_invalid/)
})
test('GitHub lightweight and nested annotated tags must resolve to the exact reviewed commit', async () => {
  const path = 'repos/0xJean/shellbeam-monitoring-agent/git/ref/tags/v1.5.12'
  const calls = []
  assert.equal(await verifySourceTag(source, async request => { calls.push(request); return { object: { type: 'commit', sha: source.commit } } }), source.commit)
  assert.deepEqual(calls, [path])
  const tag1 = '1'.repeat(40); const tag2 = '2'.repeat(40)
  const replies = { [path]: { object: { type: 'tag', sha: tag1 } }, [`repos/0xJean/shellbeam-monitoring-agent/git/tags/${tag1}`]: { object: { type: 'tag', sha: tag2 } }, [`repos/0xJean/shellbeam-monitoring-agent/git/tags/${tag2}`]: { object: { type: 'commit', sha: source.commit } } }
  assert.equal(await verifySourceTag(source, async request => replies[request]), source.commit)
  await assert.rejects(verifySourceTag(source, async () => ({ object: { type: 'commit', sha: '0'.repeat(40) } })), /source_tag_commit_mismatch/)
  await assert.rejects(verifySourceTag(source, async () => ({ object: { type: 'tree', sha: tag1 } })), /source_tag_invalid/)
  await assert.rejects(verifySourceTag(source, async () => ({ object: { type: 'tag', sha: tag1 } })), /source_tag_invalid/)
  let requestCount = 0
  await assert.rejects(verifySourceTag(source, async () => ({ object: { type: 'tag', sha: (++requestCount).toString(16).padStart(40, '0') } })), /source_tag_depth_exceeded/)
  assert.equal(requestCount, 7)
  await assert.rejects(verifySourceTag({ ...source, repository: 'attacker/repo' }, async () => { throw new Error('must_not_request') }), /reviewed_source_invalid/)
})
test('resumed specifications bind reviewed source, both architectures, immutable revision, hashes and sizes', () => {
  const spec = specification('/private/fixture')
  assert.equal(validateReviewedSpec(spec, pins).tag, 'monitoring-probe-v1.5.12-r1')
  for (const change of [
    s => { delete s.source }, s => { s.source.commit = '0'.repeat(40) }, s => { s.source.repository = 'attacker/repo' },
    s => { s.artifacts[0].url = s.artifacts[0].url.replace('-r1/', '-r0/') },
    s => { s.artifacts[1].url = s.artifacts[1].url.replace('-r1/', '-r2/') },
    s => { s.artifacts[0].expectedSha256 = '0'.repeat(64) }, s => { s.artifacts[1].expectedSize++ },
    s => { s.artifacts.reverse() }, s => { s.artifacts[1].version = '1.5.11' }, s => { s.official = false },
  ]) { const candidate = clone(spec); change(candidate); assert.throws(() => validateReviewedSpec(candidate, pins)) }
})
test('local candidate and complete archives are checked before signing or resuming publication', async t => {
  const { directory, spec, plan } = await staged(t)
  await validateLocalRelease(directory, spec, pins)
  const changed = clone(spec); changed.artifacts[0].file = '/another/path/komari-agent-linux-amd64'
  await assert.rejects(validateLocalRelease(directory, changed, pins), /reviewed_spec_file_mismatch/)
  await writeFile(join(directory, plan.files[2].name), 'tampered legal archive')
  await assert.rejects(validateLocalRelease(directory, spec, pins), /pinned_upstream_mismatch/)
  await writeFile(join(directory, plan.files[2].name), archives.amd64)
  await writeFile(join(directory, 'UPSTREAM-LICENSE.txt'), 'removed copyright')
  await assert.rejects(validateLocalRelease(directory, spec, pins), /release_license_mismatch/)
})
test('published assets are immutable and exact; retries reject missing or additional release assets', async t => {
  const { directory } = await staged(t)
  const names = releaseAssetNames('1.5.12', forkPin)
  const release = { target_commitish: source.commit, draft: false, assets: names.map(name => ({ name })) }
  assert.doesNotThrow(() => validateExistingRelease(release, source.commit, names))
  assert.throws(() => validateExistingRelease({ ...release, target_commitish: '0'.repeat(40) }, source.commit, names), /release_target_changed/)
  assert.throws(() => validateExistingRelease({ ...release, assets: [...release.assets, { name: 'secret.pem' }] }, source.commit, names), /unexpected_release_asset/)
  assert.throws(() => validateExistingRelease({ ...release, assets: [...release.assets, release.assets[0]] }, source.commit, names), /unexpected_release_asset/)
  const partial = { ...release, assets: release.assets.slice(0, 4) }
  assert.throws(() => validateExistingRelease(partial, source.commit, names), /published_asset_missing/)
  assert.doesNotThrow(() => validateExistingRelease({ ...partial, draft: true }, source.commit, names))
  assert.throws(() => validateExistingRelease({ ...partial, draft: true }, source.commit, names, true), /published_asset_missing/)
  const copy = await mkdtemp(join(tmpdir(), 'shellbeam-release-copy-')); t.after(() => rm(copy, { recursive: true, force: true }))
  for (const name of names) await writeFile(join(copy, name), await readFile(join(directory, name)))
  await verifyAssetCopies(directory, copy, names)
  for (const name of names) {
    const original = await readFile(join(copy, name))
    await writeFile(join(copy, name), Buffer.concat([original, Buffer.from('changed')]))
    await assert.rejects(verifyAssetCopies(directory, copy, names), /uploaded_asset_mismatch/)
    await writeFile(join(copy, name), original)
  }
  await writeFile(join(copy, 'unexpected.bin'), 'unexpected')
  await assert.rejects(verifyAssetCopies(directory, copy, names), /unexpected_release_asset/)
  await rm(join(copy, 'unexpected.bin')); await rm(join(copy, names[0]))
  await symlink(join(directory, names[0]), join(copy, names[0]))
  await assert.rejects(verifyAssetCopies(directory, copy, names), /invalid_release_asset_file/)
})
test('byte validation rejects hash and size changes for executables and legal archives', () => {
  for (const bytes of [binaries.amd64, archives.arm64]) {
    assert.equal(verifyPinnedBytes(bytes, pin(bytes)), bytes)
    assert.throws(() => verifyPinnedBytes(bytes, { ...pin(bytes), size: bytes.length + 1 }), /pinned_upstream_mismatch/)
    assert.throws(() => verifyPinnedBytes(bytes, { ...pin(bytes), sha256: '0'.repeat(64) }), /pinned_upstream_mismatch/)
  }
})
