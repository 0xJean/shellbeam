import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceToolManagerApp, TOOL_CATALOG, buildToolActionCommand } from './workspace-tool-manager-app'

const runSshCommand = vi.fn()

vi.mock('@/lib/sessions', () => ({
  runSshCommand: (payload: unknown) => runSshCommand(payload),
}))

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 22,
  username: 'root',
  group: 'Default',
  authType: 'password' as const,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

const workerHost = {
  id: 'host-2',
  name: 'Worker Node',
  address: '10.0.0.16',
  port: 22,
  username: 'ubuntu',
  group: 'Default',
  authType: 'password' as const,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

function findTool(id: string) {
  const tool = TOOL_CATALOG.find((entry) => entry.id === id)
  if (!tool) throw new Error(`Missing tool fixture: ${id}`)
  return tool
}

describe('workspace tool manager app', () => {
  beforeEach(() => {
    localStorage.setItem('shellbeam.locale', 'en')
    runSshCommand.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('renders the broad common tool catalog', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '__SB_INSTALLED=0',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceToolManagerApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByText('Common Services & Toolchains')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-card-nginx')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-card-docker')).toBeInTheDocument()
    const logoSources = Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('src') || '')
    expect(logoSources.some((src) => src.includes('/nginx'))).toBe(true)
    expect(logoSources.some((src) => src.includes('/docker'))).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/search nginx/i), { target: { value: 'codex' } })
    expect(screen.getByTestId('workspace-tool-card-codex')).toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('img')).some((img) => img.getAttribute('src')?.includes('/openai'))).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/search nginx/i), { target: { value: 'gemini' } })
    expect(screen.getByTestId('workspace-tool-card-gemini')).toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('img')).some((img) => img.getAttribute('src')?.includes('/googlegemini'))).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/search nginx/i), { target: { value: 'claude' } })
    expect(screen.getByTestId('workspace-tool-card-claude')).toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('img')).some((img) => img.getAttribute('src')?.includes('/anthropic'))).toBe(true)

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalled()
    })
  })

  it('builds distro-aware package install commands', () => {
    const command = buildToolActionCommand(findTool('nginx'), 'install')
    expect(command).toContain('apt-get update')
    expect(command).toContain("apt-get install -y 'nginx'")
    expect(command).toContain('dnf install -y')
    expect(command).toContain('__SB_ACTION_EXIT')
  })

  it('uses service-aware icons for unbranded tools', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '__SB_INSTALLED=0',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceToolManagerApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText(/search nginx/i), { target: { value: 'cron' } })
    const cronCard = screen.getByTestId('workspace-tool-card-cron')
    expect(cronCard).toBeInTheDocument()
    expect(cronCard.querySelector('img')?.getAttribute('src')).toContain('/linux')

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalled()
    })
  })

  it('builds npm global install commands for agent CLIs', () => {
    expect(buildToolActionCommand(findTool('codex'), 'install')).toContain("npm install -g '@openai/codex'")
    expect(buildToolActionCommand(findTool('gemini'), 'install')).toContain("npm install -g '@google/gemini-cli'")
    expect(buildToolActionCommand(findTool('claude'), 'install')).toContain("npm install -g '@anthropic-ai/claude-code'")
  })

  it('builds systemd service commands for managed services', () => {
    const statusCommand = buildToolActionCommand(findTool('nginx'), 'status')
    expect(statusCommand).toContain("systemctl status 'nginx' --no-pager")

    const restartCommand = buildToolActionCommand(findTool('nginx'), 'restart')
    expect(restartCommand).toContain("sb_root systemctl restart 'nginx'")
  })

  it('runs selected tool actions on the resolved remote host', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '__SB_INSTALLED=1\n__SB_BINARY=nginx\n__SB_PATH=/usr/sbin/nginx\n__SB_VERSION=nginx version: nginx/1.24.0',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceToolManagerApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-tool-card-nginx'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^check$/i })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: /^check$/i }))

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({
        hostId: 'host-1',
        host: '10.0.0.15',
        command: expect.stringContaining('__SB_INSTALLED='),
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('workspace-tool-output')).toHaveTextContent(/nginx version/i)
    })
  })

  it('switches the managed server from the tool manager itself', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '__SB_INSTALLED=0',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceToolManagerApp
        selectedHostId="host-1"
        hosts={[host, workerHost]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByTestId('workspace-tool-host-host-1')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-host-host-2')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workspace-tool-host-host-2'))

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({
        hostId: 'host-2',
        host: '10.0.0.16',
      }))
    })
  })
})
