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
        <>
          <div className="relative flex h-16 w-16 items-center justify-center">
            <div className="absolute inset-0 animate-spin rounded-full border-2 border-primary/20 border-t-primary" style={{ animationDuration: '1.5s' }} />
            <Server className="h-6 w-6 text-primary" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('sftpConnect.connecting', { host: hostName })}</p>
            <p className="text-xs text-muted-foreground">{hostAddress}:{hostPort}</p>
          </div>
          <div className="w-56 space-y-2">
            {CONNECT_STEPS.map((s, i) => {
              const StepIcon = s.icon
              const active = step >= i + 1
              const current = step === i + 1
              return (
                <div key={i} className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-xs transition-all duration-300',
                  active ? 'text-foreground' : 'text-muted-foreground/40',
                )}>
                  {current ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                  ) : active ? (
                    <StepIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <StepIcon className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{s.label}</span>
                </div>
              )
            })}
          </div>
        </>
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
