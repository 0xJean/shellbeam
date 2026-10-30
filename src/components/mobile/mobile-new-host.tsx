import { X } from 'lucide-react'
import { HostForm } from '@/components/host-form'
import type { HostProfile, HostProfileDraft } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { mobileHostsCopy } from '@/lib/locales/mobile-hosts-v3'
import { ClipboardSshChip } from './clipboard-ssh-chip'

export interface MobileNewHostProps {
  defaultUsername?: string
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  vaultId?: string
  vaultName?: string
  existingGroups?: string[]
  existingTags?: string[]
  availableHosts?: HostProfile[]
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  onSubmit: (draft: HostProfileDraft, options?: { installProbe: boolean }) => Promise<void>
  onCancel: () => void
}

/** v3 m:newhost — the shared host form as a full-screen sheet, with clipboard `ssh` detection on top. */
export function MobileNewHost({ onCancel, ...formProps }: MobileNewHostProps) {
  const { locale } = useT()
  const c = mobileHostsCopy[locale]
  return (
    <div data-testid="mobile-new-host" role="dialog" aria-modal="true" aria-label={c.newHost}
      className="fixed inset-0 z-[60] flex flex-col bg-[var(--workspace-surface-950)]"
      style={{ padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' }}>
      <div className="flex h-12 shrink-0 items-center px-1.5">
        <button type="button" data-testid="mobile-new-host-close" onClick={onCancel} aria-label={c.cancel}
          className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-2 text-[15px] text-[var(--workspace-accent-text)]">
          <X className="h-5 w-5" />{c.cancel}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
        <HostForm key={formProps.vaultId} {...formProps} onCancel={onCancel}
          renderPrefill={(apply) => <ClipboardSshChip onApply={apply} />} />
      </div>
    </div>
  )
}
