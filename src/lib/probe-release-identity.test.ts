import { describe, expect, it } from 'vitest'
import pins from '../../releases/compatible-probe-pins.json'
import { probeReleaseDisplay, probeReleaseIdentity, type ProbeArtifactIdentity } from './probe-release-identity'
import { compatibleAgentCopy } from './locales/compatible-agent'

const artifact = (version: keyof typeof pins.versions = '1.5.12', architecture: 'amd64' | 'arm64' = 'amd64'): ProbeArtifactIdentity => ({
  runtime: 'komari', platform: 'linux', architecture, version,
  sha256: pins.versions[version][architecture].sha256, sizeBytes: pins.versions[version][architecture].size,
})
describe('reviewed probe provenance', () => {
  it.each(['amd64', 'arm64'] as const)('identifies the exact reviewed fork bytes on %s', architecture => {
    expect(probeReleaseIdentity(artifact('1.5.12', architecture))).toEqual({ product: 'shellbeam', repository: '0xJean/shellbeam-monitoring-agent', commit: '4e81478e4bde5c22b7b65e422ae87ca40a6c877a', upstreamVersion: '1.5.11' })
  })
  it.each(['1.5.10', '1.5.11'] as const)('retains the upstream identity for saved %s releases', version => {
    expect(probeReleaseIdentity(artifact(version))).toEqual({ product: 'upstream', repository: 'komari-monitor/komari-agent', commit: null, upstreamVersion: version })
  })
  it.each([{ sha256: 'a'.repeat(64) }, { sizeBytes: 1 }, { version: '1.5.13' }, { architecture: 'arm64' }, { platform: 'darwin' }, { runtime: 'custom' }])('does not brand a version string or altered artifact as ShellBeam (%j)', change => {
    expect(probeReleaseIdentity({ ...artifact(), ...change })).toBeNull()
  })
  it('keeps legacy incomplete and missing observations neutral', () => {
    expect(probeReleaseIdentity({ version: '1.5.12', sha256: artifact().sha256 })).toBeNull()
    expect(probeReleaseIdentity(null)).toBeNull()
  })
  it.each(['en', 'zh-CN'] as const)('labels upgrade and saved rollback without changing versions (%s)', locale => {
    const c = compatibleAgentCopy[locale].distributions
    expect(probeReleaseDisplay(artifact(), '1.5.12', c)).toBe(`${c.shellbeam} 1.5.12`)
    expect(probeReleaseDisplay(artifact('1.5.11'), '1.5.11', c)).toBe(`${c.upstream} 1.5.11`)
    expect(probeReleaseDisplay(artifact(), '1.5.11', c)).toBe(`${c.compatible} 1.5.11`)
    expect(probeReleaseDisplay(null, null, c)).toBe('—')
  })
})
