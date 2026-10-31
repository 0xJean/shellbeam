import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  availableVersion, checkForAppUpdate, compareVersions, dismissAppUpdate, getAppUpdateSnapshot, isUpdateCheckDue, reminderVersion,
  releasedVersion, resetAppUpdateForTests, setAppUpdateChecksEnabled, startAppUpdateChecks, UPDATE_CHECK_INTERVAL_MS, UPDATE_STARTUP_GAP_MS,
} from './app-update'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }))
const invokeMock = vi.mocked(invoke)

function nativeAnswers(release: unknown, { version = '0.1.8', platform = 'macos' } = {}) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'app_update_info') return { version, platform }
    if (command === 'check_latest_app_release') {
      if (release instanceof Error) throw release
      return release
    }
    throw new Error(`unexpected ${command}`)
  })
}
const released = (tag: string) => ({ tag_name: tag, draft: false, prerelease: false })
const githubCalls = () => invokeMock.mock.calls.filter(([command]) => command === 'check_latest_app_release').length

beforeEach(() => {
  localStorage.clear()
  invokeMock.mockReset()
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  resetAppUpdateForTests()
})

describe('compareVersions', () => {
  it.each([
    ['0.1.10', '0.1.9', 1], ['0.1.9', '0.1.10', -1], ['0.2.0', '0.1.99', 1], ['1.0.0', '0.99.99', 1],
    ['v0.1.8', '0.1.8', 0], ['0.1.8+build.7', '0.1.8', 0],
    ['0.2.0', '0.2.0-beta.1', 1], ['0.2.0-beta.1', '0.2.0', -1], ['0.2.0-beta.10', '0.2.0-beta.9', 1],
    ['0.2.0-beta', '0.2.0-beta.1', -1], ['0.2.0-1', '0.2.0-alpha', -1], ['0.2.0-beta', '0.2.0-alpha', 1],
  ])('%s against %s is %i', (a, b, expected) => expect(compareVersions(a, b)).toBe(expected))

  it.each([['monitoring-probe-v1.5.13-r1', '0.1.8'], ['0.1.8', ''], ['0.1', '0.1.8'], ['0.1.8.1', '0.1.8'], ['01.1.8', '0.1.8'], ['latest', '0.1.8']])(
    'refuses to order %s and %s', (a, b) => expect(compareVersions(a, b)).toBeNull())
})

describe('releasedVersion', () => {
  it('accepts a published app release', () => expect(releasedVersion(released('v0.1.10'))).toBe('0.1.10'))
  it.each([
    ['draft', { tag_name: 'v9.0.0', draft: true, prerelease: false }],
    ['prerelease flag', { tag_name: 'v9.0.0', draft: false, prerelease: true }],
    ['prerelease tag', released('v9.0.0-beta.1')],
    ['probe release', released('monitoring-probe-v9.5.13-r1')],
    ['tag without v', released('9.0.0')],
    ['flags missing', { tag_name: 'v9.0.0' }],
    ['tag not a string', { tag_name: 9, draft: false, prerelease: false }],
    ['null', null],
  ])('ignores %s', (_label, record) => expect(releasedVersion(record as never)).toBeNull())
})

describe('checkForAppUpdate', () => {
  it('reminds when a newer release exists, comparing numerically', async () => {
    nativeAnswers(released('v0.1.10'), { version: '0.1.9' })
    await checkForAppUpdate()
    expect(reminderVersion(getAppUpdateSnapshot())).toBe('0.1.10')
  })

  it.each([['the same version', 'v0.1.8'], ['an older version', 'v0.1.7']])('does not remind for %s', async (_label, tag) => {
    nativeAnswers(released(tag))
    await checkForAppUpdate()
    expect(availableVersion(getAppUpdateSnapshot())).toBeNull()
    expect(getAppUpdateSnapshot().lastCheckFailed).toBe(false)
  })

  it.each([
    ['network failure', new Error('update_check_failed')],
    ['rate limit', new Error('update_check_failed')],
    ['a draft', { tag_name: 'v9.0.0', draft: true, prerelease: false }],
    ['a prerelease', { tag_name: 'v9.0.0', draft: false, prerelease: true }],
    ['a malformed answer', { message: 'API rate limit exceeded' }],
  ])('treats %s as no answer, without throwing or reminding', async (_label, answer) => {
    nativeAnswers(answer)
    await expect(checkForAppUpdate()).resolves.toBeUndefined()
    const state = getAppUpdateSnapshot()
    expect(reminderVersion(state)).toBeNull()
    expect(state.lastCheckFailed).toBe(true)
    expect(state.checking).toBe(false)
    expect(state.lastCheckedAt).toBeNull()
  })

  it('keeps the known version when a later check fails', async () => {
    nativeAnswers(released('v0.1.9'))
    await checkForAppUpdate()
    nativeAnswers(new Error('update_check_failed'))
    await checkForAppUpdate()
    expect(reminderVersion(getAppUpdateSnapshot())).toBe('0.1.9')
  })

  it('stops reminding once the app has been updated to the known version', async () => {
    nativeAnswers(released('v0.1.9'))
    await checkForAppUpdate()
    resetAppUpdateForTests()
    nativeAnswers(new Error('offline'), { version: '0.1.9' })
    await checkForAppUpdate()
    expect(reminderVersion(getAppUpdateSnapshot())).toBeNull()
  })

  it('never contacts GitHub on iOS', async () => {
    nativeAnswers(released('v9.0.0'), { platform: 'ios' })
    await checkForAppUpdate()
    expect(githubCalls()).toBe(0)
    expect(availableVersion(getAppUpdateSnapshot())).toBeNull()
  })

  it('still reminds on Android', async () => {
    nativeAnswers(released('v0.1.9'), { platform: 'android' })
    await checkForAppUpdate()
    expect(reminderVersion(getAppUpdateSnapshot())).toBe('0.1.9')
  })

  it('shares one request between overlapping checks', async () => {
    nativeAnswers(released('v0.1.9'))
    await Promise.all([checkForAppUpdate(), checkForAppUpdate()])
    expect(githubCalls()).toBe(1)
  })

  it('does nothing outside the native app', async () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    await checkForAppUpdate()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('survives malformed stored state', async () => {
    localStorage.setItem('shellbeam.updateCheck.state', '{not json')
    resetAppUpdateForTests()
    nativeAnswers(released('v0.1.9'))
    await checkForAppUpdate()
    expect(reminderVersion(getAppUpdateSnapshot())).toBe('0.1.9')
  })
})

describe('dismissal', () => {
  it('survives a restart for that version and returns for a newer one', async () => {
    nativeAnswers(released('v0.1.9'))
    await checkForAppUpdate()
    dismissAppUpdate('0.1.9')
    expect(reminderVersion(getAppUpdateSnapshot())).toBeNull()

    resetAppUpdateForTests()
    await checkForAppUpdate()
    expect(reminderVersion(getAppUpdateSnapshot())).toBeNull()
    expect(availableVersion(getAppUpdateSnapshot())).toBe('0.1.9')

    nativeAnswers(released('v0.1.10'))
    await checkForAppUpdate()
    expect(reminderVersion(getAppUpdateSnapshot())).toBe('0.1.10')
  })
})

describe('scheduling', () => {
  it('judges when a check is due', () => {
    expect(isUpdateCheckDue(null, 1000, UPDATE_CHECK_INTERVAL_MS)).toBe(true)
    expect(isUpdateCheckDue(1000, 1000 + UPDATE_STARTUP_GAP_MS - 1, UPDATE_STARTUP_GAP_MS)).toBe(false)
    expect(isUpdateCheckDue(1000, 1000 + UPDATE_STARTUP_GAP_MS, UPDATE_STARTUP_GAP_MS)).toBe(true)
    expect(isUpdateCheckDue(5000, 1000, UPDATE_CHECK_INTERVAL_MS)).toBe(true)
  })

  it('checks after startup, then on the interval, and not when turned off', async () => {
    vi.useFakeTimers()
    try {
      nativeAnswers(released('v0.1.9'))
      const stop = startAppUpdateChecks()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(githubCalls()).toBe(1)
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS / 2)
      expect(githubCalls()).toBe(1)
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
      expect(githubCalls()).toBe(2)

      setAppUpdateChecksEnabled(false)
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3)
      expect(githubCalls()).toBe(2)
      expect(reminderVersion(getAppUpdateSnapshot())).toBeNull()
      expect(localStorage.getItem('shellbeam.updateCheck.enabled')).toBe('false')
      stop()
    } finally { vi.useRealTimers() }
  })

  it('sends nothing at startup when turned off in an earlier run, yet a manual check still works', async () => {
    localStorage.setItem('shellbeam.updateCheck.enabled', 'false')
    resetAppUpdateForTests()
    nativeAnswers(released('v0.1.9'))
    vi.useFakeTimers()
    try {
      const stop = startAppUpdateChecks()
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
      expect(githubCalls()).toBe(0)
      stop()
    } finally { vi.useRealTimers() }
    await checkForAppUpdate()
    expect(githubCalls()).toBe(1)
    expect(availableVersion(getAppUpdateSnapshot())).toBe('0.1.9')
    expect(reminderVersion(getAppUpdateSnapshot())).toBeNull()
  })
})
