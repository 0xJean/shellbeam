import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SftpConnectPlaceholder } from './sftp-connect-placeholder'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'sftpConnect.connecting' ? `Connecting to ${params?.host}` : key,
  }),
}))

describe('sftp connect placeholder', () => {
  it('renders a richer loading skeleton while connecting', () => {
    render(
      <SftpConnectPlaceholder
        loading
        hostName="Production API"
        hostAddress="10.0.0.15"
        hostPort={22}
        hasHost
        onConnect={() => {}}
      />,
    )

    expect(screen.getByTestId('sftp-connect-skeleton')).toBeInTheDocument()
    expect(screen.getAllByTestId('sftp-connect-step-skeleton')).toHaveLength(3)
    expect(screen.getByText('Connecting to Production API')).toBeInTheDocument()
  })
})
