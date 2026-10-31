import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { AppUpdateReminder, AppUpdateSettingsSection } from './app-update'
import { checkForAppUpdate, resetAppUpdateForTests } from '@/lib/app-update'
import { I18nProvider } from '@/lib/i18n'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }))
const invokeMock = vi.mocked(invoke)

function nativeAnswers(release: unknown, platform = 'macos') {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'app_update_info') return { version: '0.1.8', platform }
    if (command === 'check_latest_app_release') {
      if (release instanceof Error) throw release
      return release
    }
    return undefined
  })
}
const released = (tag: string) => ({ tag_name: tag, draft: false, prerelease: false })
const ui = (node: React.ReactNode) => render(<I18nProvider>{node}</I18nProvider>)

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('shellbeam.locale', 'en')
  invokeMock.mockReset()
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  resetAppUpdateForTests()
})

describe('AppUpdateReminder', () => {
  it('shows nothing without a newer version', async () => {
    nativeAnswers(released('v0.1.8'))
    ui(<AppUpdateReminder />)
    await act(() => checkForAppUpdate())
    expect(screen.queryByTestId('app-update-reminder')).toBeNull()
  })

  it('opens the release page by version and hides once dismissed', async () => {
    nativeAnswers(released('v0.1.10'))
    ui(<AppUpdateReminder />)
    await act(() => checkForAppUpdate())
    expect(screen.getByTestId('app-update-reminder')).toHaveTextContent('ShellBeam 0.1.10 is available')
    fireEvent.click(screen.getByTestId('app-update-view'))
    expect(invokeMock).toHaveBeenCalledWith('open_app_release_page', { version: '0.1.10' })
    fireEvent.click(screen.getByTestId('app-update-dismiss'))
    expect(screen.queryByTestId('app-update-reminder')).toBeNull()
    expect(JSON.parse(localStorage.getItem('shellbeam.updateCheck.state')!).dismissedVersion).toBe('0.1.10')
  })

  it('reads in Chinese', async () => {
    localStorage.setItem('shellbeam.locale', 'zh-CN')
    nativeAnswers(released('v0.1.10'))
    ui(<AppUpdateReminder />)
    await act(() => checkForAppUpdate())
    expect(screen.getByTestId('app-update-reminder')).toHaveTextContent('ShellBeam 0.1.10 已发布')
    expect(screen.getByLabelText('忽略此版本')).toBeInTheDocument()
  })
})

describe('AppUpdateSettingsSection', () => {
  it('reports a manual check, including a failure, without an error surface', async () => {
    nativeAnswers(new Error('update_check_failed'))
    ui(<AppUpdateSettingsSection />)
    await screen.findByTestId('app-update-settings')
    expect(screen.getByTestId('app-update-status')).toHaveTextContent('Not checked yet.')
    fireEvent.click(screen.getByTestId('app-update-check'))
    await waitFor(() => expect(screen.getByTestId('app-update-status')).toHaveTextContent('Could not check right now.'))

    nativeAnswers(released('v0.1.8'))
    fireEvent.click(screen.getByTestId('app-update-check'))
    await waitFor(() => expect(screen.getByTestId('app-update-status')).toHaveTextContent('You are on the latest version.'))
  })

  it('says a manual check failed even when a newer version is already known', async () => {
    nativeAnswers(released('v0.1.9'))
    ui(<AppUpdateSettingsSection />)
    await act(() => checkForAppUpdate())
    nativeAnswers(new Error('update_check_failed'))
    fireEvent.click(screen.getByTestId('app-update-check'))
    await waitFor(() => expect(screen.getByTestId('app-update-status')).toHaveTextContent('ShellBeam 0.1.9 is available Could not check right now.'))
    expect(screen.getByTestId('app-update-settings-view')).toBeInTheDocument()
  })

  it('still offers a dismissed version here', async () => {
    nativeAnswers(released('v0.1.9'))
    ui(<><AppUpdateReminder /><AppUpdateSettingsSection /></>)
    await act(() => checkForAppUpdate())
    fireEvent.click(screen.getByTestId('app-update-dismiss'))
    expect(screen.getByTestId('app-update-settings-view')).toBeInTheDocument()
  })

  it('remembers turning automatic checks off and says what a check sends', async () => {
    nativeAnswers(released('v0.1.8'))
    ui(<AppUpdateSettingsSection />)
    fireEvent.click(await screen.findByTestId('app-update-auto-check'))
    expect(localStorage.getItem('shellbeam.updateCheck.enabled')).toBe('false')
    expect(screen.getByText(/GitHub sees your IP address/)).toBeInTheDocument()
  })

  it('offers no check on iOS', async () => {
    nativeAnswers(released('v9.0.0'), 'ios')
    ui(<AppUpdateSettingsSection />)
    expect(await screen.findByText(/arrive through TestFlight/)).toBeInTheDocument()
    expect(screen.queryByTestId('app-update-check')).toBeNull()
    expect(screen.queryByTestId('app-update-auto-check')).toBeNull()
  })
})
