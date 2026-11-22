import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostNetworkDiagnosticsCard } from './host-network-diagnostics'
import type { HostProfile } from '@/lib/hosts'

vi.mock('@/lib/workspace-remote', () => ({
  runWorkspaceRemoteCommand: vi.fn(async () => ({
    exitCode: 0,
    stdout: [
      '__SB_DIAG_SCHEMA=1',
      '__SB_DIAG_IP_BEGIN',
      '{"ip":"198.51.100.7","city":"Singapore","country":"SG","org":"AS13335 Cloudflare"}',
      'IPV6=',
      '__SB_DIAG_IP_END',
      '__SB_DIAG_PROBES_BEGIN',
      'PROBE|cloudflare|Cloudflare|1.1.1.1|0|1.1|1.4|1.9',
      '__SB_DIAG_PROBES_END',
      '__SB_DIAG_SVC_BEGIN',
      'SVC|openai|OpenAI API|401|0.120',
      'SVC|netflix|Netflix|403|0.200',
      '__SB_DIAG_SVC_END',
    ].join('\n'),
    stderr: '',
  })),
}))

const sampleHost: HostProfile = {
  id: 'h1',
  name: 'SG Edge',
  address: '198.51.100.7',
  port: 22,
  username: 'root',
  group: 'Production',
  authType: 'privateKey',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}

describe('HostNetworkDiagnosticsCard', () => {
  it('runs on-demand diagnostics and renders exit IP, latency, and service reachability', async () => {
    render(
      <HostNetworkDiagnosticsCard
        host={sampleHost}
        resolveAuthSecret={vi.fn(async () => 'secret')}
      />,
    )

    fireEvent.click(screen.getByTestId('host-network-diag-run'))

    await waitFor(() => {
      expect(screen.getByText('198.51.100.7')).toBeInTheDocument()
    })
    expect(screen.getByTestId('diag-probe-cloudflare')).toHaveTextContent('1.4 ms')
    expect(screen.getByTestId('diag-svc-openai')).toHaveTextContent('120ms')
    expect(screen.getByTestId('diag-svc-netflix')).toBeInTheDocument()
  })
})
