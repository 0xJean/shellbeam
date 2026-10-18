import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isWithin, validateFixtureFields } from './run-ops-live.mjs'

test('disposable fixture paths cannot escape their owning directory or accept a shared root', () => {
  assert(isWithin('/runner/temp', '/runner/temp/shellbeam-ops-live-ab/fixture.json'))
  for (const target of ['/runner/temp', '/runner/temp-other/file', '/runner/private', '/etc/ssl']) assert(!isWithin('/runner/temp', target))
})

test('live fixture binds exact immutable container and loopback test identities', () => {
  const fixture = { containerId: 'a'.repeat(64), containerName: 'shellbeam-ops-live-ab', siteName: 'shellbeam-ops-live-ab.test', domains: ['shellbeam-ops-live-ab.test', 'www.shellbeam-ops-live-ab.test'], certificatePath: '/etc/ssl/certs/shellbeam-ops-live-ab.pem', httpsPort: 18443, rootFixtureDir: '/runner/temp/shellbeam-ops-live-ab' }
  assert.equal(validateFixtureFields(fixture), fixture)
  for (const patch of [{ containerId: 'container-name' }, { containerName: 'production' }, { siteName: 'production.example.com' }, { domains: ['other.test', fixture.domains[1]] }, { certificatePath: '/etc/ssl/certs/production.pem' }, { httpsPort: 443 }, { rootFixtureDir: '../outside' }]) assert.throws(() => validateFixtureFields({ ...fixture, ...patch }), /ops_live_fixture_invalid/)
})

test('real runner CLI refuses a normal workstation before reading fixtures or starting services', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run-ops-live.mjs', import.meta.url)), '/does-not-exist/fixture.json'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted', SHELLBEAM_OPS_LIVE: '1' } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ops_live_requires_disposable_github_hosted_linux/)
  assert(!result.stderr.includes('ENOENT'))
  assert.equal(result.stdout, '')
})
