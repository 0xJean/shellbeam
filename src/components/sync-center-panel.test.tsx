import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SyncCenterPanel } from './sync-center-panel'

vi.mock('@/lib/i18n', () => ({ useT: () => ({ t: (key: string) => key, locale: 'zh-CN' }) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@/lib/mdns', () => ({
  mdnsStartDiscover: vi.fn(async () => {}),
  mdnsStopDiscover: vi.fn(async () => {}),
  onMdnsDeviceFound: vi.fn(() => () => {}),
  getAndroidDeviceName: () => null,
}))
vi.mock('@/lib/sync', () => ({
  getSystemHostname: vi.fn(async () => 'studio'),
  syncSendPairRequest: vi.fn(),
  syncAcceptPair: vi.fn(),
}))

const base = {
  changes: [], cursors: [], loading: false, serverRunning: true, serverPort: 9123,
  onRefresh: vi.fn(async () => {}), onInitDevice: vi.fn(async () => {}), onStartServer: vi.fn(async () => {}),
  onPullFromPeer: vi.fn(async () => {}), onPushToPeer: vi.fn(async () => {}), onRemoveTrustedPeer: vi.fn(async () => {}),
}
const localDevice = { deviceId: 'dev-1', deviceName: 'MacBook', publicKey: 'pk', createdAt: 1, lastSeenAt: 1 }
const peer = { peerDeviceId: 'peer-1', peerDeviceName: 'iPhone', verifiedAt: 1, lastSeenAt: 1, source: 'pair', peerEndpoint: '192.168.1.2:9123' }

describe('SyncCenterPanel (merged sync & backup page)', () => {
  it('renders device sync beside the backup column', () => {
    render(<SyncCenterPanel {...base} localDevice={localDevice} trustedPeers={[peer]} backupPanel={<div>backup-column</div>} />)
    expect(screen.getByRole('heading', { name: '同步与备份' })).toBeInTheDocument()
    expect(screen.getByText('服务运行中 · :9123')).toBeInTheDocument()
    expect(screen.getByText('backup-column')).toBeInTheDocument()
    expect(screen.getByText('可信设备 · 1')).toBeInTheDocument()
  })

  it('keeps backup reachable before the device is initialized', () => {
    render(<SyncCenterPanel {...base} localDevice={null} trustedPeers={[]} backupPanel={<div>backup-column</div>} />)
    expect(screen.getByText('sync.initDevice')).toBeInTheDocument()
    expect(screen.getByText('backup-column')).toBeInTheDocument()
  })

  it('opens peer detail and returns to the backup column when focus moves to backup', () => {
    const { rerender } = render(<SyncCenterPanel {...base} localDevice={localDevice} trustedPeers={[peer]} backupPanel={<div>backup-column</div>} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 iPhone' }))
    expect(screen.getByText('可信设备详情')).toBeInTheDocument()
    expect(screen.queryByText('backup-column')).not.toBeInTheDocument()
    rerender(<SyncCenterPanel {...base} localDevice={localDevice} trustedPeers={[peer]} backupPanel={<div>backup-column</div>} focusSection="backup" />)
    expect(screen.getByText('backup-column')).toBeInTheDocument()
  })

  it('names the active vault beside the peer sync actions', () => {
    render(<SyncCenterPanel {...base} localDevice={localDevice} trustedPeers={[peer]} syncVaultName="Work" />)
    fireEvent.click(screen.getByRole('button', { name: '打开 iPhone' }))
    expect(screen.getByText('同步保管库：Work')).toBeInTheDocument()
  })
})
