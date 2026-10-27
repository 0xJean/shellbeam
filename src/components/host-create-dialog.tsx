import { HostForm } from '@/components/host-form'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { HostProfile, HostProfileDraft } from '@/lib/hosts'

interface HostCreateDialogProps {
  open: boolean
  defaultUsername?: string
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  vaultId?: string
  vaultName?: string
  existingGroups?: string[]
  existingTags?: string[]
  availableHosts?: HostProfile[]
  onSubmit: (draft: HostProfileDraft, options?: { installProbe: boolean }) => Promise<void>
  onCancel: () => void
}

export function HostCreateDialog({
  open,
  defaultUsername,
  vaultKeys,
  vaultUnlocked,
  onSaveToVault,
  onLoadVaultSecret,
  vaultName,
  vaultId,
  existingGroups,
  existingTags,
  availableHosts,
  onSubmit,
  onCancel,
}: HostCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel() }}>
      <DialogContent>
        <HostForm key={vaultId}
          defaultUsername={defaultUsername}
          vaultKeys={vaultKeys}
          vaultUnlocked={vaultUnlocked}
          onSaveToVault={onSaveToVault}
          onLoadVaultSecret={onLoadVaultSecret}
          vaultName={vaultName}
          vaultId={vaultId}
          existingGroups={existingGroups}
          existingTags={existingTags}
          availableHosts={availableHosts}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  )
}
