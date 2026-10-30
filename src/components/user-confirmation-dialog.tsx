import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useVault } from '@/contexts/vault-context'
import { useHosts } from '@/contexts/hosts-context'
import { getHostIdentity } from '@/lib/host-identity'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { registerUserConfirmationPresenter, type UserConfirmationDecision, type UserConfirmationRequest } from '@/lib/user-confirmation'

interface ConfirmationScope {
  vaultId: string
  unlocked: boolean
  hosts: readonly HostProfile[]
}
interface Pending {
  request: UserConfirmationRequest
  scopeValid: () => boolean
  resolve: (decision: UserConfirmationDecision) => void
}

function hostKey(host: HostProfile, hosts: readonly HostProfile[]) {
  const jump = host.jumpHostId ? hosts.find(row => row.id === host.jumpHostId) : undefined
  const version = (row: HostProfile) => [row.name, row.updatedAt, row.authType, row.secretKeyRef, row.passwordKeyRef, row.privateKeyRef]
  return JSON.stringify([getHostIdentity(host, hosts), version(host), jump ? version(jump) : null])
}

/** Visible, asynchronous consent shared by desktop and mobile Ops flows.
 * One request at a time; pending consent is never queued or retained on disk. */
export function UserConfirmationDialog({ vaultId, unlocked, hosts }: ConfirmationScope) {
  const { t } = useT()
  const currentScope = useRef({ vaultId, unlocked, hosts })
  useLayoutEffect(() => { currentScope.current = { vaultId, unlocked, hosts } }, [vaultId, unlocked, hosts])
  const pendingRef = useRef<Pending | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [token, setToken] = useState('')
  const cancelButton = useRef<HTMLButtonElement>(null)

  function settle(accepted: boolean) {
    const current = pendingRef.current
    if (!current) return
    pendingRef.current = null
    setPending(null)
    setToken('')
    const valid = current.scopeValid()
    current.resolve({ accepted: valid && accepted, reason: !valid ? 'scope-changed' : accepted ? 'accepted' : 'rejected', isCurrent: current.scopeValid })
  }

  useEffect(() => {
    let live = true
    const unregister = registerUserConfirmationPresenter(request => {
      if (pendingRef.current) return Promise.resolve('busy')
      const initial = currentScope.current
      const scoped = initial.hosts.filter(row => !row.vaultId || row.vaultId === initial.vaultId)
      const requested = request.hosts ?? (request.host ? [request.host] : [])
      const expected = requested.map(host => ({ host, key: hostKey(host, scoped) }))
      const scopeValid = () => {
        try {
          const current = currentScope.current
          if (!live || !initial.unlocked || !current.unlocked || current.vaultId !== initial.vaultId
            || (request.vaultId && request.vaultId !== current.vaultId) || request.isCurrent?.() === false) return false
          const profiles = current.hosts.filter(row => !row.vaultId || row.vaultId === current.vaultId)
          return expected.every(({ host, key }) => {
            const latest = profiles.find(row => row.id === host.id)
            return (!host.vaultId || host.vaultId === current.vaultId) && latest !== undefined && hostKey(latest, profiles) === key
          })
        } catch { return false }
      }
      if (!scopeValid()) return Promise.resolve('scope-changed')
      return new Promise<UserConfirmationDecision>(resolve => {
        const next = { request, scopeValid, resolve }
        pendingRef.current = next
        setToken('')
        setPending(next)
      })
    })
    return () => {
      live = false
      unregister()
      const current = pendingRef.current
      pendingRef.current = null
      current?.resolve({ accepted: false, reason: 'scope-changed', isCurrent: () => false })
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    // Render changes invalidate immediately; the tick also observes callbacks
    // whose current host scope lives outside React state.
    if (!pending.scopeValid()) {
      queueMicrotask(() => { if (pendingRef.current === pending) settle(false) })
      return
    }
    cancelButton.current?.focus()
    const timer = window.setInterval(() => { if (!pending.scopeValid()) settle(false) }, 250)
    return () => window.clearInterval(timer)
  }, [pending, vaultId, unlocked, hosts])

  if (!pending) return null
  const request = pending.request
  // First line states the action; the rest is shown as the review list.
  const lines = request.message.split('\n').map((line) => line.trim()).filter(Boolean)
  return (
    <Dialog open labelledBy="user-confirmation-title" describedBy="user-confirmation-summary user-confirmation-message" onOpenChange={open => { if (!open) settle(false) }}>
      <DialogContent className="md:max-w-xl">
        <div data-testid="user-confirmation" data-vault-id={vaultId} data-host-id={request.host?.id} data-risk={request.risk ?? 'low'} className="space-y-4 p-6">
          <div data-testid="user-confirmation-message" className="space-y-4">
          <div className="flex items-start gap-3">
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', request.risk === 'high' ? 'bg-[var(--workspace-status-bad-bg)] text-[var(--workspace-status-bad)]' : 'bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)]')}>
              {request.risk === 'high' ? <TriangleAlert className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
            </span>
            <div className="min-w-0 pt-0.5">
              <h2 id="user-confirmation-title" className="text-base font-semibold">{t('confirmation.title')}</h2>
              {lines[0] && <p id="user-confirmation-summary" className="mt-0.5 break-words text-sm text-[var(--workspace-text)]">{lines[0]}</p>}
            </div>
          </div>
          <div id="user-confirmation-message" className="max-h-[50vh] overflow-y-auto">
            {lines.length > 1 && (
              <ul className="divide-y divide-[color:var(--workspace-border-soft)] rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[13px]">
                {lines.slice(1).map((line, index) => <li key={index} className="whitespace-pre-wrap break-words px-3 py-1.5 text-[var(--workspace-text)]">{line}</li>)}
              </ul>
            )}
          </div>
          </div>
          {request.token !== undefined && <label className="block space-y-2 text-sm">
            <span>{t('confirmation.typeToken', { token: request.token })}</span>
            <input data-testid="user-confirmation-token" className="w-full rounded-lg border bg-background px-3 py-2 font-mono" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </label>}
          <div className="flex justify-end gap-3">
            <Button ref={cancelButton} data-testid="user-confirmation-cancel" variant="outline" onClick={() => settle(false)}>{t('confirmation.cancel')}</Button>
            <Button data-testid="user-confirmation-accept" variant={request.risk === 'high' ? 'destructive' : 'default'} disabled={request.token !== undefined && token !== request.token} onClick={() => settle(true)}>{t('confirmation.accept')}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function UserConfirmationRuntime() {
  const { activeVaultId, vaultStatusState } = useVault()
  const { hosts } = useHosts()
  return <UserConfirmationDialog vaultId={activeVaultId} unlocked={vaultStatusState?.unlocked === true} hosts={hosts} />
}
