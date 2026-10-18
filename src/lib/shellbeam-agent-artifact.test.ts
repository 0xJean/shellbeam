import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildShellbeamAgentArtifactInstallPlan, canonicalShellbeamAgentArtifactPayload, runShellbeamAgentArtifactOperation, validateShellbeamAgentArtifactManifest, verifyShellbeamAgentArtifactBytes, type ShellbeamAgentArtifactManifest } from './shellbeam-agent-artifact'
import { invoke } from '@tauri-apps/api/core'
import { downloadShellbeamAgentBytes } from './shellbeam-agent-download'
import { sftpHomeDir, sftpUploadFile } from './sftp'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { checkShellbeamAgent, listShellbeamAgents, normalizeShellbeamAgentRecord, upsertShellbeamAgent } from './shellbeam-agent'
import { registerUserConfirmationPresenter } from './user-confirmation'
import type { HostProfile } from './hosts'
import type { CommandRunResult } from './sessions'
import { DEFAULT_VAULT_ID } from './vaults'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./shellbeam-agent-download', () => ({ downloadShellbeamAgentBytes: vi.fn() }))
vi.mock('./sftp', () => ({ sftpHomeDir: vi.fn(), sftpUploadFile: vi.fn() }))
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
vi.mock('./shellbeam-agent', async (original) => ({ ...await original<typeof import('./shellbeam-agent')>(), listShellbeamAgents: vi.fn(), upsertShellbeamAgent: vi.fn(), checkShellbeamAgent: vi.fn() }))

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

const operationHost: HostProfile = { id: 'artifact-host', name: 'edge', address: '192.0.2.4', port: 22, username: 'ops', authType: 'privateKey', jumpHostId: 'jump-profile', group: 'test', tags: [], createdAt: 1, updatedAt: 1 }
const commandOk: CommandRunResult = { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }

describe('signed Agent operation stage boundaries', () => {
  let unregister: (() => void) | undefined
  let signedManifest: ShellbeamAgentArtifactManifest
  let signedPolicy: typeof policy
  let bytes: Uint8Array<ArrayBuffer>
  let callerCurrent: boolean
  let presenterCurrent: boolean

  beforeEach(async () => {
    vi.resetAllMocks()
    vi.stubGlobal('crypto', webcrypto)
    callerCurrent = true
    presenterCurrent = true
    unregister = registerUserConfirmationPresenter(async () => ({ accepted: true, reason: 'accepted', isCurrent: () => presenterCurrent }))
    bytes = new TextEncoder().encode('staged-agent-test-only')
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const unsigned = { ...manifest, sha256: Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('') }
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(canonicalShellbeamAgentArtifactPayload(unsigned))))
    const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data))
    signedManifest = { ...unsigned, signature: b64(signature) }
    signedPolicy = { ...policy, trustedPublicKeyBase64: b64(publicKey) }
    vi.mocked(downloadShellbeamAgentBytes).mockResolvedValue(bytes)
    vi.mocked(sftpHomeDir).mockResolvedValue('/home/ops')
    vi.mocked(sftpUploadFile).mockResolvedValue()
    vi.mocked(listShellbeamAgents).mockResolvedValue([])
    vi.mocked(upsertShellbeamAgent).mockImplementation(async (record) => normalizeShellbeamAgentRecord(record))
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValue(commandOk)
    let job: Record<string, unknown> = {}
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const request = (args as { request?: Record<string, unknown> })?.request ?? {}
      if (command === 'operation_job_create') job = { ...request, jobId: 'artifact-job', auditId: 'artifact-audit', status: 'queued', confirmationStatus: 'pending' }
      else if (command === 'operation_job_update') job = { ...job, ...request }
      return { ...job }
    })
  })
  afterEach(() => { unregister?.(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const run = (action: 'install' | 'upgrade' = 'install') => runShellbeamAgentArtifactOperation({ host: operationHost, vaultId: 'artifact-vault', resolveAuthSecret: vi.fn(async () => ''), manifest: signedManifest, policy: signedPolicy, action, isCurrent: () => callerCurrent })

  it.each([undefined, 'profile-vault'])('infers an omitted Vault from the saved profile (%s)', async (profileVault) => {
    presenterCurrent = false
    expect(await runShellbeamAgentArtifactOperation({ host: { ...operationHost, vaultId: profileVault }, resolveAuthSecret: vi.fn(), manifest: signedManifest, policy: signedPolicy })).toBeNull()
    const expectedVault = profileVault ?? DEFAULT_VAULT_ID
    expect(listShellbeamAgents).toHaveBeenCalledWith({ vaultId: expectedVault, hostId: operationHost.id })
    expect(invoke).toHaveBeenCalledWith('operation_job_create', { request: expect.objectContaining({ vaultId: expectedVault }) })
    expect(downloadShellbeamAgentBytes).not.toHaveBeenCalled()
  })

  it('rejects conflicting Vault ids before state reads, audit, download, or SSH', async () => {
    const onRecord = vi.fn()
    await expect(runShellbeamAgentArtifactOperation({ host: { ...operationHost, vaultId: 'profile-vault' }, vaultId: 'other-vault', resolveAuthSecret: vi.fn(), manifest: signedManifest, policy: signedPolicy, onRecord })).rejects.toThrow('WORKSPACE_VAULT_SCOPE_MISMATCH')
    expect(listShellbeamAgents).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(onRecord).not.toHaveBeenCalled()
    expect(downloadShellbeamAgentBytes).not.toHaveBeenCalled()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
  })

  it.each(['caller', 'presenter'] as const)('stops at every delayed stage when the %s scope changes', async (scope) => {
    // Each pass runs the real signature verifier and OperationJob flow. Only
    // transport boundaries are held, so the next submitted mutation is visible.
    for (const phase of ['download', 'home', 'hash', 'prepare', 'upload'] as const) {
      callerCurrent = true
      presenterCurrent = true
      vi.mocked(invoke).mockClear()
      vi.mocked(sftpHomeDir).mockClear().mockResolvedValue('/home/ops')
      vi.mocked(sftpUploadFile).mockClear().mockResolvedValue()
      vi.mocked(upsertShellbeamAgent).mockClear()
      vi.mocked(checkShellbeamAgent).mockClear()
      vi.mocked(downloadShellbeamAgentBytes).mockClear().mockResolvedValue(bytes)
      const gate = deferred<CommandRunResult>()
      const download = deferred<Uint8Array>()
      const home = deferred<string>()
      const upload = deferred<void>()
      let reached = false
      if (phase === 'download') vi.mocked(downloadShellbeamAgentBytes).mockImplementationOnce(() => { reached = true; return download.promise })
      if (phase === 'home') vi.mocked(sftpHomeDir).mockImplementationOnce(() => { reached = true; return home.promise })
      if (phase === 'upload') vi.mocked(sftpUploadFile).mockImplementationOnce(() => { reached = true; return upload.promise })
      vi.mocked(runWorkspaceRemoteCommand).mockClear().mockImplementation(async (request) => {
        if (phase === 'hash' && request.command.startsWith('if command -v')) { reached = true; return gate.promise }
        if (phase === 'prepare' && request.command.startsWith('mkdir -p')) { reached = true; return gate.promise }
        return commandOk
      })
      const pending = run(phase === 'hash' ? 'upgrade' : 'install')
      const outcome = pending.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
      await vi.waitFor(() => expect(reached).toBe(true))
      if (scope === 'caller') callerCurrent = false
      else presenterCurrent = false
      download.resolve(bytes)
      home.resolve('/home/ops')
      gate.resolve({ ...commandOk, stdout: 'b'.repeat(64) + '  shellbeam-agent' })
      upload.resolve()
      const result = await outcome
      const sent = phase === 'prepare' || phase === 'upload'
      expect(result.value).toBeNull()
      if (sent) expect(result.error).toMatchObject({ sent: true, operationJob: { status: 'unknown', confirmationStatus: 'confirmed', errorCode: 'operation_scope_changed' } })
      else expect(result.error).toBeNull()
      expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: sent ? 'unknown' : 'cancelled', confirmationStatus: 'confirmed', errorCode: 'operation_scope_changed' }) })
      expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(phase === 'download' || phase === 'home' ? 0 : 1)
      expect(sftpUploadFile).toHaveBeenCalledTimes(phase === 'upload' ? 1 : 0)
      expect(checkShellbeamAgent).not.toHaveBeenCalled()
      expect(upsertShellbeamAgent).not.toHaveBeenCalled()
    }
  })

  it.each([
    { result: { ...commandOk, exitCode: 1 }, status: 'failed', code: 'artifact_prepare_failed' },
    { result: { ...commandOk, errorType: 'unknown' as const }, status: 'unknown', code: 'artifact_prepare_unknown' },
    { result: { ...commandOk, exitCode: -1, errorCode: 'target_timeout' }, status: 'unknown', code: 'artifact_prepare_unknown' },
  ])('does not upload after preparation is $status', async ({ result, status, code }) => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result)
    const operation = await run()
    expect(operation?.job).toMatchObject({ status, confirmationStatus: 'confirmed', errorCode: code })
    expect(operation?.record.lastErrorCode).toBe(code)
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledOnce()
    expect(sftpUploadFile).not.toHaveBeenCalled()
    expect(checkShellbeamAgent).not.toHaveBeenCalled()
  })

  it('keeps a completed activation but sends no follow-up read or record to a changed route', async () => {
    const activation = deferred<CommandRunResult>()
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(commandOk).mockImplementationOnce(() => activation.promise)
    const pending = run()
    await vi.waitFor(() => expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2))
    presenterCurrent = false
    activation.resolve({ ...commandOk, stdout: '__SB_AGENT_STATUS=installed' })
    const result = await pending
    expect(result?.job.status).toBe('completed')
    expect(checkShellbeamAgent).not.toHaveBeenCalled()
    expect(upsertShellbeamAgent).not.toHaveBeenCalled()
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith('operation_job_create', { request: expect.objectContaining({ vaultId: 'artifact-vault', hostId: operationHost.id, transport: 'proxy-jump' }) })
  })

  it('does not activate from an uncertain upgrade hash read even with a plausible digest', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ ...commandOk, stdout: 'b'.repeat(64) + '  shellbeam-agent', errorType: 'unknown' })
    await expect(run('upgrade')).rejects.toThrow('artifact_previous_hash_unavailable')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledOnce()
    expect(sftpUploadFile).not.toHaveBeenCalled()
  })

  it.each([
    { ...commandOk, errorCode: 'target_timeout', exitCode: -1 },
    { ...commandOk, stdout: '__SB_AGENT_STATUS=installed', errorType: 'unknown' as const },
  ])('keeps uncertain activation results unknown without a follow-up observation', async (result) => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(commandOk).mockResolvedValueOnce(result)
    const operation = await run()
    expect(operation?.job.status).toBe('unknown')
    expect(operation?.record.status).toBe('unknown')
    expect(checkShellbeamAgent).not.toHaveBeenCalled()
  })

  it('discards a follow-up observation if scope changes while that read is in flight', async () => {
    const observation = deferred<Awaited<ReturnType<typeof checkShellbeamAgent>>>()
    vi.mocked(checkShellbeamAgent).mockImplementationOnce(() => observation.promise)
    const pending = run()
    await vi.waitFor(() => expect(checkShellbeamAgent).toHaveBeenCalledOnce())
    callerCurrent = false
    observation.resolve({ ...commandOk, record: { vaultId: 'artifact-vault', hostId: operationHost.id, status: 'installed', health: 'online', agentId: 'old-route', source: 'shellbeam-agent', providerKind: 'shellbeam-agent', capabilities: [], heartbeatTtlMs: 300000, transport: 'proxy-jump', lastCheckedAt: Date.now(), updatedAt: Date.now() } })
    const result = await pending
    expect(result?.job.status).toBe('completed')
    expect(result?.record.agentId).not.toBe('old-route')
    expect(upsertShellbeamAgent).not.toHaveBeenCalled()
  })
})
