import { HostForm } from '@/components/host-form'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { HostProfileDraft } from '@/lib/hosts'

interface HostCreateDialogProps {
  open: boolean
  defaultUsername?: string
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  vaultName?: string
  existingGroups?: string[]
  existingTags?: string[]
  onSubmit: (draft: HostProfileDraft) => Promise<void>
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
  existingGroups,
  existingTags,
  onSubmit,
  onCancel,
}: HostCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel() }}>
      <DialogContent>
        <HostForm
          defaultUsername={defaultUsername}
          vaultKeys={vaultKeys}
          vaultUnlocked={vaultUnlocked}
          onSaveToVault={onSaveToVault}
          onLoadVaultSecret={onLoadVaultSecret}
          vaultName={vaultName}
          existingGroups={existingGroups}
          existingTags={existingTags}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  )
}
