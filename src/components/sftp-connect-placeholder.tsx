import { useEffect, useState } from 'react'
import { PlugZap, Server, ShieldCheck, FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

interface SftpConnectPlaceholderProps {
  loading: boolean
  hostName: string
  hostAddress: string
  hostPort: number
  hasHost: boolean
  onConnect: () => void
}

export function SftpConnectPlaceholder({
  loading, hostName, hostAddress, hostPort, hasHost, onConnect,
}: SftpConnectPlaceholderProps) {
  const { t } = useT()

  return (
    <div className="flex flex-col items-center justify-center gap-4 px-4 py-10 text-center">
      {loading ? (
        <ConnectingSteps hostName={hostName} hostAddress={hostAddress} hostPort={hostPort} />
      ) : (
        <>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--workspace-surface-800)]">
            <PlugZap className="h-6 w-6 text-[var(--workspace-text-subtle)]" />
          </div>
          <p className="text-sm text-[var(--workspace-text-muted)]">
            {hasHost ? t('sftpConnect.clickToConnect') : t('sftpConnect.selectHost')}
          </p>
          {hasHost && (
            <Button size="sm" onClick={onConnect} className="gap-1.5 bg-[color:var(--workspace-primary-500)] text-white hover:brightness-110">
              <PlugZap className="h-3.5 w-3.5" />
              {t('sftpConnect.connect')}
            </Button>
          )}
        </>
      )}
    </div>
  )
}

function ConnectingSteps({ hostName, hostAddress, hostPort }: Pick<SftpConnectPlaceholderProps, 'hostName' | 'hostAddress' | 'hostPort'>) {
  const { t } = useT()
  const [step, setStep] = useState(1)

  const CONNECT_STEPS = [
    { icon: PlugZap, label: t('sftpConnect.tcpConnect') },
    { icon: ShieldCheck, label: t('sftpConnect.sshAuth') },
    { icon: FolderOpen, label: t('sftpConnect.openChannel') },
  ]

  useEffect(() => {
    const t1 = setTimeout(() => setStep(2), 800)
    const t2 = setTimeout(() => setStep(3), 2000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  return (
    <div data-testid="sftp-connect-skeleton" className="w-full max-w-sm space-y-3">
      <div className="flex items-center gap-3 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-4 py-4">
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)]">
          <div className="absolute inset-[6px] animate-spin rounded-full border-2 border-[hsl(var(--primary)/0.2)] border-t-[hsl(var(--primary))]" style={{ animationDuration: '1.5s' }} />
          <Server className="relative h-5 w-5 text-[var(--workspace-accent-text)]" />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <p className="text-sm font-medium text-[var(--workspace-text-strong)]">{t('sftpConnect.connecting', { host: hostName })}</p>
          <p className="font-mono text-xs text-[var(--workspace-text-subtle)]">{hostAddress}:{hostPort}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--workspace-surface-700)]">
            <div className="h-full w-2/3 animate-pulse rounded-full bg-[color:var(--workspace-primary-500)]" />
          </div>
        </div>
      </div>
      <div className="space-y-1.5 rounded-xl border border-[color:var(--workspace-border-soft)] p-2">
        {CONNECT_STEPS.map((s, i) => {
          const StepIcon = s.icon
          const active = step >= i + 1
          const current = step === i + 1
          return (
            <div
              key={i}
              data-testid="sftp-connect-step-skeleton"
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs transition-all duration-300',
                active ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-subtle)]',
              )}>
              <div className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                active ? 'bg-[var(--workspace-surface-900)]' : 'bg-[var(--workspace-surface-800)]',
              )}>
                {current ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--workspace-accent-text)]" />
                ) : active ? (
                  <StepIcon className="h-3.5 w-3.5 text-[var(--workspace-status-good)]" />
                ) : (
                  <StepIcon className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <span>{s.label}</span>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--workspace-surface-700)]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      active ? 'w-full bg-[color:var(--workspace-primary-500)]' : 'w-1/3 bg-[var(--workspace-surface-800)]',
                    )}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
