import { SftpDualPane } from '@/components/sftp-dual-pane'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { WorkspaceEmptyState } from './workspace-empty-state'

interface WorkspaceFilesAppProps {
  selectedHostId?: string | null
  selectedHostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  presentation?: 'panel' | 'window' | 'mobile'
}

export function WorkspaceFilesApp({
  selectedHostId = null,
  selectedHostAddress = null,
  hosts,
  resolveAuthSecret,
  presentation = 'panel',
}: WorkspaceFilesAppProps) {
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
        title={t('workspace.files.title')}
        description={t('workspace.files.emptyDescription')}
      />
    )
  }

  return (
    <div
      data-testid="workspace-files-app"
      className={isEmbedded ? 'flex h-full min-h-0 flex-col' : 'flex min-h-0 flex-col gap-4'}
    >
      {!isEmbedded && (
        <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
          <div className="text-xs font-medium uppercase tracking-[0.22em] text-[var(--workspace-accent-text)]">{t('workspace.files.eyebrow')}</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t('workspace.files.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('workspace.files.description')}</p>
        </div>
      )}
      <div
        className={
          isEmbedded
            ? 'relative min-h-0 flex-1 overflow-hidden rounded-[24px] border border-border/60 bg-background/92'
            : 'relative min-h-[30rem] overflow-hidden rounded-[28px] border border-border/60 bg-card/70 p-3'
        }
      >
        <SftpDualPane
          className={isEmbedded ? 'h-full min-h-0' : 'h-[36rem] min-h-0'}
          hosts={hosts}
          selectedHostId={activeHostId}
          resolveAuthSecret={resolveAuthSecret}
        />
      </div>
    </div>
  )
}
