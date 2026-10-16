import type {
  ShellbeamAgentReleaseChannel,
  ShellbeamAgentReleasePolicy,
} from './shellbeam-agent-release'
import type { ShellbeamAgentArtifactPolicy } from './shellbeam-agent-artifact'

/**
 * User controlled release policy. This record intentionally contains only
 * release metadata and public verification material. Credentials, API keys,
 * signed manifests, and downloaded artifacts never belong in this store.
 */
export interface ShellbeamAgentReleaseSettings {
  enabled: boolean
  channel: ShellbeamAgentReleaseChannel
  allowedChannels: ShellbeamAgentReleaseChannel[]
  allowPreview: boolean
  rolloutPercentage: number
  rolloutSalt: string
  artifactAllowedHosts: string[]
  artifactTrustedPublicKeyBase64: string
  trustedReleasePublicKeyBase64: string
  requireReleaseSignature: boolean
}

export interface ShellbeamAgentReleaseSettingsSummary {
  enabled: boolean
  channel: ShellbeamAgentReleaseChannel
  allowedChannels: ShellbeamAgentReleaseChannel[]
  allowPreview: boolean
  rolloutPercentage: number
  artifactHostCount: number
  artifactKeyConfigured: boolean
  releaseKeyConfigured: boolean
  requireReleaseSignature: boolean
}

export const SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY = 'shellbeam.agentReleaseSettings'
export const DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS: ShellbeamAgentReleaseSettings = {
  enabled: false,
  channel: 'stable',
  allowedChannels: ['stable'],
  allowPreview: false,
  rolloutPercentage: 100,
  rolloutSalt: 'default',
  artifactAllowedHosts: [],
  artifactTrustedPublicKeyBase64: '',
  trustedReleasePublicKeyBase64: '',
  requireReleaseSignature: true,
}

const CHANNELS: ShellbeamAgentReleaseChannel[] = ['stable', 'preview', 'canary']
const SAFE_SALT = /^[A-Za-z0-9._@+-]{1,120}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function cleanText(value: unknown, max = 4096): string {
  if (typeof value !== 'string') return ''
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : character
  }).join('').trim().slice(0, max)
}

function normalizeChannels(value: unknown): ShellbeamAgentReleaseChannel[] {
  if (!Array.isArray(value)) return ['stable']
  const result = CHANNELS.filter((channel) => value.includes(channel))
  return result.length > 0 ? result : ['stable']
}

function normalizeHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map((item) => cleanText(item, 253).toLowerCase().replace(/\.$/, ''))
    .filter((item) => item.length > 0 && item.length <= 253 && !item.includes('/') && !item.includes(' ')))]
    .slice(0, 32)
}

function normalizeKey(value: unknown): string {
  const key = cleanText(value)
  return BASE64.test(key) ? key : ''
}

function normalizeSalt(value: unknown): string {
  const salt = cleanText(value, 120)
  return SAFE_SALT.test(salt) ? salt : 'default'
}

function normalizePercentage(value: unknown): number {
  const percentage = Number(value)
  if (!Number.isFinite(percentage)) return 100
  return Math.min(100, Math.max(0, Math.round(percentage)))
}

export function normalizeShellbeamAgentReleaseSettings(input: unknown): ShellbeamAgentReleaseSettings {
  const raw = input && typeof input === 'object' ? input as Partial<ShellbeamAgentReleaseSettings> : {}
  const allowedChannels = normalizeChannels(raw.allowedChannels)
  const channel = CHANNELS.includes(raw.channel as ShellbeamAgentReleaseChannel) && allowedChannels.includes(raw.channel as ShellbeamAgentReleaseChannel)
    ? raw.channel as ShellbeamAgentReleaseChannel
    : allowedChannels[0]
  const allowPreview = raw.allowPreview === true && allowedChannels.some((item) => item === 'preview' || item === 'canary')
  return {
    enabled: raw.enabled === true,
    channel,
    allowedChannels,
    allowPreview,
    rolloutPercentage: normalizePercentage(raw.rolloutPercentage),
    rolloutSalt: normalizeSalt(raw.rolloutSalt),
    artifactAllowedHosts: normalizeHosts(raw.artifactAllowedHosts),
    artifactTrustedPublicKeyBase64: normalizeKey(raw.artifactTrustedPublicKeyBase64),
    trustedReleasePublicKeyBase64: normalizeKey(raw.trustedReleasePublicKeyBase64),
    // Signature verification cannot be disabled by this UI. Keeping the
    // field in the policy makes the invariant visible to callers and tests.
    requireReleaseSignature: true,
  }
}

export function loadShellbeamAgentReleaseSettings(): ShellbeamAgentReleaseSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS }
  try {
    const raw = localStorage.getItem(SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS }
    return normalizeShellbeamAgentReleaseSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS }
  }
}

export function saveShellbeamAgentReleaseSettings(settings: ShellbeamAgentReleaseSettings): ShellbeamAgentReleaseSettings {
  const normalized = normalizeShellbeamAgentReleaseSettings(settings)
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY, JSON.stringify(normalized))
  }
  return normalized
}

export function clearShellbeamAgentReleaseSettings() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY)
}

/** Build the runtime artifact policy from settings without exposing secrets. */
export function shellbeamAgentReleasePolicyFromSettings(settings: ShellbeamAgentReleaseSettings): ShellbeamAgentReleasePolicy {
  const normalized = normalizeShellbeamAgentReleaseSettings(settings)
  const artifact: ShellbeamAgentArtifactPolicy = {
    allowedHosts: normalized.artifactAllowedHosts,
    trustedPublicKeyBase64: normalized.artifactTrustedPublicKeyBase64,
  }
  return {
    artifact,
    allowedChannels: normalized.allowedChannels,
    allowPreview: normalized.allowPreview,
    requireReleaseSignature: normalized.requireReleaseSignature,
    trustedReleasePublicKeyBase64: normalized.trustedReleasePublicKeyBase64 || undefined,
  }
}

export function shellbeamAgentReleaseSettingsSummary(settings: ShellbeamAgentReleaseSettings): ShellbeamAgentReleaseSettingsSummary {
  const normalized = normalizeShellbeamAgentReleaseSettings(settings)
  return {
    enabled: normalized.enabled,
    channel: normalized.channel,
    allowedChannels: normalized.allowedChannels,
    allowPreview: normalized.allowPreview,
    rolloutPercentage: normalized.rolloutPercentage,
    artifactHostCount: normalized.artifactAllowedHosts.length,
    artifactKeyConfigured: normalized.artifactTrustedPublicKeyBase64.length > 0,
    releaseKeyConfigured: normalized.trustedReleasePublicKeyBase64.length > 0,
    requireReleaseSignature: normalized.requireReleaseSignature,
  }
}
