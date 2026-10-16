import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildShellbeamAgentArtifactInstallPlan, canonicalShellbeamAgentArtifactPayload, validateShellbeamAgentArtifactManifest, verifyShellbeamAgentArtifactBytes } from './shellbeam-agent-artifact'

const policy = { allowedHosts: ['downloads.example.com'], trustedPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
const manifest = { artifactId: 'shellbeam-agent-linux-amd64', version: '0.2.0', platform: 'linux', architecture: 'amd64', url: 'https://downloads.example.com/shellbeam-agent', sha256: 'a'.repeat(64), signature: 'A'.repeat(86) + '==', signatureAlgorithm: 'ed25519' as const }

describe('ShellBeam Probe artifact distribution', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto))
  afterEach(() => vi.unstubAllGlobals())

  it('requires HTTPS and an allowlisted artifact host', () => {
    expect(validateShellbeamAgentArtifactManifest(manifest, policy).manifest.version).toBe('0.2.0')
    expect(() => validateShellbeamAgentArtifactManifest({ ...manifest, url: 'http://downloads.example.com/a' }, policy)).toThrow('artifact_url_not_allowed')
    expect(() => validateShellbeamAgentArtifactManifest({ ...manifest, url: 'https://evil.example/a' }, policy)).toThrow('artifact_url_not_allowed')
    expect(() => validateShellbeamAgentArtifactManifest({ ...manifest, url: 'https://mirror.downloads.example.com/a' }, policy)).toThrow('artifact_url_not_allowed')
  })

  it('rejects malformed digest, signatures and oversized metadata', () => {
    expect(() => validateShellbeamAgentArtifactManifest({ ...manifest, sha256: 'bad' }, policy)).toThrow('artifact_manifest_invalid')
    expect(() => validateShellbeamAgentArtifactManifest({ ...manifest, sha256: `${'a'.repeat(64)}suffix` }, policy)).toThrow('artifact_manifest_invalid')
    expect(() => validateShellbeamAgentArtifactManifest({ ...manifest, signature: 'not-base64!' }, policy)).toThrow('artifact_signature_invalid')
    expect(() => validateShellbeamAgentArtifactManifest({ ...manifest, sizeBytes: 40 * 1024 * 1024 }, policy)).toThrow('artifact_size_invalid')
  })

  it('builds an atomic installer with a matching previous hash guard and rollback', () => {
    const previous = 'b'.repeat(64)
    const plan = buildShellbeamAgentArtifactInstallPlan({ version: '0.2.0', installPath: '/home/ops/.local/bin/shellbeam-agent', stagingPath: '/home/ops/.local/share/shellbeam-agent/.staging/a-0.2.0', backupPath: '/home/ops/.local/share/shellbeam-agent/.backups/shellbeam-agent-0.2.0', sha256: 'a'.repeat(64), previousSha256: previous })
    expect(plan.installCommand).toContain(previous)
    expect(plan.installCommand).toContain('mv -f')
    expect(plan.installCommand).toContain('cp -p')
    expect(plan.rollbackCommand).toContain(previous)
    expect(() => buildShellbeamAgentArtifactInstallPlan({ ...plan, sha256: plan.expectedSha256, previousSha256: plan.expectedPreviousSha256, installPath: '/tmp/../unsafe' })).toThrow('artifact_path_invalid')
  })

  it('verifies the digest and Ed25519 signature over the exact artifact bytes', async () => {
    const bytes = new TextEncoder().encode('shellbeam-agent-release')
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const unsignedManifest = { ...manifest, sha256: Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('') }
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(canonicalShellbeamAgentArtifactPayload(unsignedManifest))))
    const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data))
    const validated = validateShellbeamAgentArtifactManifest({ ...unsignedManifest, signature: b64(signature) }, { ...policy, trustedPublicKeyBase64: b64(publicKey) })
    await expect(verifyShellbeamAgentArtifactBytes(bytes, validated, b64(publicKey))).resolves.toMatchObject({ digest: validated.sha256 })
    await expect(verifyShellbeamAgentArtifactBytes(new TextEncoder().encode('tampered'), validated, b64(publicKey))).rejects.toThrow('artifact_hash_mismatch')
  })
})
