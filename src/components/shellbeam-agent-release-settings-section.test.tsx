import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY } from '@/lib/shellbeam-agent-release-settings'
import { ShellbeamAgentReleaseSettingsSection } from './shellbeam-agent-release-settings-section'

describe('ShellBeam Agent release settings', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
  })
  afterEach(cleanup)

  it('keeps preview disabled until the channel is allowed and saves a redacted policy', () => {
    render(<ShellbeamAgentReleaseSettingsSection />)
    expect(screen.getByTestId('agent-release-settings')).toBeInTheDocument()
    const previewOptIn = screen.getByLabelText('Opt in to preview and canary releases')
    expect(previewOptIn).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Preview'))
    expect(previewOptIn).not.toBeDisabled()
    fireEvent.click(previewOptIn)
    fireEvent.click(screen.getByRole('button', { name: 'Save release policy' }))

    expect(screen.getByRole('status')).toHaveTextContent('Release policy saved')
    const stored = localStorage.getItem(SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY)
    expect(stored).toContain('preview')
    expect(stored).not.toContain('api-key')
    expect(stored).not.toContain('credential')
  })

  it('does not permit removing the final channel and keeps signatures mandatory', () => {
    render(<ShellbeamAgentReleaseSettingsSection />)
    const stable = screen.getByLabelText('Stable') as HTMLInputElement
    expect(stable).toBeChecked()
    fireEvent.click(stable)
    expect(stable).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Save release policy' }))
    const stored = JSON.parse(localStorage.getItem(SHELLBEAM_AGENT_RELEASE_SETTINGS_KEY) ?? '{}') as { requireReleaseSignature?: boolean }
    expect(stored.requireReleaseSignature).toBe(true)
  })
})
