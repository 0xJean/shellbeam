import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SealedDataRuntime } from './sealed-data-runtime'
import { useVault } from '@/contexts/vault-context'
import { onAIVaultLocked, onAIVaultUnlocked } from '@/lib/ai-vault'
import { clearInteractiveHistory, hydrateInteractiveHistory } from '@/lib/interactive-history'

vi.mock('@/contexts/vault-context', () => ({ useVault: vi.fn() }))
vi.mock('@/lib/ai-vault', () => ({ onAIVaultLocked: vi.fn(), onAIVaultUnlocked: vi.fn(async () => {}) }))
vi.mock('@/lib/interactive-history', () => ({ clearInteractiveHistory: vi.fn(), hydrateInteractiveHistory: vi.fn(async () => {}) }))

const vault = (activeVaultId: string, unlocked: boolean) =>
  ({ activeVaultId, vaultStatusState: { initialized: true, unlocked, secretCount: 0 } }) as unknown as ReturnType<typeof useVault>

describe('SealedDataRuntime', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads sealed data for the Vault that unlocks and drops it when it locks', () => {
    vi.mocked(useVault).mockReturnValue(vault('v1', false))
    const view = render(<SealedDataRuntime />)
    expect(onAIVaultLocked).toHaveBeenCalledTimes(1)
    expect(onAIVaultUnlocked).not.toHaveBeenCalled()

    vi.mocked(useVault).mockReturnValue(vault('v1', true))
    view.rerender(<SealedDataRuntime />)
    expect(onAIVaultUnlocked).toHaveBeenCalledExactlyOnceWith('v1')
    expect(hydrateInteractiveHistory).toHaveBeenCalledExactlyOnceWith('v1')

    vi.mocked(useVault).mockReturnValue(vault('v2', true))
    view.rerender(<SealedDataRuntime />)
    expect(onAIVaultUnlocked).toHaveBeenLastCalledWith('v2')

    vi.mocked(useVault).mockReturnValue(vault('v2', false))
    view.rerender(<SealedDataRuntime />)
    expect(onAIVaultLocked).toHaveBeenCalledTimes(2)
    expect(clearInteractiveHistory).toHaveBeenCalledTimes(2)
  })
})
