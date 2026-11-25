import { describe, expect, it } from 'vitest'
import { buildPairingQrPayload, describeCompanionError, parsePairingQrPayload } from './companion'

describe('companion pairing QR payload', () => {
  it('encodes LAN and Tailscale routes without secrets and round-trips cleanly', () => {
    const payload = buildPairingQrPayload({
      routes: [
        { kind: 'lan', host: '192.168.1.42', port: 9123 },
        { kind: 'tailnet', host: '100.88.12.5', port: 9123 },
        { kind: 'tailnet', host: 'macbook.tailnet.ts.net', port: 9123 },
        { kind: 'iroh', host: 'a'.repeat(64), port: 1, label: 'https://aps1-1.relay.n0.iroh-canary.iroh.link./' },
      ],
      port: 9123,
      deviceName: 'MacBook Pro',
    })
    expect(payload).toMatch(/^shellbeam:\/\/pair\?/)
    expect(payload).not.toContain('token')
    expect(payload).not.toContain('secret')

    const parsed = parsePairingQrPayload(payload)
    expect(parsed).toEqual({
      hosts: ['192.168.1.42', '100.88.12.5', 'macbook.tailnet.ts.net'],
      port: 9123,
      deviceName: 'MacBook Pro',
      irohId: 'a'.repeat(64),
      relayUrl: 'https://aps1-1.relay.n0.iroh-canary.iroh.link./',
    })
  })

  it('parses direct Tailscale IP, host:port, and MagicDNS inputs', () => {
    expect(parsePairingQrPayload('100.88.12.5:9123')).toEqual({
      hosts: ['100.88.12.5'],
      port: 9123,
    })
    expect(parsePairingQrPayload('macbook.tailnet.ts.net')).toEqual({
      hosts: ['macbook.tailnet.ts.net'],
      port: 9123,
    })
    expect(parsePairingQrPayload('[::1]:9124')).toEqual({
      hosts: ['::1'],
      port: 9124,
    })
    expect(parsePairingQrPayload('')).toBeNull()
    expect(parsePairingQrPayload('shellbeam://pair?port=9123')).toBeNull()
  })

  it('localizes companion bridge errors in zh-CN and en and flags repair-needed errors', () => {
    const raw = 'Operation failed: This device is not paired or is using an older pairing. Update both devices and pair them again.'
    const zh = describeCompanionError(raw, 'zh-CN')
    expect(zh.needsRepair).toBe(true)
    expect(zh.message).toContain('旧版本')
    expect(zh.message).not.toContain('Operation failed')

    const en = describeCompanionError(raw, 'en')
    expect(en.needsRepair).toBe(true)
    expect(en.message).toContain('older version')
    expect(en.message).not.toContain('Operation failed')

    const refused = describeCompanionError('192.168.3.35:9123 (lan) — Connect 192.168.3.35:9123 failed: Connection refused (os error 111)', 'zh-CN')
    expect(refused.needsRepair).toBe(false)
    expect(refused.message).toContain('连接被拒绝')
  })
})
