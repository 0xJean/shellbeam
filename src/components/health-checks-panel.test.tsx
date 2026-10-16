import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { HealthChecksPanel } from './health-checks-panel'

const host: HostProfile = {
  id: 'host-1', name: 'edge', address: '10.0.0.8', port: 2222, username: 'ops', group: 'Production', tags: [], authType: 'privateKey', privateKeyRef: 'key', jumpHost: 'bastion', jumpPort: 22, jumpUser: 'jump', createdAt: 1, updatedAt: 1,
}

describe('HealthChecksPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
  })

  it('loads a safe SSH check and exposes the ProxyJump-aware run surface', () => {
    render(<I18nProvider><HealthChecksPanel host={host} resolveAuthSecret={vi.fn()} /></I18nProvider>)
    expect(screen.getByTestId('health-checks-panel')).toBeInTheDocument()
    expect(screen.getByText('SSH port')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run checks' })).toBeInTheDocument()
  })
})
