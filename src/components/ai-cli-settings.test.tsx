import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { checkAICli } from '@/lib/ai-cli'
import { AISettingsSection } from './ai-settings-section'
import { DEFAULT_AI_SETTINGS, loadAISettings, saveAISettings } from '@/lib/ai'
import en from '@/lib/locales/en'
import zhCN from '@/lib/locales/zh-CN'
vi.mock('@/lib/ai-cli', () => ({ checkAICli: vi.fn(), cliErrorMessage: () => 'CLI unavailable', streamCliCommand: vi.fn() }))
beforeEach(() => { localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en'); vi.clearAllMocks() })
afterEach(cleanup)
describe('AI CLI settings', () => {
  it('keeps API and each CLI profile separate across switches and reloads', () => {
    saveAISettings({ ...DEFAULT_AI_SETTINGS, apiKey: 'saved-key', model: 'saved-model' })
    render(<AISettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh models' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('CLI executable path (optional)'), { target: { value: '/custom/claude' } })
    fireEvent.change(screen.getByLabelText('CLI model (optional)'), { target: { value: 'sonnet' } })
    fireEvent.click(screen.getByRole('button', { name: 'Codex CLI' }))
    expect(screen.getByLabelText('CLI model (optional)')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('CLI model (optional)'), { target: { value: 'gpt-example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
    expect(screen.getByLabelText('CLI model (optional)')).toHaveValue('sonnet')
    fireEvent.click(screen.getByRole('button', { name: 'Model API' }))
    expect(screen.getByLabelText('API Key')).toHaveValue('saved-key')
    expect(screen.getByLabelText('Model')).toHaveValue('saved-model')
    expect(loadAISettings().cliProfiles?.['codex-cli']?.model).toBe('gpt-example')
    expect(checkAICli).not.toHaveBeenCalled()
  })
  it('checks only on click and discards results for an edited path or switched backend', async () => {
    let resolve!: (v: { executable: string; version: string }) => void
    vi.mocked(checkAICli).mockImplementation(() => new Promise((done) => { resolve = done }))
    saveAISettings({ ...DEFAULT_AI_SETTINGS, backend: 'codex-cli' }); render(<AISettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Check CLI' }))
    expect(checkAICli).toHaveBeenCalledExactlyOnceWith('codex-cli', '')
    fireEvent.change(screen.getByLabelText('CLI executable path (optional)'), { target: { value: '/new/codex' } })
    await act(async () => resolve({ executable: '/old/codex', version: '0.160.1' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check CLI' }))
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
    await act(async () => resolve({ executable: '/new/codex', version: '0.160.1' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('provides every CLI status/error in Chinese and English', () => {
    for (const key of Object.keys(en).filter((k) => k.startsWith('ai.cli.') || k.startsWith('ai.backend'))) expect(zhCN[key]).toBeTruthy()
  })
})
