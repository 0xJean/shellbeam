import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadShellbeamAgentCatalogRelease, parseShellbeamAgentPlatform, validateShellbeamAgentCatalogUrl } from './shellbeam-agent-catalog'
import { DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS } from './shellbeam-agent-release-settings'
import { canonicalShellbeamAgentArtifactPayload } from './shellbeam-agent-artifact'
import { canonicalShellbeamAgentReleasePayload, type ShellbeamAgentReleaseManifest } from './shellbeam-agent-release'
import type { HostProfile } from './hosts'
const host = { id: 'edge', name: 'edge', address: '10.0.0.1', port: 22, username: 'ops', authType: 'privateKey', tags: [], group: 'Production', createdAt: 1, updatedAt: 1 } as HostProfile
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
describe('Signed agent release catalog', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto))
  afterEach(() => vi.unstubAllGlobals())
  it('selects and verifies a release for the observed OS/architecture and configured channel', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
    const publicKey = b64(await crypto.subtle.exportKey('raw', pair.publicKey))
    const artifact = { artifactId: 'shellbeam-agent-linux-x86_64', version: '0.1.0', platform: 'linux', architecture: 'x86_64', url: 'https://downloads.example.com/agent', sha256: 'a'.repeat(64), signature: '' }
    artifact.signature = b64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(canonicalShellbeamAgentArtifactPayload(artifact))))
    const release: ShellbeamAgentReleaseManifest = { releaseId: 'agent-0.1.0-linux-x86_64', channel: 'stable', publishedAt: Date.now() - 100, artifact }
    release.releaseSignature = b64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(canonicalShellbeamAgentReleasePayload(release))))
    const settings = { ...DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS, enabled: true, releaseManifestUrl: 'https://downloads.example.com/catalog.json', artifactAllowedHosts: ['downloads.example.com'], artifactTrustedPublicKeyBase64: publicKey, trustedReleasePublicKeyBase64: publicKey }
    const download = vi.fn(async () => new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, manifests: [release] })))
    const selected = await loadShellbeamAgentCatalogRelease({ host, vaultId: 'vault-1', resolveAuthSecret: vi.fn(), settings, download, detect: async () => 'Linux\nx86_64\n' })
    expect(selected.manifest.releaseId).toBe(release.releaseId)
    expect(download).toHaveBeenCalledWith(settings.releaseManifestUrl, ['downloads.example.com'], 512 * 1024)
    await expect(loadShellbeamAgentCatalogRelease({ host, vaultId: 'vault-1', resolveAuthSecret: vi.fn(), settings, download, detect: async () => 'Darwin\narm64\n' })).rejects.toThrow('no_eligible_signed_release')
    const tampered = vi.fn(async () => new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, manifests: [{ ...release, rollout: { percentage: 0, salt: 'tampered' } }] })))
    await expect(loadShellbeamAgentCatalogRelease({ host, vaultId: 'vault-1', resolveAuthSecret: vi.fn(), settings, download: tampered, detect: async () => 'Linux\nx86_64' })).rejects.toThrow('no_eligible_signed_release')
  })
  it('never downloads an unconfigured or untrusted catalog and rejects unsupported targets', async () => {
    expect(parseShellbeamAgentPlatform('Darwin\narm64')).toEqual({ platform: 'macos', architecture: 'aarch64' })
    expect(() => parseShellbeamAgentPlatform('Windows\nx86_64')).toThrow('unsupported')
    expect(() => validateShellbeamAgentCatalogUrl('http://downloads.example.com/a', ['downloads.example.com'])).toThrow('not_allowed')
    expect(() => validateShellbeamAgentCatalogUrl('https://downloads.example.com.evil/a', ['downloads.example.com'])).toThrow('not_allowed')
    await expect(loadShellbeamAgentCatalogRelease({ host, vaultId: 'vault-1', resolveAuthSecret: vi.fn(), settings: DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS })).rejects.toThrow('not_configured')
  })
})
