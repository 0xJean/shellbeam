import { useState } from 'react'
import { Terminal, Server, Laptop, Trash2, Pencil, KeyRound, LockKeyhole, User, Clock, Tag, RefreshCw, AlertTriangle } from 'lucide-react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type TFn = (key: string, params?: Record<string, string | number>) => string

function formatRelativeTime(ts: number, t: TFn): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('hostCard.justNow')
  if (minutes < 60) return t('hostCard.mAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('hostCard.hAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('hostCard.dAgo', { n: days })
  return new Date(ts).toLocaleDateString()
}

export function statusConfig(status: string | undefined, t: TFn) {
  if (status === 'online') return { label: t('hostCard.online'), dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10' }
  if (status === 'offline') return { label: t('hostCard.offline'), dot: 'bg-destructive', text: 'text-destructive', bg: 'bg-destructive/10' }
  return null
}

export function groupIconConfig(group: string) {
  switch (group) {
    case 'Production':
      return { icon: <Server className="h-5 w-5 text-white" />, bg: 'bg-emerald-600' }
    case 'Development':
      return { icon: <Laptop className="h-5 w-5 text-white" />, bg: 'bg-blue-600' }
    case 'Staging':
      return { icon: <Server className="h-5 w-5 text-white" />, bg: 'bg-amber-600' }
    default:
      return { icon: <Server className="h-5 w-5 text-white" />, bg: 'bg-slate-600' }
  }
}

interface HostGridCardProps {
  host: HostProfile
  isSelected: boolean
  status?: 'online' | 'offline' | 'checking'
  onConnect: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onSelect: (id: string) => void
}

export function HostGridCard({ host, isSelected, status, onConnect, onEdit, onDelete }: HostGridCardProps) {
  const { t } = useT()
  const { icon, bg } = groupIconConfig(host.group || 'Custom')
  const sc = statusConfig(status, t)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const groupLabel = t(`group.${host.group}`) !== `group.${host.group}` ? t(`group.${host.group}`) : host.group

  return (
    <>
      <div
        className={cn(
          'group relative flex flex-col rounded-xl border transition-all',
          isSelected
            ? 'border-primary/50 bg-primary/5 shadow-md shadow-primary/5'
            : 'border-border hover:border-muted-foreground/25 hover:shadow-md hover:shadow-black/5'
        )}
      >
        <div
          className="absolute right-2.5 top-2.5 flex gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
          style={isSelected ? { opacity: 1 } : undefined}
        >
          <span role="button" tabIndex={0}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-7 md:w-7"
            onClick={() => onConnect(host.id)} title={t('hostCard.connect')}>
            <Terminal className="h-4 w-4 md:h-3.5 md:w-3.5" />
          </span>
          <span role="button" tabIndex={0}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-7 md:w-7"
            onClick={() => onEdit(host.id)} title={t('hostCard.edit')}>
            <Pencil className="h-4 w-4 md:h-3.5 md:w-3.5" />
          </span>
          <span role="button" tabIndex={0}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive md:h-7 md:w-7"
            onClick={() => setConfirmOpen(true)} title={t('hostCard.delete')}>
            <Trash2 className="h-4 w-4 md:h-3.5 md:w-3.5" />
          </span>
        </div>

        <div className="flex items-center gap-3 px-4 pt-4 pb-3">
          <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-lg shadow-sm', bg)}>{icon}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">{host.name}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{host.address}{host.port !== 22 ? `:${host.port}` : ''}</p>
          </div>
        </div>

        <div className="flex-1 space-y-2 border-t border-border/50 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <User className="h-3 w-3" /><span className="truncate">{host.username || 'root'}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {host.authType === 'privateKey'
                ? <><KeyRound className="h-3 w-3" /><span>{t('hostCard.sshKey')}</span></>
                : <><LockKeyhole className="h-3 w-3" /><span>{t('hostCard.password')}</span></>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {sc ? (
              <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', sc.bg, sc.text)}>
                <span className={cn('h-1.5 w-1.5 rounded-full', sc.dot)} />{sc.label}
              </span>
            ) : status === 'checking' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                <RefreshCw className="h-2.5 w-2.5 animate-spin" />{t('hostCard.checking')}
              </span>
            ) : null}
            {host.group && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{groupLabel}</span>
            )}
          </div>
          <div className="flex items-center gap-1 overflow-hidden">
            {host.tags && host.tags.length > 0 ? (
              <>
                <Tag className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                <div className="flex gap-1 overflow-hidden">
                  {host.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="shrink-0 rounded bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{tag}</span>
                  ))}
                  {host.tags.length > 3 && <span className="shrink-0 text-[10px] text-muted-foreground/50">+{host.tags.length - 3}</span>}
                </div>
              </>
            ) : (
              <span className="text-[10px] text-muted-foreground/30">&nbsp;</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border/50 px-4 py-3">
          <Button size="sm" className="h-10 flex-1 gap-1.5 text-sm md:h-8 md:text-xs" onClick={() => onConnect(host.id)}>
            <Terminal className="h-4 w-4 md:h-3.5 md:w-3.5" />{t('hostCard.connect')}
          </Button>
          {host.updatedAt > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground/60" title={new Date(host.updatedAt).toLocaleString()}>
              <Clock className="h-3 w-3" />{formatRelativeTime(host.updatedAt, t)}
            </span>
          )}
        </div>
      </div>

      <DeleteConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        hostName={host.name} hostAddress={host.address}
        onConfirm={() => { setConfirmOpen(false); onDelete(host.id) }} />
    </>
  )
}

interface HostListItemProps {
  host: HostProfile
  isSelected: boolean
  status?: 'online' | 'offline' | 'checking'
  onSelect: (id: string) => void
  onConnect: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

export function HostListItem({ host, isSelected, status, onSelect, onConnect, onEdit, onDelete }: HostListItemProps) {
  const { t } = useT()
  const { icon, bg } = groupIconConfig(host.group || 'Custom')
  const sc = statusConfig(status, t)
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => onSelect(host.id)}
        className={cn('group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-all', isSelected ? 'bg-primary/5 ring-1 ring-primary/30' : 'hover:bg-muted/50')}>
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shadow-sm', bg)}>{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{host.name}</p>
            {sc && <span className={cn('h-2 w-2 shrink-0 rounded-full', sc.dot)} />}
            {status === 'checking' && <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
          </div>
          <p className="truncate text-xs text-muted-foreground">{host.address}{host.port !== 22 ? `:${host.port}` : ''}</p>
        </div>
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <span className="text-[11px] text-muted-foreground/60">{host.username || 'root'}@:{host.port}</span>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
            {host.authType === 'privateKey' ? <KeyRound className="h-3 w-3" /> : <LockKeyhole className="h-3 w-3" />}
            {host.authType === 'privateKey' ? t('hostCard.key') : t('hostCard.pass')}
          </span>
          {host.updatedAt > 0 && <span className="text-[10px] text-muted-foreground/40">{formatRelativeTime(host.updatedAt, t)}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
          style={isSelected ? { opacity: 1 } : undefined}>
          <span role="button" tabIndex={0}
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-8 md:w-8"
            onClick={(e) => { e.stopPropagation(); onConnect(host.id) }} title={t('hostCard.connect')}>
            <Terminal className="h-4 w-4" />
          </span>
          <span role="button" tabIndex={0}
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-8 md:w-8"
            onClick={(e) => { e.stopPropagation(); onEdit(host.id) }} title={t('hostCard.edit')}>
            <Pencil className="h-4 w-4" />
          </span>
          <span role="button" tabIndex={0}
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive md:h-8 md:w-8"
            onClick={(e) => { e.stopPropagation(); setConfirmOpen(true) }} title={t('hostCard.delete')}>
            <Trash2 className="h-4 w-4" />
          </span>
        </div>
      </button>

      <DeleteConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        hostName={host.name} hostAddress={host.address}
        onConfirm={() => { setConfirmOpen(false); onDelete(host.id) }} />
    </>
  )
}

function DeleteConfirmDialog({ open, onOpenChange, hostName, hostAddress, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; hostName: string; hostAddress: string; onConfirm: () => void
}) {
  const { t } = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!h-auto !max-w-[300px] !rounded-2xl border-0 bg-popover px-6 pb-6 pt-7 shadow-2xl ring-1 ring-border/40">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/20">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-base font-semibold">{t('hostCard.deleteTitle')}</h3>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('hostCard.deleteDesc', { name: hostName, address: hostAddress })}
            </p>
          </div>
          <div className="flex w-full gap-3 pt-1">
            <button type="button"
              className="h-11 flex-1 rounded-xl border border-border bg-secondary/50 text-[13px] font-medium text-secondary-foreground transition-colors active:bg-secondary/80"
              onClick={() => onOpenChange(false)}>
              {t('hostCard.deleteCancel')}
            </button>
            <button type="button"
              className="h-11 flex-1 rounded-xl bg-destructive text-[13px] font-medium text-white transition-colors active:bg-destructive/80"
              onClick={onConfirm}>
              {t('hostCard.deleteConfirm')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
