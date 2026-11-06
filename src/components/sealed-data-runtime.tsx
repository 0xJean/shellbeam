import { useEffect } from 'react'
import { useVault } from '@/contexts/vault-context'
import { onAIVaultLocked, onAIVaultUnlocked } from '@/lib/ai-vault'
import { clearInteractiveHistory, hydrateInteractiveHistory } from '@/lib/interactive-history'

/**
 * Data sealed by the active Vault outside its file (AI keys and conversations,
 * typed command history) loads when the Vault unlocks and leaves memory when it locks.
 */
export function SealedDataRuntime() {
  const { activeVaultId, vaultStatusState } = useVault()
  const unlocked = vaultStatusState?.unlocked ?? false
  useEffect(() => {
    if (!unlocked) { onAIVaultLocked(); clearInteractiveHistory(); return }
    void onAIVaultUnlocked(activeVaultId)
    void hydrateInteractiveHistory(activeVaultId)
  }, [unlocked, activeVaultId])
  return null
}
