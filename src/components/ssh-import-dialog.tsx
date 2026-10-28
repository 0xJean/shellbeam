import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'
import { parseSshConfig, createHost, type SshConfigEntry } from '@/lib/hosts'
import { CircleCheck, Loader2, AlertCircle, Info, Route, X } from 'lucide-react'
import { hostOverlaysCopy } from '@/lib/locales/host-overlays-v3'
import { fill } from '@/lib/locales/probe-install'

interface SshImportDialogProps {
  vaultId?: string | null
  onClose: () => void
  onImported: () => void
}

export function SshImportDialog({ vaultId, onClose, onImported }: SshImportDialogProps) {
  const { t, locale } = useT()
  const v3 = hostOverlaysCopy[locale]
  const [entries, setEntries] = useState<SshConfigEntry[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importedCount, setImportedCount] = useState(0)
  const [skippedCount, setSkippedCount] = useState(0)

  useEffect(() => {
    parseSshConfig().then((res) => {
      setEntries(res)
      setSelected(new Set(res.map((_, i) => i)))
    }).catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false))
  }, [])

  const toggleEntry = (i: number) => {
    setSelected((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n })
  }

  const selectAll = () => setSelected(new Set(entries.map((_, i) => i)))
  const deselectAll = () => setSelected(new Set())

  async function handleImport() {
    setImporting(true)
    let count = 0
    for (const i of selected) {
      const e = entries[i]
      const address = e.hostName || e.alias
      let jumpHost: string | undefined
      let jumpPort: number | undefined
      let jumpUser: string | undefined
      if (e.proxyJump) {
        const match = e.proxyJump.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/)
        if (match) {
          jumpUser = match[1] || undefined
          jumpHost = match[2]
          jumpPort = match[3] ? parseInt(match[3], 10) : undefined
        }
      }
      try {
        await createHost({
          name: e.alias,
          address,
          port: e.port ?? 22,
          username: e.user ?? 'root',
          authType: e.identityFile ? 'privateKey' : 'password',
          group: 'Custom',
          tags: ['ssh-import'],
          jumpHost, jumpPort, jumpUser,
        }, vaultId)
        count++
      } catch { /* skip duplicates or errors */ }
    }
    setImportedCount(count)
    setSkippedCount(selected.size - count)
    setImporting(false)
    onImported()
  }

  const done = importedCount > 0
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="ssh-import-title" className={`sb-card mx-4 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl bg-[var(--workspace-surface-900)] text-[var(--workspace-text)] shadow-xl ${done ? 'max-w-md' : 'max-w-2xl'}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id="ssh-import-title" className="text-lg font-semibold text-[var(--workspace-text-strong)]">{t('sshImport.title')}</h2>
            {!done && !loading && entries.length > 0 && <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{fill(v3.importSub, { count: entries.length })}</p>}
          </div>
          <button type="button" aria-label={t('common.close')} onClick={onClose} className="rounded-md p-1 text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--workspace-text-muted)]" />
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-[var(--workspace-status-bad-bg)] px-4 py-3 text-sm text-[var(--workspace-status-bad-text)]">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <p className="py-6 text-center text-sm text-[var(--workspace-text-muted)]">{t('sshImport.empty')}</p>
          )}

          {done && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <CircleCheck className="mb-2 h-9 w-9 text-[var(--workspace-status-good)]" />
              <p className="text-base font-semibold text-[var(--workspace-text-strong)]">{t('sshImport.imported', { n: importedCount })}</p>
              <p className="text-xs text-[var(--workspace-text-muted)]">{skippedCount > 0 ? fill(v3.importDoneSub, { skipped: skippedCount }) : v3.importDoneSubAll}</p>
            </div>
          )}

          {!done && !loading && entries.length > 0 && (
            <>
              <div className="mb-2 flex items-center gap-3 text-xs">
                <span className="flex-1 text-sm font-medium text-[var(--workspace-text-strong)]">{t('sshImport.selected', { n: selected.size, total: entries.length })}</span>
                <button type="button" onClick={selectAll} className="text-[var(--workspace-accent-text)] hover:underline">{t('sshImport.all')}</button>
                <button type="button" onClick={deselectAll} className="text-[var(--workspace-accent-text)] hover:underline">{t('sshImport.none')}</button>
              </div>
              <div className="overflow-hidden rounded-lg border border-[color:var(--workspace-border-soft)]">
                {entries.map((e, i) => (
                  <label key={i} className="flex cursor-pointer items-center gap-3 border-b border-[color:var(--workspace-border-soft)] px-3 py-2 text-sm transition-colors last:border-0 hover:bg-[var(--workspace-surface-800)]">
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggleEntry(i)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
                    <span className="w-32 shrink-0 truncate font-medium text-[var(--workspace-text-strong)]">{e.alias}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--workspace-text-muted)]">
                      {e.user ?? 'root'}@{e.hostName ?? e.alias}:{e.port ?? 22}
                    </span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${e.identityFile ? 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text)]' : 'border border-[color:var(--workspace-border-soft)] text-[var(--workspace-text-muted)]'}`}>{e.identityFile ? t('sshImport.key') : v3.password}</span>
                    {e.proxyJump && <span className="inline-flex max-w-40 shrink-0 items-center gap-1 truncate rounded border border-[color:var(--workspace-border-soft)] px-1.5 py-0.5 text-[10px] text-[var(--workspace-text-muted)]"><Route className="h-3 w-3 shrink-0" />ProxyJump {e.proxyJump}</span>}
                  </label>
                ))}
              </div>
              <p className="mt-3 flex items-start gap-1.5 text-xs text-[var(--workspace-text-muted)]"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />{v3.importHint}</p>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3">
          {!done && <button type="button" onClick={onClose} className="rounded-lg border border-[color:var(--workspace-border-soft)] px-4 py-2 text-sm transition-colors hover:bg-[var(--workspace-surface-800)]">
            {t('sshImport.cancel')}
          </button>}
          {done && <button type="button" onClick={onClose} className="rounded-lg bg-[color:var(--workspace-primary-500)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90">
            {t('sshImport.done')}
          </button>}
          {entries.length > 0 && !done && (
            <button
              type="button"
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
              className="flex items-center gap-2 rounded-lg bg-[color:var(--workspace-primary-500)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('sshImport.importBtn', { n: selected.size })}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
