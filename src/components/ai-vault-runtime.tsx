import { useEffect } from 'react'
import { useVault } from '@/contexts/vault-context'
import { onAIVaultLocked, onAIVaultUnlocked } from '@/lib/ai-vault'

/** AI keys and conversations are sealed by the active Vault: they load when it unlocks and leave memory when it locks. */
export function AIVaultRuntime() {
  const { activeVaultId, vaultStatusState } = useVault()
  const unlocked = vaultStatusState?.unlocked ?? false
  useEffect(() => {
    if (!unlocked) { onAIVaultLocked(); return }
    void onAIVaultUnlocked(activeVaultId)
  }, [unlocked, activeVaultId])
  return null
}
