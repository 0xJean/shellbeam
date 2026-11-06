import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { I18nProvider } from '@/lib/i18n'
import { SshAuthPromptRuntime, type SshAuthPrompt } from './ssh-auth-prompt-dialog'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}), isTauri: () => true }))
const handlers = new Map<string, (event: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { handlers.set(name, handler); return () => handlers.delete(name) }),
}))

const prompt = (overrides: Partial<SshAuthPrompt> = {}): SshAuthPrompt => ({
  id: 'p1', sessionId: 's1', stage: 'target', host: 'db.internal', port: 22, username: 'root',
  instruction: '<b>Use your authenticator</b>', prompts: [{ text: 'Verification code:', echo: true }], ...overrides,
})
const open = async (value: SshAuthPrompt) => { await act(async () => { handlers.get('ssh-auth-prompt')!({ payload: value }) }) }

beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en'); vi.clearAllMocks(); handlers.clear() })
afterEach(() => { cleanup(); localStorage.clear() })

describe('SSH sign-in questions', () => {
  it('shows the server’s question as plain text and sends the answer', async () => {
    render(<I18nProvider><SshAuthPromptRuntime /></I18nProvider>)
    await act(async () => {})
    expect(listen).toHaveBeenCalledWith('ssh-auth-prompt', expect.any(Function))
    await open(prompt())
    expect(screen.getByText('root@db.internal')).toBeInTheDocument()
    expect(screen.getByText('<b>Use your authenticator</b>')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Verification code:'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(invoke).toHaveBeenCalledWith('ssh_auth_prompt_respond', { payload: { id: 'p1', answers: ['123456'] } })
    expect(screen.queryByTestId('ssh-auth-prompt')).not.toBeInTheDocument()
  })

  it('hides secret answers, cancels on dismiss and drops a question the server stopped waiting for', async () => {
    render(<I18nProvider><SshAuthPromptRuntime /></I18nProvider>)
    await act(async () => {})
    await open(prompt({ id: 'p2', stage: 'jump', port: 2222, prompts: [{ text: 'Password:', echo: false }] }))
    expect(screen.getByLabelText('Password:')).toHaveAttribute('type', 'password')
    expect(screen.getByText(/jump host/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(invoke).toHaveBeenCalledWith('ssh_auth_prompt_respond', { payload: { id: 'p2', answers: null } })

    await open(prompt({ id: 'p3' }))
    expect(screen.getByTestId('ssh-auth-prompt')).toBeInTheDocument()
    await act(async () => { handlers.get('ssh-auth-prompt-closed')!({ payload: { id: 'p3' } }) })
    expect(screen.queryByTestId('ssh-auth-prompt')).not.toBeInTheDocument()
  })
})
