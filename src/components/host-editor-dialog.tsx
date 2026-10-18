import { HostForm } from '@/components/host-form'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { HostProfile, HostProfileDraft } from '@/lib/hosts'

interface HostEditorDialogProps {
  host: HostProfile | null
  defaultUsername?: string
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  vaultName?: string
  existingGroups?: string[]
  existingTags?: string[]
  availableHosts?: HostProfile[]
  onSubmit: (host: HostProfile, draft: HostProfileDraft) => Promise<void>
  onCancel: () => void
}

export function HostEditorDialog({
  host,
  defaultUsername,
  vaultKeys,
  vaultUnlocked,
  onSaveToVault,
  onLoadVaultSecret,
  vaultName,
  existingGroups,
  existingTags,
  availableHosts,
  onSubmit,
  onCancel,
}: HostEditorDialogProps) {
  return (
    <Dialog open={!!host} onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent>
        {host && (
          <HostForm
            initial={host}
            defaultUsername={defaultUsername}
            vaultKeys={vaultKeys}
            vaultUnlocked={vaultUnlocked}
            onSaveToVault={onSaveToVault}
            onLoadVaultSecret={onLoadVaultSecret}
            vaultName={vaultName}
            existingGroups={existingGroups}
            existingTags={existingTags}
          availableHosts={availableHosts}
            onSubmit={(draft) => onSubmit(host, draft)}
            onCancel={onCancel}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
