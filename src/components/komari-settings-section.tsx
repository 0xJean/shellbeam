import { useVault } from '@/contexts/vault-context'
import {
  deleteKomariIntegration,
  komariCredentialKey,
  listKomariIntegrations,
  upsertKomariIntegration,
  type KomariIntegration,
} from '@/lib/komari-config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import { closeBrowserWindow, loadBrowserSource, openBrowserWindow } from '@/lib/browser'
import { komariConsoleUrl } from '@/lib/komari-console'
import { ExternalLink, Eye, EyeOff, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export function KomariSettingsSection() {
  const { activeVaultId } = useVault()
  // Vault changes remount form and console state immediately. Old requests
  // cannot populate the new Vault, even when integration IDs are identical.
  return <VaultKomariSettingsSection key={activeVaultId} vaultId={activeVaultId} />
}

function VaultKomariSettingsSection({ vaultId }: { vaultId: string }) {
  const { t } = useT()
  const { vaultStatusState, handleSaveSecret } = useVault()
  const [integrations, setIntegrations] = useState<KomariIntegration[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [consoleBusy, setConsoleBusy] = useState(false)
  const [consoleError, setConsoleError] = useState<'invalid-endpoint' | 'open-failed' | null>(null)
  const alive = useRef(true)
  const loadSequence = useRef(0)
  const selected = useRef<string | null>(null)
  const unlocked = vaultStatusState?.unlocked === true
  const savedIntegration = integrations.find((item) => item.vaultId === vaultId && item.id === selectedId)

  const resetForm = useCallback(() => {
    selected.current = null
    setSelectedId(null)
    setName('')
    setEndpoint('')
    setApiKey('')
    setEnabled(true)
    setShowApiKey(false)
    setConsoleError(null)
  }, [])

  const load = useCallback(async () => {
    if (!alive.current) return
    const request = ++loadSequence.current
    try {
      setError('')
      const next = (await listKomariIntegrations(vaultId)).filter((item) => item.vaultId === vaultId)
      if (!alive.current || request !== loadSequence.current) return
      setIntegrations(next)
      if (next.some((item) => item.id === selected.current)) return
      const first = next[0]
      if (first) {
        selected.current = first.id
        setSelectedId(first.id)
        setName(first.name)
        setEndpoint(first.endpoint)
        setEnabled(first.enabled)
      } else resetForm()
    } catch (cause) {
      if (alive.current && request === loadSequence.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [vaultId, resetForm])

  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false; loadSequence.current += 1 }
  }, [load])

  const selectIntegration = (integration: KomariIntegration) => {
    selected.current = integration.id
    setSelectedId(integration.id)
    setName(integration.name)
    setEndpoint(integration.endpoint)
    setApiKey('')
    setEnabled(integration.enabled)
    setShowApiKey(false)
    setError('')
    setConsoleError(null)
  }

  const openConsole = async () => {
    if (!savedIntegration) return
    let url: string
    try { url = komariConsoleUrl(savedIntegration.endpoint) }
    catch { setConsoleError('invalid-endpoint'); return }
    const browserId = `komari-console-${crypto.randomUUID()}`
    const sessionId = browserId
    const closeNewWindow = async () => { try { await closeBrowserWindow(browserId, sessionId) } catch { /* Preserve the fixed opening error. */ } }
    setConsoleBusy(true)
    setConsoleError(null)
    try {
      await openBrowserWindow({ browserId, sessionId })
      if (!alive.current) { await closeNewWindow(); return }
      await loadBrowserSource({ browserId, sessionId, source: { kind: 'url', url } })
      if (!alive.current) await closeNewWindow()
    } catch {
      await closeNewWindow()
      if (alive.current) setConsoleError('open-failed')
    } finally {
      if (alive.current) setConsoleBusy(false)
    }
  }

  const save = async () => {
    if (!alive.current) return
    if (!unlocked) {
      setError(t('settings.komariUnlockToSave'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const integrationId = selectedId ?? crypto.randomUUID()
      const saved = await upsertKomariIntegration({
        id: integrationId,
        vaultId,
        name,
        endpoint,
        enabled,
      })
      if (!alive.current) return
      const credentialRef = saved.credentialRef || komariCredentialKey(saved.id)
      if (apiKey.trim()) {
        await handleSaveSecret(credentialRef, apiKey.trim())
        if (!alive.current) return
      }
      if (credentialRef !== saved.credentialRef) {
        await upsertKomariIntegration({
          id: saved.id,
          vaultId,
          name: saved.name,
          endpoint: saved.endpoint,
          credentialRef,
          enabled: saved.enabled,
        })
        if (!alive.current) return
      }
      setApiKey('')
      await load()
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const remove = async () => {
    if (!alive.current || !selectedId) return
    setBusy(true)
    setError('')
    try {
      await deleteKomariIntegration(selectedId, vaultId)
      if (!alive.current) return
      resetForm()
      await load()
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold"><Server className="h-4 w-4" />{t('settings.komariTitle')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.komariDescription')}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('settings.komariRefresh')} onClick={() => void load()} disabled={busy}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {integrations.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {integrations.map((integration) => (
            <button key={integration.id} type="button" onClick={() => selectIntegration(integration)}
              className={`rounded-md border px-3 py-1.5 text-xs ${selectedId === integration.id ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}>
              {integration.name}
            </button>
          ))}
          <Button variant="outline" size="sm" onClick={resetForm}>{t('settings.komariNew')}</Button>
        </div>
      )}

      <div className="mt-4 space-y-3">
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-name">{t('settings.komariName')}</label>
          <Input id="komari-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('settings.komariNamePlaceholder')} className="mt-1" />
        </div>
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-endpoint">{t('settings.komariEndpoint')}</label>
          <Input id="komari-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={t('settings.komariEndpointPlaceholder')} className="mt-1" />
        </div>
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-api-key">{t('settings.komariApiKey')}</label>
          <div className="relative mt-1">
            <Input id="komari-api-key" type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selectedId ? t('settings.komariApiKeyKeep') : t('settings.komariApiKeyPaste')} className="pr-10" />
            <button type="button" aria-label={showApiKey ? t('settings.komariHideApiKey') : t('settings.komariShowApiKey')} onClick={() => setShowApiKey((value) => !value)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="rounded" />
          {t('settings.komariEnabled')}
        </label>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!unlocked && <p className="text-xs text-amber-600 dark:text-amber-400">{t('settings.komariUnlockHint')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy || !name.trim() || !endpoint.trim()}>{busy ? t('settings.komariSaving') : t('settings.komariSave')}</Button>
          {selectedId && <Button variant="outline" size="sm" onClick={() => void remove()} disabled={busy}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t('settings.komariRemove')}</Button>}
          <Button variant="outline" size="sm" onClick={() => void openConsole()} disabled={busy || consoleBusy || !savedIntegration}><ExternalLink className="mr-1.5 h-3.5 w-3.5" />{t(consoleBusy ? 'settings.komariConsoleOpening' : 'settings.komariConsoleOpen')}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.komariConsoleHint')}</p>
        {consoleError && <p role="alert" className="text-xs text-red-500">{t(consoleError === 'invalid-endpoint' ? 'settings.komariConsoleInvalidEndpoint' : 'settings.komariConsoleOpenFailed')}</p>}
      </div>
    </section>
  )
}
