import type {
  ShellbeamAgentArtifactManifest,
  ShellbeamAgentArtifactPolicy,
  ValidatedShellbeamAgentArtifact,
} from './shellbeam-agent-artifact'
import { validateShellbeamAgentArtifactManifest } from './shellbeam-agent-artifact'
import type { OperationJob, OperationJobStatus } from './operation-job'

/** Release channels are deliberately explicit. A preview/canary cannot be
 * selected by the default stable policy, which keeps a signed preview from
 * becoming an unattended production upgrade. */
export type ShellbeamAgentReleaseChannel = 'stable' | 'preview' | 'canary'
export type ShellbeamAgentReleaseStage = ShellbeamAgentReleaseChannel | 'rollback'
export type ShellbeamAgentReleaseEventName =
  | 'selected'
  | 'skipped'
  | 'confirmed'
  | 'started'
  | 'completed'
  | 'failed'
  | 'rolled-back'
  | 'rollback-failed'
  | 'unknown'

export interface ShellbeamAgentReleaseRollout {
  /** Percentage in the deterministic cohort [0, 100]. */
  percentage: number
  /** Stable salt controlled by the release publisher. */
  salt: string
}

/** Metadata signed by the release key. Artifact.signature still signs the
 * artifact payload itself; this envelope signs channel, expiry and rollout
 * policy so a mirror cannot silently promote a preview to stable. */
export interface ShellbeamAgentReleaseManifest {
  releaseId: string
  channel: ShellbeamAgentReleaseChannel
  publishedAt: number
  expiresAt?: number
  minAgentVersion?: string
  maxAgentVersion?: string
  rollout?: ShellbeamAgentReleaseRollout
  previousSha256?: string
  rollbackOf?: string
  releaseSignature?: string
  releaseSignatureAlgorithm?: 'ed25519'
  artifact: ShellbeamAgentArtifactManifest
}

export interface ShellbeamAgentReleasePolicy {
  artifact: ShellbeamAgentArtifactPolicy
  /** Channels available to this installation. Defaults to stable only. */
  allowedChannels?: ShellbeamAgentReleaseChannel[]
  /** Preview and canary require this opt-in even if allowedChannels includes them. */
  allowPreview?: boolean
  /** Stable releases must be signed by the release key when supplied. */
  requireReleaseSignature?: boolean
  trustedReleasePublicKeyBase64?: string
  maxClockSkewMs?: number
  now?: number
}

export interface ValidatedShellbeamAgentRelease {
  manifest: ShellbeamAgentReleaseManifest
  artifact: ValidatedShellbeamAgentArtifact
  releaseStage: ShellbeamAgentReleaseStage
  releaseSignature: Uint8Array | null
}

export interface ShellbeamAgentReleaseSelection {
  selected: ValidatedShellbeamAgentRelease | null
  candidates: ValidatedShellbeamAgentRelease[]
  skipped: Array<{ releaseId: string; reason: string }>
}

export interface ShellbeamAgentReleaseDecision {
  eligible: boolean
  stage: ShellbeamAgentReleaseStage
  reason: 'eligible' | 'channel-not-allowed' | 'preview-not-enabled' | 'rollout-excluded' | 'version-incompatible' | 'expired' | 'invalid-manifest'
  cohort: number
}

export interface ShellbeamAgentReleaseAuditEvent {
  releaseId: string
  channel: ShellbeamAgentReleaseChannel
  stage: ShellbeamAgentReleaseStage
  event: ShellbeamAgentReleaseEventName
  hostId?: string
  hostName?: string
  jobId?: string
  auditId?: string
  version: string
  sha256Prefix: string
  reason?: string
  createdAt: number
}

export interface ShellbeamAgentReleaseAuditContext {
  release: Pick<ValidatedShellbeamAgentRelease, 'manifest' | 'releaseStage'>
  host?: { id: string; name?: string }
  job?: Pick<OperationJob, 'jobId' | 'auditId' | 'status' | 'errorCode' | 'resultSummary'>
  event: ShellbeamAgentReleaseEventName
  reason?: string
  now?: number
}

const SAFE_ID = /^[A-Za-z0-9._@+-]+$/
const SHA256_RE = /^[0-9a-f]{64}$/i
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const DEFAULT_CHANNELS: ShellbeamAgentReleaseChannel[] = ['stable']

function text(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null
  const clean = [...value].map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('').trim()
  return clean ? clean.slice(0, max) : null
}

function hash(value: string) {
  // FNV-1a is not a security primitive. It only makes the cohort assignment
  // stable and explainable; artifact and release signatures provide integrity.
  let output = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index)
    output = Math.imul(output, 16777619)
  }
  return (output >>> 0) % 100
}

function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64_RE.test(value) || value.length % 4 === 1) return null
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function cryptoBytes(bytes: Uint8Array): BufferSource {
  const maybeBuffer = (globalThis as typeof globalThis & { Buffer?: { from(value: Uint8Array): unknown } }).Buffer
  if (maybeBuffer) return maybeBuffer.from(bytes) as BufferSource
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function versionParts(value: string): { numbers: number[]; prerelease: string[] } | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return { numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)], prerelease: match[4]?.split('.') ?? [] }
}

function compareVersions(a: string, b: string) {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) return null
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] - right.numbers[index]
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const l = left.prerelease[index]
    const r = right.prerelease[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const lNumber = /^\d+$/.test(l)
    const rNumber = /^\d+$/.test(r)
    if (lNumber && rNumber) return Number(l) - Number(r)
    if (lNumber) return -1
    if (rNumber) return 1
    return l < r ? -1 : 1
  }
  return 0
}

function releaseStage(channel: ShellbeamAgentReleaseChannel): ShellbeamAgentReleaseStage {
  return channel
}

function normalizedRollout(value: unknown): ShellbeamAgentReleaseRollout {
  if (!value || typeof value !== 'object') return { percentage: 100, salt: 'default' }
  const rollout = value as Partial<ShellbeamAgentReleaseRollout>
  const percentage = Number(rollout.percentage)
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error('release_rollout_invalid')
  const salt = text(rollout.salt, 120)
  if (!salt || !SAFE_ID.test(salt)) throw new Error('release_rollout_invalid')
  return { percentage, salt }
}

function canonicalReleasePayload(manifest: ShellbeamAgentReleaseManifest) {
  return JSON.stringify({
    releaseId: manifest.releaseId,
    channel: manifest.channel,
    publishedAt: manifest.publishedAt,
    expiresAt: manifest.expiresAt ?? null,
    minAgentVersion: manifest.minAgentVersion ?? null,
    maxAgentVersion: manifest.maxAgentVersion ?? null,
    rollout: manifest.rollout ?? { percentage: 100, salt: 'default' },
    previousSha256: manifest.previousSha256 ?? null,
    rollbackOf: manifest.rollbackOf ?? null,
    artifactId: manifest.artifact.artifactId,
    artifactVersion: manifest.artifact.version,
    artifactSha256: manifest.artifact.sha256.toLowerCase(),
  })
}

/** Stable JSON used by Ed25519 release signatures. Exported for publishers and tests. */
export function canonicalShellbeamAgentReleasePayload(manifest: ShellbeamAgentReleaseManifest) {
  return canonicalReleasePayload(manifest)
}

function validateTimestamp(value: unknown, field: string) {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`release_${field}_invalid`)
  return Number(value)
}

function validateHash(value: unknown, field: string) {
  if (typeof value !== 'string' || !SHA256_RE.test(value.trim())) throw new Error(`release_${field}_invalid`)
  return value.trim().toLowerCase()
}

/** Validate release channel metadata and delegate URL/hash/signature checks to
 * the existing artifact policy. This function does not download bytes. */
export function validateShellbeamAgentReleaseManifest(input: unknown, policy: ShellbeamAgentReleasePolicy, now = policy.now ?? Date.now()): ValidatedShellbeamAgentRelease {
  if (!input || typeof input !== 'object') throw new Error('release_manifest_invalid')
  const raw = input as Partial<ShellbeamAgentReleaseManifest>
  const releaseId = text(raw.releaseId, 120)
  const channelValue = raw.channel
  if (!releaseId || !SAFE_ID.test(releaseId) || !['stable', 'preview', 'canary'].includes(channelValue as string)) throw new Error('release_manifest_invalid')
  const channel = channelValue as ShellbeamAgentReleaseChannel
  const allowed = policy.allowedChannels ?? DEFAULT_CHANNELS
  if (channel !== 'stable' && policy.allowPreview !== true) throw new Error('release_preview_disabled')
  if (!allowed.includes(channel as ShellbeamAgentReleaseChannel)) throw new Error('release_channel_not_allowed')
  const publishedAt = validateTimestamp(raw.publishedAt, 'published_at')
  const skew = policy.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS
  if (publishedAt > now + skew) throw new Error('release_published_in_future')
  const expiresAt = raw.expiresAt === undefined ? undefined : validateTimestamp(raw.expiresAt, 'expires_at')
  if (expiresAt !== undefined && expiresAt <= now - skew) throw new Error('release_expired')
  if (expiresAt !== undefined && expiresAt <= publishedAt) throw new Error('release_expiry_invalid')
  const minAgentVersion = raw.minAgentVersion === undefined ? undefined : text(raw.minAgentVersion, 80)
  const maxAgentVersion = raw.maxAgentVersion === undefined ? undefined : text(raw.maxAgentVersion, 80)
  if (raw.minAgentVersion !== undefined && !minAgentVersion || raw.minAgentVersion !== undefined && !versionParts(minAgentVersion!)) throw new Error('release_version_invalid')
  if (raw.maxAgentVersion !== undefined && !maxAgentVersion || raw.maxAgentVersion !== undefined && !versionParts(maxAgentVersion!)) throw new Error('release_version_invalid')
  if (minAgentVersion && maxAgentVersion && (compareVersions(minAgentVersion, maxAgentVersion) ?? 1) > 0) throw new Error('release_version_range_invalid')
  const rollout = normalizedRollout(raw.rollout)
  const previousSha256 = raw.previousSha256 === undefined ? undefined : validateHash(raw.previousSha256, 'previous_hash')
  const rollbackOf = raw.rollbackOf === undefined ? undefined : text(raw.rollbackOf, 120)
  if (raw.rollbackOf !== undefined && (!rollbackOf || !SAFE_ID.test(rollbackOf))) throw new Error('release_rollback_invalid')
  const artifact = validateShellbeamAgentArtifactManifest(raw.artifact, policy.artifact)
  const releaseSignatureText = raw.releaseSignature === undefined ? undefined : text(raw.releaseSignature, 4096)
  if (raw.releaseSignature !== undefined && (!releaseSignatureText || !decodeBase64(releaseSignatureText) || decodeBase64(releaseSignatureText)!.length !== 64)) throw new Error('release_signature_invalid')
  if (raw.releaseSignatureAlgorithm && raw.releaseSignatureAlgorithm !== 'ed25519') throw new Error('release_signature_algorithm_unsupported')
  if ((policy.requireReleaseSignature ?? true) && (!releaseSignatureText || !policy.trustedReleasePublicKeyBase64)) throw new Error('release_signature_required')
  const releaseManifest: ShellbeamAgentReleaseManifest = {
    releaseId, channel, publishedAt, ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(minAgentVersion ? { minAgentVersion } : {}), ...(maxAgentVersion ? { maxAgentVersion } : {}), rollout,
    ...(previousSha256 ? { previousSha256 } : {}), ...(rollbackOf ? { rollbackOf } : {}),
    ...(releaseSignatureText ? { releaseSignature: releaseSignatureText, releaseSignatureAlgorithm: 'ed25519' } : {}),
    artifact: artifact.manifest,
  }
  return {
    manifest: releaseManifest,
    artifact,
    releaseStage: releaseStage(channel),
    releaseSignature: releaseSignatureText ? decodeBase64(releaseSignatureText) : null,
  }
}

/** Verify the release envelope signature. Artifact bytes are verified by
 * verifyShellbeamAgentArtifactBytes before activation; both signatures are
 * therefore required for a release operation. */
export async function verifyShellbeamAgentReleaseSignature(
  release: ValidatedShellbeamAgentRelease,
  trustedPublicKeyBase64: string,
) {
  if (!release.releaseSignature) throw new Error('release_signature_required')
  const publicKey = decodeBase64(trustedPublicKeyBase64)
  if (!publicKey || publicKey.length !== 32) throw new Error('release_public_key_invalid')
  try {
    const key = await crypto.subtle.importKey('raw', cryptoBytes(publicKey), { name: 'Ed25519' } as AlgorithmIdentifier, false, ['verify'])
    const payload = new TextEncoder().encode(canonicalReleasePayload(release.manifest))
    const verified = await crypto.subtle.verify({ name: 'Ed25519' } as AlgorithmIdentifier, key, cryptoBytes(release.releaseSignature), cryptoBytes(payload))
    if (!verified) throw new Error('release_signature_mismatch')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('release_')) throw error
    throw new Error('release_signature_verification_failed')
  }
  return true
}

export function decideShellbeamAgentRelease(options: {
  release: ValidatedShellbeamAgentRelease
  hostId: string
  currentVersion?: string | null
  now?: number
}): ShellbeamAgentReleaseDecision {
  const now = options.now ?? Date.now()
  const manifest = options.release.manifest
  if (manifest.expiresAt !== undefined && manifest.expiresAt <= now) return { eligible: false, stage: options.release.releaseStage, reason: 'expired', cohort: 100 }
  if (manifest.minAgentVersion && options.currentVersion && (compareVersions(options.currentVersion, manifest.minAgentVersion) ?? -1) < 0) return { eligible: false, stage: options.release.releaseStage, reason: 'version-incompatible', cohort: 100 }
  if (manifest.maxAgentVersion && options.currentVersion && (compareVersions(options.currentVersion, manifest.maxAgentVersion) ?? 1) > 0) return { eligible: false, stage: options.release.releaseStage, reason: 'version-incompatible', cohort: 100 }
  const rollout = manifest.rollout ?? { percentage: 100, salt: 'default' }
  const cohort = hash(`${rollout.salt}:${options.hostId}`)
  if (cohort >= rollout.percentage) return { eligible: false, stage: options.release.releaseStage, reason: 'rollout-excluded', cohort }
  return { eligible: true, stage: options.release.releaseStage, reason: 'eligible', cohort }
}

/** Select the newest eligible signed release. Stable sorting is deterministic
 * and ignores malformed/expired manifests rather than weakening policy. */
export function selectShellbeamAgentRelease(options: {
  manifests: unknown[]
  policy: ShellbeamAgentReleasePolicy
  hostId: string
  currentVersion?: string | null
  now?: number
}): ShellbeamAgentReleaseSelection {
  const now = options.now ?? options.policy.now ?? Date.now()
  const candidates: ValidatedShellbeamAgentRelease[] = []
  const skipped: Array<{ releaseId: string; reason: string }> = []
  for (const input of options.manifests) {
    let release: ValidatedShellbeamAgentRelease
    try {
      release = validateShellbeamAgentReleaseManifest(input, { ...options.policy, now }, now)
    } catch (error) {
      const releaseId = input && typeof input === 'object' && typeof (input as { releaseId?: unknown }).releaseId === 'string' ? String((input as { releaseId: string }).releaseId).slice(0, 120) : 'unknown'
      skipped.push({ releaseId, reason: error instanceof Error ? error.message : 'release_manifest_invalid' })
      continue
    }
    const decision = decideShellbeamAgentRelease({ release, hostId: options.hostId, currentVersion: options.currentVersion, now })
    if (decision.eligible) candidates.push(release)
    else skipped.push({ releaseId: release.manifest.releaseId, reason: decision.reason })
  }
  candidates.sort((left, right) => (compareVersions(right.manifest.artifact.version, left.manifest.artifact.version) ?? 0) || right.manifest.publishedAt - left.manifest.publishedAt)
  return { selected: candidates[0] ?? null, candidates, skipped }
}

export function shellbeamAgentReleaseParamsSummary(options: { release: ValidatedShellbeamAgentRelease; stage?: ShellbeamAgentReleaseStage; rollout?: number }) {
  const manifest = options.release.manifest
  const sha256 = manifest.artifact.sha256.toLowerCase()
  return `release=${manifest.releaseId}; channel=${manifest.channel}; stage=${options.stage ?? options.release.releaseStage}; version=${manifest.artifact.version}; sha256=${sha256.slice(0, 12)}; rollout=${Math.round(options.rollout ?? manifest.rollout?.percentage ?? 100)}%`
}

function rollbackMarker(job: Pick<OperationJob, 'resultSummary' | 'errorCode' | 'status'>) {
  const value = `${job.resultSummary ?? ''} ${job.errorCode ?? ''}`
  if (/rollback=(?:verified|removed|completed)/i.test(value)) return 'completed' as const
  if (/rollback=(?:failed|unknown)/i.test(value) || job.status === 'unknown') return 'unknown' as const
  return 'not-needed' as const
}

/** Convert durable OperationJob state to a release audit event. This keeps
 * release policy visible in the same audit stream without storing URLs,
 * signatures, credentials or command output. */
export function createShellbeamAgentReleaseAuditEvent(context: ShellbeamAgentReleaseAuditContext): ShellbeamAgentReleaseAuditEvent {
  const manifest = context.release.manifest
  const job = context.job
  const rollback = job ? rollbackMarker(job) : 'not-needed'
  const event = context.event === 'failed' && context.release.releaseStage !== 'rollback' && rollback === 'completed'
    ? 'rolled-back'
    : context.event === 'failed' && context.release.releaseStage !== 'rollback' && rollback === 'unknown'
      ? 'rollback-failed'
      : context.event
  return {
    releaseId: manifest.releaseId,
    channel: manifest.channel,
    stage: context.release.releaseStage,
    event,
    ...(context.host?.id ? { hostId: context.host.id } : {}),
    ...(context.host?.name ? { hostName: context.host.name.slice(0, 160) } : {}),
    ...(job?.jobId ? { jobId: job.jobId } : {}),
    ...(job?.auditId ? { auditId: job.auditId } : {}),
    version: manifest.artifact.version,
    sha256Prefix: manifest.artifact.sha256.slice(0, 12),
    ...(context.reason ? { reason: context.reason.slice(0, 240) } : {}),
    createdAt: context.now ?? Date.now(),
  }
}

export function releaseAuditEventForJob(job: Pick<OperationJob, 'jobId' | 'auditId' | 'status' | 'errorCode' | 'resultSummary'>, release: ValidatedShellbeamAgentRelease, host?: { id: string; name?: string }, now = Date.now()) {
  const event: ShellbeamAgentReleaseEventName = job.status === 'completed'
    ? 'completed'
    : job.status === 'unknown'
      ? 'unknown'
      : job.status === 'failed'
        ? 'failed'
        : 'started'
  return createShellbeamAgentReleaseAuditEvent({ release, host, job, event, now })
}

export function releaseNeedsManualRecovery(job: Pick<OperationJob, 'status' | 'errorCode' | 'resultSummary'>) {
  return rollbackMarker(job) === 'unknown'
}

export function releaseOperationStatus(job: Pick<OperationJob, 'status' | 'errorCode' | 'resultSummary'>): OperationJobStatus {
  const rollback = rollbackMarker(job)
  if (rollback === 'unknown') return 'unknown'
  if (job.status === 'failed' && rollback === 'completed') return 'failed'
  return job.status
}
