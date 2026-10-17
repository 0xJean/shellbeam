import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getSystemNotificationPermission, requestSystemNotificationPermission, sendSystemNotification } from './system-notifications'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)
const mockedIsTauri = vi.mocked(isTauri)

function mockBrowser(permission: NotificationPermission = 'granted') {
  const constructor = vi.fn(function () {})
  const requestPermission = vi.fn().mockResolvedValue('granted')
  Object.assign(constructor, { permission, requestPermission })
  vi.stubGlobal('Notification', constructor)
  return { constructor, requestPermission }
}

describe('native system notification adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedIsTauri.mockReturnValue(true)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads and requests native permission without relying on a browser API', async () => {
    vi.stubGlobal('Notification', undefined)
    mockedInvoke.mockResolvedValueOnce('default').mockResolvedValueOnce('granted')
    expect(await getSystemNotificationPermission()).toBe('default')
    expect(await requestSystemNotificationPermission()).toBe('granted')
    expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual([
      'system_notification_permission', 'request_system_notification_permission',
    ])
  })

  it('awaits native acceptance and sends only bounded text', async () => {
    const { constructor } = mockBrowser()
    let accept!: () => void
    mockedInvoke.mockResolvedValueOnce('granted').mockImplementationOnce(() => new Promise<void>((resolve) => { accept = resolve }))
    const completed = vi.fn()
    const sending = sendSystemNotification({ title: ' Probe\nrecovered ', body: 'a'.repeat(400) }).then(completed)
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('send_system_notification', { title: 'Probe recovered', body: 'a'.repeat(240) }))
    expect(completed).not.toHaveBeenCalled()
    expect(constructor).not.toHaveBeenCalled()
    accept()
    await sending
    expect(completed).toHaveBeenCalledOnce()
  })

  it.each([
    ['default', 'system-permission-required'],
    ['denied', 'system-permission-denied'],
    ['unavailable', 'system-unavailable'],
  ])('does not prompt or send when permission is %s', async (permission, code) => {
    mockedInvoke.mockResolvedValueOnce(permission)
    await expect(sendSystemNotification({ title: 'Probe', body: 'Offline' })).rejects.toMatchObject({ code })
    expect(mockedInvoke).toHaveBeenCalledExactlyOnceWith('system_notification_permission')
  })

  it('does not fall back to browser notifications when the native bridge fails', async () => {
    const { constructor } = mockBrowser()
    mockedInvoke.mockRejectedValue(new Error('private native platform details'))
    expect(await getSystemNotificationPermission()).toBe('unavailable')
    expect(await requestSystemNotificationPermission()).toBe('unavailable')
    await expect(sendSystemNotification({ title: 'Probe', body: 'Offline' })).rejects.toMatchObject({ code: 'system-unavailable' })
    expect(constructor).not.toHaveBeenCalled()
  })

  it('rethrows only safe error codes when native delivery is rejected', async () => {
    mockedInvoke.mockResolvedValueOnce('granted').mockRejectedValueOnce('token=private-secret')
    await expect(sendSystemNotification({ title: 'Probe', body: 'Offline' })).rejects.toMatchObject({ message: 'system-send-failed', code: 'system-send-failed' })
    mockedInvoke.mockResolvedValueOnce('granted').mockRejectedValueOnce('system-permission-denied')
    await expect(sendSystemNotification({ title: 'Probe', body: 'Offline' })).rejects.toMatchObject({ code: 'system-permission-denied' })
  })

  it('rejects empty content before sending', async () => {
    mockedInvoke.mockResolvedValueOnce('granted')
    await expect(sendSystemNotification({ title: '\n', body: 'Offline' })).rejects.toMatchObject({ code: 'system-send-failed' })
    expect(mockedInvoke).toHaveBeenCalledOnce()
  })
})

describe('browser-only notification fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedIsTauri.mockReturnValue(false)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uses the browser sink after permission was granted', async () => {
    const { constructor, requestPermission } = mockBrowser()
    await sendSystemNotification({ title: 'Probe recovered', body: 'Ready' })
    expect(constructor).toHaveBeenCalledWith('Probe recovered', { body: 'Ready' })
    expect(requestPermission).not.toHaveBeenCalled()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('requests browser permission only through an explicit permission action', async () => {
    const { constructor, requestPermission } = mockBrowser('default')
    await expect(sendSystemNotification({ title: 'Probe', body: 'Offline' })).rejects.toMatchObject({ code: 'system-permission-required' })
    expect(requestPermission).not.toHaveBeenCalled()
    expect(constructor).not.toHaveBeenCalled()
    expect(await requestSystemNotificationPermission()).toBe('granted')
    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it('reports unavailable APIs and permission errors without leaking details', async () => {
    vi.stubGlobal('Notification', undefined)
    expect(await getSystemNotificationPermission()).toBe('unavailable')
    expect(await requestSystemNotificationPermission()).toBe('unavailable')
    const { requestPermission } = mockBrowser('default')
    requestPermission.mockRejectedValueOnce(new Error('private browser diagnostic'))
    expect(await requestSystemNotificationPermission()).toBe('unavailable')
  })

  it('turns browser constructor errors into a safe delivery failure', async () => {
    const { constructor } = mockBrowser()
    constructor.mockImplementationOnce(() => { throw new Error('private browser diagnostic') })
    await expect(sendSystemNotification({ title: 'Probe', body: 'Offline' })).rejects.toMatchObject({ code: 'system-send-failed' })
  })
})
