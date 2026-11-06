import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AIVaultRuntime } from './ai-vault-runtime'
import { useVault } from '@/contexts/vault-context'
import { onAIVaultLocked, onAIVaultUnlocked } from '@/lib/ai-vault'

vi.mock('@/contexts/vault-context', () => ({ useVault: vi.fn() }))
vi.mock('@/lib/ai-vault', () => ({ onAIVaultLocked: vi.fn(), onAIVaultUnlocked: vi.fn(async () => {}) }))

const vault = (activeVaultId: string, unlocked: boolean) =>
  ({ activeVaultId, vaultStatusState: { initialized: true, unlocked, secretCount: 0 } }) as unknown as ReturnType<typeof useVault>

describe('AIVaultRuntime', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads AI keys for the Vault that unlocks and drops them when it locks', () => {
    vi.mocked(useVault).mockReturnValue(vault('v1', false))
    const view = render(<AIVaultRuntime />)
    expect(onAIVaultLocked).toHaveBeenCalledTimes(1)
    expect(onAIVaultUnlocked).not.toHaveBeenCalled()

    vi.mocked(useVault).mockReturnValue(vault('v1', true))
    view.rerender(<AIVaultRuntime />)
    expect(onAIVaultUnlocked).toHaveBeenCalledExactlyOnceWith('v1')

    vi.mocked(useVault).mockReturnValue(vault('v2', true))
    view.rerender(<AIVaultRuntime />)
    expect(onAIVaultUnlocked).toHaveBeenLastCalledWith('v2')

    vi.mocked(useVault).mockReturnValue(vault('v2', false))
    view.rerender(<AIVaultRuntime />)
    expect(onAIVaultLocked).toHaveBeenCalledTimes(2)
  })
})
