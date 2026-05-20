import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWorkspaceInventoryCache, parseWorkspaceInventory, saveWorkspaceInventoryCacheEntry } from '@/lib/workspace-inventory'
import { WorkspaceAssetInventoryApp } from './workspace-asset-inventory-app'

const runSshCommand = vi.fn()

vi.mock('@/lib/sessions', () => ({
  runSshCommand: (payload: unknown) => runSshCommand(payload),
}))

const hosts = [
  {
    id: 'host-1',
    name: 'Production API',
    address: '10.0.0.15',
    port: 22,
    username: 'root',
    group: 'Production',
    authType: 'password' as const,
    tags: ['api'],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'host-2',
    name: 'Worker Node',
    address: '10.0.0.16',
    port: 22,
    username: 'ubuntu',
    group: 'Development',
    authType: 'password' as const,
    tags: ['worker'],
    createdAt: 0,
    updatedAt: 0,
  },
]

function inventoryOutput(hostname: string) {
  return `
__SB_HOSTNAME=${hostname}
__SB_OS=Ubuntu 24.04 LTS
__SB_KERNEL=Linux 6.8
__SB_UPTIME=3 days
__SB_CPU=18
__SB_MEMORY=64|1280M/2000M
__SB_DISK=71|36G/50G
__SB_NETWORK=12.5 KB/s
__SB_TOOL=nginx|Nginx|web|nginx|/usr/sbin/nginx|nginx version: nginx/1.24.0
__SB_TOOL=node|Node.js|runtime|node|/usr/bin/node|v22.1.0
__SB_SERVICE=nginx|active|enabled
__SB_DOCKER=api|ghcr.io/acme/api:latest|Up 2 hours|0.0.0.0:3000->3000/tcp
__SB_PROJECT=/var/www/acme|node|acme|2026-05-15 10:20
`
}

function inventoryOutputWithoutNginxTool(hostname: string) {
  return `
__SB_HOSTNAME=${hostname}
__SB_OS=Ubuntu 24.04 LTS
__SB_KERNEL=Linux 6.8
__SB_UPTIME=3 days
__SB_CPU=18
__SB_MEMORY=64|1280M/2000M
__SB_DISK=71|36G/50G
__SB_NETWORK=12.5 KB/s
__SB_TOOL=node|Node.js|runtime|node|/usr/bin/node|v22.1.0
__SB_SERVICE=nginx|inactive|disabled
__SB_PROJECT=/srv/worker|node|worker|2026-05-15 10:20
`
}

describe('workspace asset inventory app', () => {
  beforeEach(() => {
    localStorage.setItem('shellbeam.locale', 'zh-CN')
    runSshCommand.mockReset()
    clearWorkspaceInventoryCache()
    runSshCommand.mockImplementation(({ host }: { host: string }) => Promise.resolve({
      stdout: inventoryOutput(host),
      stderr: '',
      exitCode: 0,
      durationMs: 25,
    }))
  })

  it('scans all hosts and renders fleet resources and project placement', async () => {
    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hostAddress="10.0.0.15"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByTestId('workspace-asset-inventory-app')).toBeInTheDocument()

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    expect((await screen.findAllByText('资源总览')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Production API').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Worker Node').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Nginx').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Node.js').length).toBeGreaterThan(0)
    expect(screen.getByText('组件状态')).toBeInTheDocument()
    expect(screen.getAllByText('active').length).toBeGreaterThan(0)
    expect(screen.getByText('/var/www/acme')).toBeInTheDocument()
  })

  it('filters hosts by installed tool and project path', async () => {
    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    fireEvent.change(screen.getByPlaceholderText(/搜索主机/), { target: { value: 'acme' } })
    expect(screen.getAllByText('Production API').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Worker Node').length).toBeGreaterThan(0)

    fireEvent.change(screen.getByPlaceholderText(/搜索主机/), { target: { value: 'missing-service' } })
    expect(screen.getByText('没有匹配的 VPS 资产。')).toBeInTheDocument()
  })

  it('filters and sorts hosts from the VPS asset header controls', async () => {
    const datedHosts = [
      { ...hosts[0], updatedAt: 10 },
      { ...hosts[1], updatedAt: 20 },
    ]

    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={datedHosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    expect(screen.getByText('全部主机')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生产环境 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开发环境 1' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^标签/ }))
    fireEvent.click(screen.getByRole('button', { name: 'api' }))

    expect(screen.getByText('1/2 台匹配')).toBeInTheDocument()
    expect(screen.getAllByText('Production API').length).toBeGreaterThan(0)
    expect(screen.queryByText('Worker Node')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '清除标签筛选' }))

    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.click(screen.getByRole('button', { name: '开发环境' }))
    expect(screen.getByText('1/2 台匹配')).toBeInTheDocument()
    expect(screen.getAllByText('Worker Node').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Worker Node').length).toBeGreaterThan(0)
  })

  it('filters the shared server list by installed tools without matching service candidates', async () => {
    runSshCommand.mockImplementation(({ host }: { host: string }) => Promise.resolve({
      stdout: host === '10.0.0.15' ? inventoryOutput(host) : inventoryOutputWithoutNginxTool(host),
      stderr: '',
      exitCode: 0,
      durationMs: 25,
    }))

    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    fireEvent.change(screen.getByPlaceholderText(/搜索服务器/), { target: { value: 'nginx' } })

    expect(screen.getByText('1/2 台匹配')).toBeInTheDocument()
    expect(screen.getAllByText('Production API').length).toBeGreaterThan(0)
    expect(screen.queryByText('Worker Node')).not.toBeInTheDocument()
  })

  it('switches project deployments inside the VPS assets view', async () => {
    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    fireEvent.click(screen.getByRole('tab', { name: '部署项目' }))

    expect(screen.getByTestId('project-deployments-panel')).toBeInTheDocument()
  })

  it('shows tool manager as the second VPS assets tab', async () => {
    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    const tabButtons = screen.getAllByRole('tab')
    expect(tabButtons.map((button) => button.textContent)).toEqual(['资源总览', '工具管理', '部署项目'])

    fireEvent.click(screen.getByRole('tab', { name: '工具管理' }))

    expect(screen.getByTestId('workspace-tool-manager-app')).toBeInTheDocument()
  })

  it('opens tool manager from component status for the currently selected server', async () => {
    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    fireEvent.click(screen.getByText('Worker Node'))
    fireEvent.click(screen.getByRole('button', { name: '管理当前服务器工具' }))

    expect(screen.getByTestId('workspace-tool-manager-app')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-manager-app')).toHaveAttribute('data-selected-host-id', 'host-2')
  })

  it('keeps a single shared server list when switching VPS asset tabs', async () => {
    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText(/搜索服务器/)).toHaveLength(1)
    })

    fireEvent.click(screen.getByText('Worker Node'))
    fireEvent.click(screen.getByRole('tab', { name: '工具管理' }))

    expect(screen.getAllByPlaceholderText(/搜索服务器/)).toHaveLength(1)
    expect(screen.getByTestId('workspace-tool-manager-app')).toHaveAttribute('data-selected-host-id', 'host-2')

    fireEvent.click(screen.getByRole('tab', { name: '部署项目' }))

    expect(screen.getAllByPlaceholderText(/搜索服务器/)).toHaveLength(1)
    expect(screen.getByTestId('project-deployments-panel')).toHaveAttribute('data-selected-host-key', 'host-2')
  })

  it('opens the terminal from the selected server detail actions', async () => {
    const onOpenTerminal = vi.fn()

    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
        onOpenTerminal={onOpenTerminal}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    fireEvent.click(screen.getByRole('button', { name: '终端' }))

    expect(onOpenTerminal).toHaveBeenCalledWith(hosts[0])
  })

  it('opens host editing from the selected server detail actions', async () => {
    const onEditHost = vi.fn()

    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
        onEditHost={onEditHost}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    expect(onEditHost).toHaveBeenCalledWith(hosts[0])
  })

  it('shows a provider console link for recognized VPS hosts', async () => {
    const onOpenProviderConsole = vi.fn()
    const contaboHost = { ...hosts[0], tags: ['Contabo'] }

    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={[contaboHost]}
        resolveAuthSecret={async () => 'secret'}
        onOpenProviderConsole={onOpenProviderConsole}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(1)
    })

    const button = screen.getByRole('button', { name: '打开 Contabo 控制台' })

    fireEvent.click(button)

    expect(onOpenProviderConsole).toHaveBeenCalledWith('https://my.contabo.com/account/login', contaboHost)
  })

  it('marks hosts as inaccessible when the scan cannot connect', async () => {
    runSshCommand.mockImplementation(({ host }: { host: string }) => {
      if (host === '10.0.0.16') return Promise.resolve({
        stdout: '',
        stderr: 'TCP connect failed: timed out',
        exitCode: -1,
        durationMs: 15000,
        errorType: 'network',
        errorCode: 'network_error',
        errorSource: 'ssh',
        retryable: true,
      })
      return Promise.resolve({
        stdout: inventoryOutput(host),
        stderr: '',
        exitCode: 0,
        durationMs: 25,
      })
    })

    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={hosts}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(2)
    })
    expect(screen.getAllByText('无法访问').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('Worker Node'))
    expect(screen.queryByText(/TCP connect failed: timed out/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '工具管理' }))
    expect(screen.getByTestId('workspace-tool-manager-app')).toBeInTheDocument()
    expect(screen.getAllByText('无法访问').length).toBeGreaterThan(0)
  })

  it('hydrates previous scan results from cache before the background scan finishes', async () => {
    const scanController: { resolve?: (value: unknown) => void } = {}
    runSshCommand.mockImplementation(() => new Promise((resolve) => {
      scanController.resolve = resolve
    }))
    await saveWorkspaceInventoryCacheEntry(hosts[0], parseWorkspaceInventory(`
__SB_HOSTNAME=cached-vps
__SB_CPU=42
__SB_MEMORY=55|550M/1000M
__SB_DISK=66|33G/50G
__SB_TOOL=redis|Redis|cache|redis-server|/usr/bin/redis-server|Redis server v=7.2
__SB_PROJECT=/srv/cached-app|node|cached-app|2026-05-15 09:00
`))

    render(
      <WorkspaceAssetInventoryApp
        selectedHostId="host-1"
        hosts={[hosts[0]]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getAllByText('Redis').length).toBeGreaterThan(0)
    expect(screen.getByText('/srv/cached-app')).toBeInTheDocument()
    expect(screen.getByText(/已先显示 1 台 VPS 的本地缓存/)).toBeInTheDocument()
    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledTimes(1)
    })

    scanController.resolve?.({
      stdout: inventoryOutput('fresh-vps'),
      stderr: '',
      exitCode: 0,
      durationMs: 20,
    })

    await waitFor(() => {
      expect(screen.getByText('Nginx')).toBeInTheDocument()
    })
  })
})
