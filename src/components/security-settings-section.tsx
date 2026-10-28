import { useRef, useState } from 'react'
import { Check, Lock, LockOpen, Pencil, Plus, ShieldAlert, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVault } from '@/contexts/vault-context'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { securitySettingsCopy } from '@/lib/locales/security-settings'
import { confirmUserAction } from '@/lib/user-confirmation'
import { cn } from '@/lib/utils'
import { createVault, deleteVault, updateVault, DEFAULT_VAULT_ID } from '@/lib/vaults'

/**
 * Settings · Security & data. Vault management and the security event log
 * existed in code but had no place in the UI; they live here now.
 */
export function SecuritySettingsSection() {
  const { locale } = useT()
  const c = securitySettingsCopy[locale]
  const vault = useVault()
  const { activeVaultId, vaults, vaultStatusState, vaultBusy, securityEvents } = vault
  const unlocked = !!vaultStatusState?.unlocked
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Any vault change invalidates a pending delete confirmation.
  const generation = useRef(0)
  const current = vaults.find((item) => item.id === activeVaultId)

  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const create = () => run(async () => {
    const name = creating?.trim()
    if (!name) throw new Error(c.nameRequired)
    const created = await createVault(name)
    generation.current++
    setCreating(null)
    await vault.refreshVaults()
    vault.setActiveVaultId(created.id)
  })
  const rename = () => run(async () => {
    const name = editing?.name.trim()
    if (!editing || !name) throw new Error(c.nameRequired)
    await updateVault(editing.id, name)
    generation.current++
    setEditing(null)
    await vault.refreshVaults()
  })
  const remove = (id: string) => run(async () => {
    if (id === DEFAULT_VAULT_ID) throw new Error(c.deleteDefault)
    if (!unlocked) throw new Error(c.unlockFirst)
    const target = vaults.find((item) => item.id === id)
    if (!target) return
    const started = generation.current
    const isCurrent = () => started === generation.current
    if (await confirmUserAction({ message: fill(c.deleteConfirm, { name: target.name }), risk: 'high', vaultId: activeVaultId, isCurrent }) !== true || !isCurrent()) return
    await deleteVault(id)
    generation.current++
    await vault.refreshVaults()
    if (activeVaultId === id) vault.setActiveVaultId(DEFAULT_VAULT_ID)
  })

  const events = [...securityEvents].reverse().slice(0, 50)

  return (
    <>
      <section data-testid="security-vault" className="sb-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold">{c.vaultTitle}{current && <span className="ml-2 text-sm font-normal text-muted-foreground">· {current.name}</span>}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{c.vaultDesc}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn('inline-flex items-center gap-1 text-xs font-medium', unlocked ? 'text-[color:var(--workspace-status-good-text)]' : 'text-muted-foreground')}>
              {unlocked ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}{unlocked ? c.unlocked : c.locked}
            </span>
            <Button size="sm" variant="outline" data-testid="security-lock-now" disabled={!unlocked || vaultBusy} className="gap-1.5" onClick={() => void vault.handleLock()}><Lock className="h-3.5 w-3.5" />{c.lockNow}</Button>
          </div>
        </div>
      </section>

      <section data-testid="security-vaults" className="sb-card p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="font-semibold">{c.vaultsTitle}</h3><p className="mt-0.5 text-xs text-muted-foreground">{c.vaultsDesc}</p></div>
          {creating === null && <Button size="sm" variant="outline" className="gap-1.5" data-testid="security-vault-create" onClick={() => setCreating('')}><Plus className="h-3.5 w-3.5" />{c.create}</Button>}
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border">
          {vaults.map((item) => {
            const isActive = item.id === activeVaultId
            const isEditing = editing?.id === item.id
            return (
              <div key={item.id} data-testid="security-vault-row" data-vault-id={item.id} className={cn('flex items-center gap-3 px-3 py-2.5', isActive && 'bg-primary/5')}>
                {isEditing ? (
                  <form className="flex flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); void rename() }}>
                    <Input autoFocus aria-label={c.rename} value={editing.name} onChange={(event) => setEditing({ id: item.id, name: event.target.value })} className="h-8 max-w-xs" />
                    <Button size="sm" type="submit" disabled={busy}><Check className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" type="button" aria-label={c.cancel} onClick={() => setEditing(null)}><X className="h-3.5 w-3.5" /></Button>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium">{item.name}</span>
                      {item.id === DEFAULT_VAULT_ID && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{c.defaultVault}</span>}
                      {isActive && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{c.active}</span>}
                    </div>
                    {!isActive && <Button size="sm" variant="outline" disabled={busy || vaultBusy} onClick={() => vault.setActiveVaultId(item.id)}>{c.switchTo}</Button>}
                    <Button size="sm" variant="ghost" aria-label={`${c.rename} · ${item.name}`} disabled={busy} onClick={() => setEditing({ id: item.id, name: item.name })}><Pencil className="h-3.5 w-3.5" /></Button>
                    {item.id !== DEFAULT_VAULT_ID && <Button size="sm" variant="ghost" aria-label={`${c.remove} · ${item.name}`} data-testid={`security-vault-delete-${item.id}`} disabled={busy || !unlocked} className="text-destructive hover:text-destructive" onClick={() => void remove(item.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}
                  </>
                )}
              </div>
            )
          })}
          {creating !== null && (
            <form className="flex items-center gap-2 px-3 py-2.5" onSubmit={(event) => { event.preventDefault(); void create() }}>
              <Input autoFocus aria-label={c.createPlaceholder} placeholder={c.createPlaceholder} value={creating} onChange={(event) => setCreating(event.target.value)} className="h-8 max-w-xs" />
              <Button size="sm" type="submit" disabled={busy} data-testid="security-vault-create-save">{c.save}</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setCreating(null)}>{c.cancel}</Button>
            </form>
          )}
        </div>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      </section>

      <section data-testid="security-events" className="sb-card p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="font-semibold">{c.eventsTitle}</h3><p className="mt-0.5 text-xs text-muted-foreground">{c.eventsDesc}</p></div>
          {events.length > 0 && <Button size="sm" variant="ghost" onClick={vault.handleClearSecurityEvents}>{c.clear}</Button>}
        </div>
        {events.length === 0 ? <p className="text-xs text-muted-foreground">{c.eventsEmpty}</p> : (
          <ol className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border text-xs">
            {events.map((event) => (
              <li key={event.id} data-testid="security-event" data-level={event.level} className="flex items-start gap-2.5 px-3 py-2">
                <ShieldAlert className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', event.level === 'error' ? 'text-destructive' : event.level === 'warn' ? 'text-[color:var(--workspace-status-warn)]' : 'text-muted-foreground')} />
                <span className="min-w-0 flex-1 break-words">{event.message}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{c.level[event.level]} · {new Date(event.timestamp).toLocaleString(locale)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}
