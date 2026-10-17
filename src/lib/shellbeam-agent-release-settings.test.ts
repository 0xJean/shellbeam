import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS,
  SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY,
  clearShellbeamAgentReleaseSettings,
  loadShellbeamAgentReleaseSettings,
  normalizeShellbeamAgentReleaseSettings,
  saveShellbeamAgentReleaseSettings,
  shellbeamAgentReleasePolicyFromSettings,
  shellbeamAgentReleaseSettingsSummary,
} from './shellbeam-agent-release-settings'

const key = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA='

describe('ShellBeam Agent release settings', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to a disabled stable policy with mandatory signatures', () => {
    expect(loadShellbeamAgentReleaseSettings()).toEqual(DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS)
    expect(shellbeamAgentReleasePolicyFromSettings(DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS)).toMatchObject({
      allowedChannels: ['stable'],
      allowPreview: false,
      requireReleaseSignature: true,
    })
  })

  it('normalizes channel selection and clamps rollout values', () => {
    const settings = normalizeShellbeamAgentReleaseSettings({
      enabled: true,
      channel: 'canary',
      allowedChannels: ['preview'],
      allowPreview: true,
      rolloutPercentage: 180,
      rolloutSalt: 'unsafe salt',
      artifactAllowedHosts: [' Downloads.Example.com ', 'downloads.example.com', 'bad host'],
      artifactTrustedPublicKeyBase64: key,
      trustedReleasePublicKeyBase64: key,
      requireReleaseSignature: false,
    })
    expect(settings.channel).toBe('preview')
    expect(settings.allowedChannels).toEqual(['preview'])
    expect(settings.allowPreview).toBe(true)
    expect(settings.rolloutPercentage).toBe(100)
    expect(settings.rolloutSalt).toBe('default')
    expect(settings.artifactAllowedHosts).toEqual(['downloads.example.com'])
    expect(settings.requireReleaseSignature).toBe(true)
  })

  it('persists only the release policy fields and returns a redacted summary', () => {
    const saved = saveShellbeamAgentReleaseSettings({
      ...DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS,
      enabled: true,
      allowedChannels: ['stable', 'canary'],
      channel: 'canary',
      allowPreview: true,
      artifactAllowedHosts: ['downloads.example.com'],
      artifactTrustedPublicKeyBase64: key,
      trustedReleasePublicKeyBase64: key,
    })
    expect(localStorage.getItem(SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY)).toContain('downloads.example.com')
    expect(shellbeamAgentReleaseSettingsSummary(saved)).toEqual({
      enabled: true,
      channel: 'canary',
      allowedChannels: ['stable', 'canary'],
      allowPreview: true,
      rolloutPercentage: 100,
      artifactHostCount: 1,
      artifactKeyConfigured: true,
      releaseKeyConfigured: true,
      requireReleaseSignature: true,
    })
    expect(JSON.stringify(shellbeamAgentReleaseSettingsSummary(saved))).not.toContain(key)
  })

  it('clears saved settings without touching unrelated storage', () => {
    localStorage.setItem('unrelated', 'keep')
    saveShellbeamAgentReleaseSettings(DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS)
    clearShellbeamAgentReleaseSettings()
    expect(localStorage.getItem(SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY)).toBeNull()
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })
})
