import type { HostProfile } from './hosts'
import { operationTransport, runConfirmedOperation, updateOperationJob, type OperationJob } from './operation-job'
import { sftpHomeDir, sftpUploadFile } from './sftp'
import { checkShellbeamAgent, listShellbeamAgents, normalizeShellbeamAgentRecord, upsertShellbeamAgent, type ShellbeamAgentRecord } from './shellbeam-agent'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { downloadShellbeamAgentBytes } from './shellbeam-agent-download'
import { upsertPersistedProbeSnapshot } from './probe-persistence'

/**
 * A release manifest is treated as untrusted input until its URL, digest and
 * signature are validated against the local policy. The public key is supplied
 * by the caller from a trusted, bundled configuration; it is deliberately not
 * accepted from the manifest itself.
 */
export interface ShellbeamAgentArtifactManifest {
  artifactId: string
  version: string
  platform: string
  architecture: string
  url: string
  sha256: string
  signature: string
  signatureAlgorithm?: 'ed25519'
  sizeBytes?: number
}

export interface ShellbeamAgentArtifactPolicy {
  allowedHosts: string[]
  trustedPublicKeyBase64: string
  maxBytes?: number
}

export interface ValidatedShellbeamAgentArtifact {
  manifest: ShellbeamAgentArtifactManifest
  url: URL
  sha256: string
  signature: Uint8Array
}

export interface VerifiedShellbeamAgentArtifact extends ValidatedShellbeamAgentArtifact {
  bytes: Uint8Array
  verifiedAt: number
}

export interface ShellbeamAgentArtifactInstallPlan {
  version: string
  installPath: string
  stagingPath: string
  backupPath: string
  expectedSha256: string
  expectedPreviousSha256?: string
  installCommand: string
  rollbackCommand: string
}

/** The signed bytes are metadata, while the artifact digest binds that
 * metadata to the exact downloaded release. Keeping this canonical form
 * stable makes verification independent of object key ordering. */
export function canonicalShellbeamAgentArtifactPayload(manifest: Pick<ShellbeamAgentArtifactManifest, 'artifactId' | 'version' | 'platform' | 'architecture' | 'url' | 'sha256' | 'sizeBytes'>) {
  return JSON.stringify({
    artifactId: manifest.artifactId,
    version: manifest.version,
    platform: manifest.platform,
    architecture: manifest.architecture,
    url: manifest.url,
    sha256: manifest.sha256.toLowerCase(),
    sizeBytes: manifest.sizeBytes ?? null,
  })
}

export interface ShellbeamAgentArtifactOperationResult {
  job: OperationJob
  record: ShellbeamAgentRecord
  artifact: VerifiedShellbeamAgentArtifact
  plan: ShellbeamAgentArtifactInstallPlan
  remoteStagePath: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export const DEFAULT_SHELLBEAM_AGENT_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024

const SHA256_RE = /^[0-9a-f]{64}$/i
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const SAFE_ID_RE = /^[A-Za-z0-9._@+-]+$/

function text(value: unknown, max = 240) {
  if (typeof value !== 'string') return null
  const clean = [...value].map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('').trim()
  return clean ? clean.slice(0, max) : null
}

function safeHash(value: unknown) {
  if (typeof value !== 'string') return null
  const hash = value.trim().toLowerCase()
  return hash.length === 64 && SHA256_RE.test(hash) ? hash : null
}

function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64_RE.test(value) || value.length % 4 === 1) return null
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function allowedArtifactHost(hostname: string, allowedHosts: string[]) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return allowedHosts.some((entry) => {
    const raw = entry.trim().toLowerCase().replace(/\.$/, '')
    const wildcard = raw.startsWith('*.')
    const allowed = raw.replace(/^\*\./, '')
    if (!allowed) return false
    return normalized === allowed || (wildcard && normalized.endsWith(`.${allowed}`))
  })
}

function safeRemotePath(value: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 400 || normalized.includes('..') || normalized.includes('\\') || [...normalized].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('artifact_path_invalid')
  }
  if (!normalized.startsWith('/')) throw new Error('artifact_path_invalid')
  return normalized
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Validate release metadata before any network or remote filesystem action. */
export function validateShellbeamAgentArtifactManifest(input: unknown, policy: ShellbeamAgentArtifactPolicy): ValidatedShellbeamAgentArtifact {
  if (!input || typeof input !== 'object') throw new Error('artifact_manifest_invalid')
  const raw = input as Partial<ShellbeamAgentArtifactManifest>
  const artifactId = text(raw.artifactId, 120)
  const version = text(raw.version, 80)
  const platform = text(raw.platform, 32)
  const architecture = text(raw.architecture, 32)
  const urlValue = text(raw.url, 2048)
  const sha256 = safeHash(raw.sha256)
  const signatureText = text(raw.signature, 4096)
  const trustedKey = text(policy.trustedPublicKeyBase64, 4096)
  if (!artifactId || !SAFE_ID_RE.test(artifactId) || !version || !SAFE_ID_RE.test(version) || !platform || !SAFE_ID_RE.test(platform) || !architecture || !SAFE_ID_RE.test(architecture) || !urlValue || !sha256 || !signatureText || !trustedKey) throw new Error('artifact_manifest_invalid')
  if (raw.signatureAlgorithm && raw.signatureAlgorithm !== 'ed25519') throw new Error('artifact_signature_algorithm_unsupported')
  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    throw new Error('artifact_url_not_allowed')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !allowedArtifactHost(url.hostname, policy.allowedHosts)) throw new Error('artifact_url_not_allowed')
  const signature = decodeBase64(signatureText)
  if (!signature || signature.length !== 64 || decodeBase64(trustedKey)?.length !== 32) throw new Error('artifact_signature_invalid')
  if (raw.sizeBytes !== undefined && (!Number.isInteger(raw.sizeBytes) || raw.sizeBytes <= 0 || raw.sizeBytes > (policy.maxBytes ?? DEFAULT_SHELLBEAM_AGENT_ARTIFACT_MAX_BYTES))) throw new Error('artifact_size_invalid')
  return { manifest: { artifactId, version, platform, architecture, url: url.toString(), sha256, signature: signatureText, signatureAlgorithm: 'ed25519', ...(raw.sizeBytes ? { sizeBytes: raw.sizeBytes } : {}) }, url, sha256, signature }
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', cryptoBytes(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function cryptoBytes(bytes: Uint8Array): BufferSource {
  // Tauri/browser WebCrypto accepts an ArrayBuffer, while the jsdom runtime
  // used by CI can hold a different realm's ArrayBuffer and only accepts its
  // Node Buffer. Prefer Buffer when it exists and fall back to a detached
  // ArrayBuffer in the browser.
  const maybeBuffer = (globalThis as typeof globalThis & {
    Buffer?: { from(value: Uint8Array): unknown }
  }).Buffer
  if (maybeBuffer) return maybeBuffer.from(bytes) as BufferSource
  const exact = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(exact).set(bytes)
  return exact
}

/**
 * Verify the SHA-256 digest and Ed25519 signature over canonical release
 * metadata. The digest in that metadata binds the signature to the exact
 * artifact bytes, while also protecting version/platform/URL fields.
 * There is no permissive fallback: an unavailable verifier is a hard failure.
 */
export async function verifyShellbeamAgentArtifactBytes(bytes: Uint8Array, validated: ValidatedShellbeamAgentArtifact, trustedPublicKeyBase64: string) {
  const digest = await sha256Hex(bytes)
  if (digest.toLowerCase() !== validated.sha256.toLowerCase()) throw new Error('artifact_hash_mismatch')
  const publicKey = decodeBase64(trustedPublicKeyBase64)
  if (!publicKey || publicKey.length !== 32) throw new Error('artifact_public_key_invalid')
  try {
    const key = await crypto.subtle.importKey('raw', cryptoBytes(publicKey), { name: 'Ed25519' } as AlgorithmIdentifier, false, ['verify'])
    const signedPayload = new TextEncoder().encode(canonicalShellbeamAgentArtifactPayload(validated.manifest))
    const verified = await crypto.subtle.verify({ name: 'Ed25519' } as AlgorithmIdentifier, key, cryptoBytes(validated.signature), cryptoBytes(signedPayload))
    if (!verified) throw new Error('artifact_signature_mismatch')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('artifact_')) throw error
    throw new Error('artifact_signature_verification_failed')
  }
  return { digest, verifiedAt: Date.now() }
}

export async function downloadAndVerifyShellbeamAgentArtifact(manifestInput: unknown, policy: ShellbeamAgentArtifactPolicy, options: { fetchImpl?: typeof fetch; signal?: AbortSignal; now?: number } = {}): Promise<VerifiedShellbeamAgentArtifact> {
  const validated = validateShellbeamAgentArtifactManifest(manifestInput, policy)
  if (!options.fetchImpl) {
    const bytes = await downloadShellbeamAgentBytes(validated.url.toString(), policy.allowedHosts, policy.maxBytes ?? DEFAULT_SHELLBEAM_AGENT_ARTIFACT_MAX_BYTES)
    if (!bytes.length || (validated.manifest.sizeBytes && bytes.length !== validated.manifest.sizeBytes)) throw new Error('artifact_size_invalid')
    await verifyShellbeamAgentArtifactBytes(bytes, validated, policy.trustedPublicKeyBase64)
    return { ...validated, bytes, verifiedAt: options.now ?? Date.now() }
  }
  const response = await options.fetchImpl(validated.url, { method: 'GET', redirect: 'error', signal: options.signal })
  if (!response.ok) throw new Error(`artifact_download_http_${response.status}`)
  const limit = policy.maxBytes ?? DEFAULT_SHELLBEAM_AGENT_ARTIFACT_MAX_BYTES
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > limit) throw new Error('artifact_size_exceeded')
  const bytes = await readResponseBytes(response, limit, contentLength)
  if (!bytes.length || bytes.length > limit || (validated.manifest.sizeBytes && bytes.length !== validated.manifest.sizeBytes)) throw new Error('artifact_size_invalid')
  await verifyShellbeamAgentArtifactBytes(bytes, validated, policy.trustedPublicKeyBase64)
  return { ...validated, bytes, verifiedAt: options.now ?? Date.now() }
}

async function readResponseBytes(response: Response, limit: number, declaredLength: number) {
  if (!response.body) {
    if (!Number.isFinite(declaredLength) || declaredLength <= 0) throw new Error('artifact_stream_unavailable')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > limit) throw new Error('artifact_size_exceeded')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value)
      total += chunk.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new Error('artifact_size_exceeded')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function validateExpectedHash(hash: string | undefined, required: boolean) {
  if (!hash && !required) return undefined
  const normalized = safeHash(hash)
  if (!normalized) throw new Error('artifact_previous_hash_invalid')
  return normalized
}

/**
 * Build an atomic remote install script. The script stages the already verified
 * bytes, verifies the target hash again, and restores a backup only when the
 * backup hash matches the expected pre-change hash.
 */
export function buildShellbeamAgentArtifactInstallPlan(options: { version: string; installPath: string; stagingPath: string; backupPath: string; sha256: string; previousSha256?: string }): ShellbeamAgentArtifactInstallPlan {
  const version = text(options.version, 80)
  const installPath = safeRemotePath(options.installPath)
  const stagingPath = safeRemotePath(options.stagingPath)
  const backupPath = safeRemotePath(options.backupPath)
  const expectedSha256 = safeHash(options.sha256)
  if (!version || !expectedSha256) throw new Error('artifact_install_plan_invalid')
  const expectedPreviousSha256 = validateExpectedHash(options.previousSha256, false)
  const digestScript = `digest_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else return 127; fi; }`
  const expectedPreviousGuard = expectedPreviousSha256
    ? `if [ ! -f ${shellQuote(installPath)} ] || [ "$(digest_file ${shellQuote(installPath)})" != ${shellQuote(expectedPreviousSha256)} ]; then exit 23; fi`
    : `if [ -e ${shellQuote(installPath)} ]; then exit 23; fi`
  const rollback = [
    `rollback_install() {`,
    `if [ -n ${shellQuote(expectedPreviousSha256 ?? '')} ] && [ -e ${shellQuote(backupPath)} ] && [ "$(digest_file ${shellQuote(backupPath)})" = ${shellQuote(expectedPreviousSha256 ?? '')} ]; then`,
    `if cp -p ${shellQuote(backupPath)} ${shellQuote(installPath + ".rollback")} && mv -f ${shellQuote(installPath + ".rollback")} ${shellQuote(installPath)} && [ "$(digest_file ${shellQuote(installPath)})" = ${shellQuote(expectedPreviousSha256 ?? '')} ] && ${shellQuote(installPath)} install --json --path ${shellQuote(installPath)}; then printf '%s\\n' '__SB_AGENT_ROLLBACK=verified'; return 0; fi;`,
    `printf '%s\\n' '__SB_AGENT_ROLLBACK=failed'; return 1;`,
    `fi;`,
    `if [ -e ${shellQuote(installPath)} ] && ! ${shellQuote(installPath)} uninstall --json --path ${shellQuote(installPath)}; then printf '%s\\n' '__SB_AGENT_ROLLBACK=failed'; return 1; fi;`,
    `if [ ! -e ${shellQuote(installPath)} ]; then printf '%s\\n' '__SB_AGENT_ROLLBACK=removed'; return 0; fi;`,
    `printf '%s\\n' '__SB_AGENT_ROLLBACK=failed'; return 1;`,
    `}`,
  ].join(' ')
  const installCommand = [
    'set -eu', digestScript, expectedPreviousGuard,
    `test -f ${shellQuote(stagingPath)}`,
    `if [ "$(digest_file ${shellQuote(stagingPath)})" != ${shellQuote(expectedSha256)} ]; then rm -f ${shellQuote(stagingPath)}; printf '%s\\n' '__SB_AGENT_ROLLBACK=not-needed'; exit 24; fi`,
    `mkdir -p "$(dirname ${shellQuote(installPath)})"`,
    `rm -f ${shellQuote(backupPath)}`,
    `[ ! -e ${shellQuote(installPath)} ] || cp -p ${shellQuote(installPath)} ${shellQuote(backupPath)}`,
    rollback,
    `if ! mv -f ${shellQuote(stagingPath)} ${shellQuote(installPath)}; then if rollback_install; then exit 25; else exit 27; fi; fi`,
    `if [ "$(digest_file ${shellQuote(installPath)})" != ${shellQuote(expectedSha256)} ]; then if rollback_install; then exit 26; else exit 28; fi; fi`,
    `if chmod 0755 ${shellQuote(installPath)} && ${shellQuote(installPath)} install --json --path ${shellQuote(installPath)}; then printf '%s\\n' '__SB_AGENT_STATUS=installed'; else if rollback_install; then exit 29; else exit 30; fi; fi`,
  ].join('; ')
  const rollbackCommand = expectedPreviousSha256
    ? [
      'set -eu', digestScript,
      `test -f ${shellQuote(backupPath)}`,
      `test "$(digest_file ${shellQuote(backupPath)})" = ${shellQuote(expectedPreviousSha256)}`,
      `cp -p ${shellQuote(backupPath)} ${shellQuote(installPath + ".rollback")}`,
      `mv -f ${shellQuote(installPath + ".rollback")} ${shellQuote(installPath)}`,
      `test "$(digest_file ${shellQuote(installPath)})" = ${shellQuote(expectedPreviousSha256)}`,
      `${shellQuote(installPath)} install --json --path ${shellQuote(installPath)}`,
    ].join('; ')
    : `set -eu; if [ -e ${shellQuote(installPath)} ]; then ${shellQuote(installPath)} uninstall --json --path ${shellQuote(installPath)}; fi; test ! -e ${shellQuote(installPath)}`
  return { version, installPath, stagingPath, backupPath, expectedSha256, expectedPreviousSha256, installCommand, rollbackCommand }
}

function base64FromBytes(bytes: Uint8Array) {
  return encodeBase64(bytes)
}

function remotePathForVersion(home: string, version: string, artifactId: string) {
  const normalizedHome = safeRemotePath(home)
  const safeVersion = text(version, 80)
  const safeArtifact = text(artifactId, 120)
  if (!safeVersion || !safeArtifact || !SAFE_ID_RE.test(safeVersion) || !SAFE_ID_RE.test(safeArtifact)) throw new Error('artifact_path_invalid')
  const root = `${normalizedHome}/.local/share/shellbeam-agent`
  return { root, stagingPath: `${root}/.staging/${safeArtifact}-${safeVersion}`, installPath: `${normalizedHome}/.local/bin/shellbeam-agent`, backupPath: `${root}/.backups/shellbeam-agent-${safeVersion}` }
}

function rollbackState(result: { stdout?: string; stderr?: string }) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const marker = output.match(/__SB_AGENT_ROLLBACK=(verified|removed|failed|not-needed)/)?.[1]
  return marker ?? 'unknown'
}

/**
 * Download, verify, upload through the existing SFTP/ProxyJump path and run the
 * atomic installer under one confirmed OperationJob. The manifest and bytes are
 * handled in memory and never persisted to the audit journal.
 */
export async function runShellbeamAgentArtifactOperation(options: {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  manifest: unknown
  policy: ShellbeamAgentArtifactPolicy
  action?: 'install' | 'upgrade'
  previousSha256?: string
  releaseSummary?: string
  vaultId?: string
  confirmMessage?: string
  onRecord?: (record: ShellbeamAgentRecord) => void
}): Promise<ShellbeamAgentArtifactOperationResult | null> {
  const { host, resolveAuthSecret, manifest, policy, action = 'install', previousSha256, releaseSummary, vaultId = 'local', confirmMessage, onRecord } = options
  // Validate metadata before creating the job so the confirmation dialog can
  // show the signed release version without downloading anything. The actual
  // fetch and signature verification happen only after explicit confirmation.
  const validated = validateShellbeamAgentArtifactManifest(manifest, policy)
  const previousRecord = (await listShellbeamAgents({ vaultId, hostId: host.id }).catch(() => []))[0]
  let remoteStagePath = ''
  const initial = normalizeShellbeamAgentRecord({ vaultId, hostId: host.id, status: action === 'upgrade' ? 'upgrading' : 'installing', version: validated.manifest.version, installPath: '$HOME/.local/bin/shellbeam-agent', transport: operationTransport(host), capabilities: [], heartbeatTtlMs: 5 * 60 * 1000, lastCheckedAt: Date.now(), installMethod: 'ssh-confirmed' }, Date.now())
  onRecord?.(initial)
  let execution: { value: { artifact: VerifiedShellbeamAgentArtifact; exitCode: number; durationMs: number; stdout: string; stderr: string; plan: ShellbeamAgentArtifactInstallPlan }; job: OperationJob } | null
  try {
    execution = await runConfirmedOperation({
      host, action: `agent.${action}.artifact`, target: `shellbeam-agent ${action} ${validated.manifest.version}`, risk: 'high', provider: 'shellbeam-agent', transport: operationTransport(host),
      paramsSummary: `artifact=${validated.manifest.artifactId}; version=${validated.manifest.version}; sha256=${validated.sha256}${releaseSummary ? `; ${releaseSummary.slice(0, 240)}` : ''}`,
      confirmMessage: confirmMessage ?? `Confirm ${action} of ShellBeam Probe ${validated.manifest.version} on ${host.name}?`,
      execute: async () => {
        const artifact = await downloadAndVerifyShellbeamAgentArtifact(manifest, policy)
        const secret = vaultId && host.id ? '' : await resolveAuthSecret(host)
        const auth = { vaultId, hostId: host.id, host: host.address, port: host.port || 22, username: host.username || 'root', authType: host.authType, ...(host.authType === 'password' ? { password: secret } : {}), ...(host.authType === 'privateKey' ? { privateKey: secret } : {}), jumpHost: host.jumpHost, jumpPort: host.jumpPort, jumpUser: host.jumpUser }
        const home = await sftpHomeDir({ ...auth, remotePath: '.' })
        const paths = remotePathForVersion(home, artifact.manifest.version, artifact.manifest.artifactId)
        let previousHash = previousSha256
        if (action === 'upgrade' && !previousHash) {
          const current = await runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command: `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${shellQuote(paths.installPath)}; else shasum -a 256 ${shellQuote(paths.installPath)}; fi` })
          previousHash = safeHash(current.stdout.trim().split(/\s+/)[0]) ?? undefined
          if (current.exitCode !== 0 || !previousHash) throw new Error('artifact_previous_hash_unavailable')
        }
        const installPlan = buildShellbeamAgentArtifactInstallPlan({ ...paths, version: artifact.manifest.version, sha256: artifact.sha256, previousSha256: previousHash })
        remoteStagePath = installPlan.stagingPath
        await runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command: `mkdir -p ${shellQuote(paths.stagingPath.slice(0, paths.stagingPath.lastIndexOf('/')))} ${shellQuote(paths.backupPath.slice(0, paths.backupPath.lastIndexOf('/')))} && chmod 0700 ${shellQuote(paths.root)}` })
        await sftpUploadFile({ ...auth, remotePath: installPlan.stagingPath, contentB64: base64FromBytes(artifact.bytes) })
        const commandResult = await runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command: installPlan.installCommand })
        return { ...commandResult, artifact, plan: installPlan }
      },
      getResult: (result) => {
        const rollback = rollbackState(result)
        return {
          ...result,
          resultSummary: `exit=${result.exitCode}; durationMs=${result.durationMs}; rollback=${rollback}`,
          ...(result.exitCode !== 0 ? {
            errorCode: rollback === 'failed' || rollback === 'unknown' ? 'artifact_rollback_unknown' : 'artifact_install_failed_rolled_back',
            errorSummary: rollback === 'failed' || rollback === 'unknown'
              ? 'Artifact activation failed and rollback could not be verified; manual recovery is required.'
              : `Artifact activation failed; rollback=${rollback}.`,
          } : {}),
        }
      },
    })
  } catch (error) {
    const unknown = normalizeShellbeamAgentRecord({ ...initial, status: 'unknown', health: 'unknown', lastErrorCode: 'artifact_operation_unknown', lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() }, Date.now())
    onRecord?.(unknown)
    await upsertShellbeamAgent(unknown).catch(() => undefined)
    throw error
  }
  if (!execution) {
    const cancelled = previousRecord ?? normalizeShellbeamAgentRecord({ vaultId, hostId: host.id, status: 'not-installed', health: 'unknown', transport: operationTransport(host) })
    onRecord?.(cancelled)
    // Cancellation changes no lifecycle state or installed version.
    return null
  }
  const successful = execution.value.exitCode === 0
  const installedPlan = execution.value.plan
  const rollbackMarker = execution.value.stdout.match(/__SB_AGENT_ROLLBACK=(verified|removed|failed|not-needed)/)?.[1]
  const auditedJob = rollbackMarker
    ? await updateOperationJob({
      jobId: execution.job.jobId,
      status: execution.job.status,
      resultSummary: `artifact install exit=${execution.value.exitCode}; rollback=${rollbackMarker}`,
    })
    : execution.job
  const artifact = execution.value.artifact
  const rollback = rollbackState(execution.value)
  const verifiedCurrent = successful || rollback === 'verified'
    ? await checkShellbeamAgent(host, resolveAuthSecret, Date.now(), vaultId).catch(() => null)
    : null
  const currentRecord = verifiedCurrent?.record
  if (verifiedCurrent?.snapshot && (verifiedCurrent.snapshot.metrics || verifiedCurrent.snapshot.inventory)) await upsertPersistedProbeSnapshot(verifiedCurrent.snapshot, vaultId).catch(() => undefined)
  const record = normalizeShellbeamAgentRecord({
    ...initial,
    ...(currentRecord ?? {}),
    vaultId,
    status: currentRecord?.status === 'installed' ? 'installed' as const : successful ? 'unknown' as const : execution.job.status === 'unknown' || rollback === 'failed' || rollback === 'unknown' ? 'unknown' as const : 'failed' as const,
    health: currentRecord?.health ?? 'unknown' as const,
    updatedAt: Date.now(),
    installedAt: successful ? Date.now() : null,
    lastCheckedAt: Date.now(),
    lastErrorCode: successful && currentRecord?.status !== 'installed' ? 'agent_activation_check_unknown' : successful ? null : rollback === 'failed' || rollback === 'unknown' ? 'artifact_rollback_unknown' : 'artifact_install_failed_rolled_back',
    lastError: successful && currentRecord?.status !== 'installed' ? 'Artifact activation completed but follow-up observation is unavailable.' : successful ? null : rollback === 'failed' || rollback === 'unknown'
      ? 'Artifact activation failed and rollback could not be verified; manual recovery is required.'
      : `Verified artifact activation failed; rollback=${rollback}.`,
    installPath: installedPlan.installPath,
    version: currentRecord?.version ?? (successful ? artifact.manifest.version : previousRecord?.version ?? null),
    transport: operationTransport(host),
  }, Date.now())
  onRecord?.(record)
  await upsertShellbeamAgent(record)
  return { job: auditedJob, record, artifact, plan: installedPlan, remoteStagePath, stdout: execution.value.stdout, stderr: execution.value.stderr, exitCode: execution.value.exitCode, durationMs: execution.value.durationMs }
}
