import { Suspense, lazy } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { WorkspaceEmptyState } from './workspace-empty-state'

const SftpDualPane = lazy(async () => {
  const module = await import('@/components/sftp-dual-pane')
  return { default: module.SftpDualPane }
})

interface WorkspaceFileTransferAppProps {
  selectedHostId?: string | null
  selectedHostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  presentation?: 'panel' | 'window' | 'mobile'
}

export function WorkspaceFileTransferApp({
  selectedHostId = null,
  selectedHostAddress = null,
  hosts,
  resolveAuthSecret,
  presentation = 'panel',
}: WorkspaceFileTransferAppProps) {
  const { t } = useT()
  const activeHostId = selectedHostId ?? (
    selectedHostAddress
      ? hosts.find((host) => host.address === selectedHostAddress)?.id ?? null
      : null
  )
  const isEmbedded = presentation !== 'panel'

  if (!activeHostId) {
    return (
      <WorkspaceEmptyState
        title={t('workspace.app.fileTransfer')}
        description={t('workspace.fileTransfer.emptyDescription')}
      />
    )
  }

  const paneClassName = isEmbedded ? 'h-full min-h-0' : 'h-[36rem] min-h-0'

  return (
    <div
      data-testid="workspace-file-transfer-app"
      className={isEmbedded ? 'flex h-full min-h-0 flex-col' : 'flex min-h-0 flex-col gap-4'}
    >
      {!isEmbedded && (
        <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
          <div className="text-xs font-medium uppercase tracking-[0.22em] text-[var(--workspace-accent-text)]">{t('workspace.app.fileTransfer')}</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t('workspace.fileTransfer.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('workspace.fileTransfer.description')}</p>
        </div>
      )}
      <div
        className={
          isEmbedded
            ? 'relative min-h-0 flex-1 overflow-hidden rounded-[24px] border border-border/60 bg-background/92'
            : 'relative min-h-[30rem] overflow-hidden rounded-[28px] border border-border/60 bg-card/70 p-3'
        }
      >
        <Suspense fallback={<FileTransferPaneFallback className={paneClassName} label={t('workspace.fileTransfer.loading')} />}>
          <SftpDualPane
            className={paneClassName}
            hosts={hosts}
            selectedHostId={activeHostId}
            resolveAuthSecret={resolveAuthSecret}
          />
        </Suspense>
      </div>
    </div>
  )
}

function FileTransferPaneFallback({ className, label }: { className: string; label: string }) {
  return (
    <div className={`${className} flex items-center justify-center`}>
      <div className="rounded-2xl border border-border/60 bg-card/80 px-4 py-3 text-sm text-muted-foreground">
        {label}
      </div>
    </div>
  )
}
