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
  const [step, setStep] = useState(0)

  const CONNECT_STEPS = [
    { icon: PlugZap, label: t('sftpConnect.tcpConnect') },
    { icon: ShieldCheck, label: t('sftpConnect.sshAuth') },
    { icon: FolderOpen, label: t('sftpConnect.openChannel') },
  ]

  useEffect(() => {
    if (!loading) { setStep(0); return }
    setStep(1)
    const t1 = setTimeout(() => setStep(2), 800)
    const t2 = setTimeout(() => setStep(3), 2000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [loading])

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-10 text-center">
      {loading ? (
        <div data-testid="sftp-connect-skeleton" className="w-full max-w-sm space-y-4">
          <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/85 px-4 py-4 shadow-sm">
            <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
              <div className="absolute inset-0 animate-pulse rounded-2xl bg-primary/10" />
              <div className="absolute inset-[6px] animate-spin rounded-full border-2 border-primary/20 border-t-primary" style={{ animationDuration: '1.5s' }} />
              <Server className="relative h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="text-sm font-medium">{t('sftpConnect.connecting', { host: hostName })}</p>
              <p className="text-xs text-muted-foreground">{hostAddress}:{hostPort}</p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-2/3 animate-pulse rounded-full bg-primary/50" />
              </div>
            </div>
          </div>
          <div className="space-y-2 rounded-2xl border border-border/60 bg-card/70 p-3">
            {CONNECT_STEPS.map((s, i) => {
              const StepIcon = s.icon
              const active = step >= i + 1
              const current = step === i + 1
              return (
                <div
                  key={i}
                  data-testid="sftp-connect-step-skeleton"
                  className={cn(
                  'flex items-center gap-2.5 rounded-xl border px-3 py-2 text-xs transition-all duration-300',
                  active ? 'border-primary/20 bg-primary/5 text-foreground' : 'border-border/50 bg-background/60 text-muted-foreground/50',
                )}>
                  <div className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                    active ? 'bg-primary/10' : 'bg-muted',
                  )}>
                    {current ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    ) : active ? (
                      <StepIcon className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <StepIcon className="h-3.5 w-3.5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 text-left">
                    <span>{s.label}</span>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted/80">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all duration-500',
                          active ? 'w-full bg-primary/35' : 'w-1/3 bg-muted-foreground/20',
                        )}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <PlugZap className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            {hasHost ? t('sftpConnect.clickToConnect') : t('sftpConnect.selectHost')}
          </p>
          {hasHost && (
            <Button size="sm" onClick={onConnect} className="gap-1.5">
              <PlugZap className="h-3.5 w-3.5" />
              {t('sftpConnect.connect')}
            </Button>
          )}
        </>
      )}
    </div>
  )
}
