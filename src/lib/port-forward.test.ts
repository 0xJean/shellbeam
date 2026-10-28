import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { addPortForwardRule, PORT_FORWARD_FLAGS, toPortForwardRuleDraft } from './port-forward'

describe('port forward drafts', () => {
  beforeEach(() => invoke.mockReset())

  it('keeps dynamic (-D) rules dynamic instead of saving them as local forwards', () => {
    expect(toPortForwardRuleDraft({ hostId: 'h', name: ' SOCKS ', type: 'dynamic', bindHost: '127.0.0.1', bindPort: 1080, targetHost: '10.0.0.1', targetPort: 22 }))
      .toEqual({ hostId: 'h', name: 'SOCKS', type: 'dynamic', bindHost: '127.0.0.1', bindPort: 1080, targetHost: '', targetPort: 0 })
  })

  it('requires a target for local and remote forwards but not for dynamic ones', () => {
    expect(toPortForwardRuleDraft({ hostId: 'h', name: 'db', type: 'local', bindPort: 5433, targetHost: '', targetPort: 5432 })).toBeNull()
    expect(toPortForwardRuleDraft({ hostId: 'h', name: 'db', type: 'remote', bindPort: 8080, targetHost: 'localhost', targetPort: 0 })).toBeNull()
    expect(toPortForwardRuleDraft({ hostId: '', name: 'db', type: 'dynamic', bindPort: 1080 })).toBeNull()
    expect(toPortForwardRuleDraft({ hostId: 'h', name: 'proxy', type: 'dynamic', bindPort: 1080 })).toMatchObject({ type: 'dynamic', bindHost: '127.0.0.1' })
    expect(toPortForwardRuleDraft({ hostId: 'h', name: 'db', bindPort: 5433, targetHost: ' 10.0.3.12 ', targetPort: 5432 }))
      .toEqual({ hostId: 'h', name: 'db', type: 'local', bindHost: '127.0.0.1', bindPort: 5433, targetHost: '10.0.3.12', targetPort: 5432 })
  })

  it('sends the dynamic type to the native add command', async () => {
    invoke.mockResolvedValue({ id: 'r' })
    await addPortForwardRule({ hostId: 'h', name: 'proxy', type: 'dynamic', bindHost: '127.0.0.1', bindPort: 1080, targetHost: '', targetPort: 0 }, 'v')
    expect(invoke).toHaveBeenCalledWith('add_port_forward_rule', { payload: expect.objectContaining({ type: 'dynamic' }), vaultId: 'v' })
    expect(PORT_FORWARD_FLAGS.dynamic).toBe('-D')
  })
})
