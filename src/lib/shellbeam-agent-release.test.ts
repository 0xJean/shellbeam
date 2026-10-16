import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalShellbeamAgentReleasePayload,
  createShellbeamAgentReleaseAuditEvent,
  decideShellbeamAgentRelease,
  releaseNeedsManualRecovery,
  releaseOperationStatus,
  selectShellbeamAgentRelease,
  shellbeamAgentReleaseParamsSummary,
  validateShellbeamAgentReleaseManifest,
  verifyShellbeamAgentReleaseSignature,
} from './shellbeam-agent-release'
import { canonicalShellbeamAgentArtifactPayload } from './shellbeam-agent-artifact'

const bytes = new TextEncoder().encode('probe')
const artifact = {
  artifactId: 'shellbeam-agent-linux-amd64',
  version: '1.2.0',
  platform: 'linux', architecture: 'amd64',
  url: 'https://downloads.example.com/shellbeam-agent',
  sha256: 'a'.repeat(64), signature: 'A'.repeat(86) + '==', signatureAlgorithm: 'ed25519' as const,
}
const policy = { artifact: { allowedHosts: ['downloads.example.com'], trustedPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, trustedReleasePublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
const base = { releaseId: 'release-1', channel: 'stable' as const, publishedAt: 1_000, artifact, releaseSignature: 'A'.repeat(86) + '==' }

describe('ShellBeam Probe release policy', () => {
  it('rejects preview channels unless explicitly enabled and requires release signatures', () => {
    expect(() => validateShellbeamAgentReleaseManifest({ ...base, channel: 'preview' }, policy, 2_000)).toThrow('release_preview_disabled')
    expect(() => validateShellbeamAgentReleaseManifest({ ...base, releaseSignature: undefined }, policy, 2_000)).toThrow('release_signature_required')
    expect(validateShellbeamAgentReleaseManifest(base, policy, 2_000).manifest.channel).toBe('stable')
  })

  it('enforces expiry and deterministic rollout cohorts', () => {
    const release = validateShellbeamAgentReleaseManifest({ ...base, publishedAt: 1_000_000, expiresAt: 1_500_000, rollout: { percentage: 0, salt: 'test' } }, policy, 1_200_000)
    expect(decideShellbeamAgentRelease({ release, hostId: 'host-1', now: 1_300_000 }).reason).toBe('rollout-excluded')
    expect(() => validateShellbeamAgentReleaseManifest({ ...base, publishedAt: 1_000_000, expiresAt: 1_000_000 }, policy, 2_000_000)).toThrow('release_expired')
  })

  it('chooses the newest eligible release and records skipped candidates', () => {
    const old = { ...base, releaseId: 'old', artifact: { ...artifact, version: '1.1.0' } }
    const newest = { ...base, releaseId: 'new', artifact: { ...artifact, version: '1.2.1' } }
    const result = selectShellbeamAgentRelease({ manifests: [old, { ...newest, rollout: { percentage: 0, salt: 'none' } }, newest], policy, hostId: 'host-1', now: 2_000 })
    expect(result.selected?.manifest.releaseId).toBe('new')
    expect(result.skipped).toContainEqual({ releaseId: 'new', reason: 'rollout-excluded' })
  })

  it('signs and verifies release metadata separately from artifact metadata', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value))
    const releaseUnsigned = { ...base }
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(canonicalShellbeamAgentReleasePayload(releaseUnsigned))))
    const manifest = { ...releaseUnsigned, releaseSignature: b64(signature) }
    const validated = validateShellbeamAgentReleaseManifest(manifest, { ...policy, trustedReleasePublicKeyBase64: b64(publicKey) }, 2_000)
    await expect(verifyShellbeamAgentReleaseSignature(validated, b64(publicKey))).resolves.toBe(true)
    await expect(verifyShellbeamAgentReleaseSignature({ ...validated, manifest: { ...validated.manifest, channel: 'canary' } }, b64(publicKey))).rejects.toThrow('release_signature_mismatch')
  })

  it('creates a bounded audit record and classifies rollback requiring recovery', () => {
    const release = validateShellbeamAgentReleaseManifest(base, policy, 2_000)
    const summary = shellbeamAgentReleaseParamsSummary({ release })
    expect(summary).toContain('sha256=aaaaaaaaaaaa')
    expect(summary).not.toContain('downloads.example.com')
    const audit = createShellbeamAgentReleaseAuditEvent({ release, host: { id: 'h', name: 'prod' }, job: { jobId: 'j', auditId: 'a', status: 'failed', errorCode: 'artifact_rollback_unknown', resultSummary: 'rollback=unknown' }, event: 'failed', now: 2_000 })
    expect(audit.event).toBe('rollback-failed')
    expect(releaseNeedsManualRecovery({ status: 'unknown', errorCode: 'remote_state_unknown', resultSummary: 'rollback=unknown' })).toBe(true)
    expect(releaseOperationStatus({ status: 'failed', errorCode: 'x', resultSummary: 'rollback=unknown' })).toBe('unknown')
  })

  it('keeps canonical artifact metadata independent of release envelope', () => {
    expect(canonicalShellbeamAgentArtifactPayload(artifact)).toContain('shellbeam-agent-linux-amd64')
    expect(canonicalShellbeamAgentReleasePayload(base)).toContain('release-1')
    expect(bytes.byteLength).toBeGreaterThan(0)
  })
})
