import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'
import { parseSshConfig, createHost, type SshConfigEntry } from '@/lib/hosts'
import { FileDown, Check, Loader2, AlertCircle } from 'lucide-react'

interface SshImportDialogProps {
  vaultId?: string | null
  onClose: () => void
  onImported: () => void
}

export function SshImportDialog({ vaultId, onClose, onImported }: SshImportDialogProps) {
  const { t } = useT()
  const [entries, setEntries] = useState<SshConfigEntry[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importedCount, setImportedCount] = useState(0)

  useEffect(() => {
    parseSshConfig().then((res) => {
      setEntries(res)
      setSelected(new Set(res.map((_, i) => i)))
    }).catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false))
  }, [])

  const toggleEntry = (i: number) => {
    setSelected((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })
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
    setImporting(false)
    onImported()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="mx-4 w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center gap-2">
          <FileDown className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">{t('sshImport.title')}</h2>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('sshImport.empty')}</p>
        )}

        {!loading && entries.length > 0 && (
          <>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('sshImport.selected', { n: selected.size, total: entries.length })}</span>
              <button type="button" onClick={selectAll} className="text-primary hover:underline">{t('sshImport.all')}</button>
              <button type="button" onClick={deselectAll} className="text-primary hover:underline">{t('sshImport.none')}</button>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border/50 p-2">
              {entries.map((e, i) => (
                <label key={i} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/40">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggleEntry(i)} className="accent-primary" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{e.alias}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {e.user ?? 'root'}@{e.hostName ?? e.alias}:{e.port ?? 22}
                    </span>
                  </div>
                  {e.identityFile && <span className="text-[10px] text-muted-foreground">{t('sshImport.key')}</span>}
                </label>
              ))}
            </div>
          </>
        )}

        {importedCount > 0 && (
          <div className="mt-3 flex items-center gap-2 text-sm text-emerald-400">
            <Check className="h-4 w-4" />
            {t('sshImport.imported', { n: importedCount })}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-muted">
            {importedCount > 0 ? t('sshImport.done') : t('sshImport.cancel')}
          </button>
          {entries.length > 0 && importedCount === 0 && (
            <button
              type="button"
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/80 disabled:opacity-50"
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
