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
import { Eye, EyeOff, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

export function KomariSettingsSection() {
  const { t } = useT()
  const { activeVaultId, vaultStatusState, handleSaveSecret } = useVault()
  const [integrations, setIntegrations] = useState<KomariIntegration[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unlocked = vaultStatusState?.unlocked === true

  const load = async () => {
    try {
      setError('')
      const next = await listKomariIntegrations(activeVaultId)
      setIntegrations(next)
      if (selectedId) {
        const selected = next.find((item) => item.id === selectedId)
        if (selected) return
      }
      const first = next[0]
      if (first) {
        setSelectedId(first.id)
        setName(first.name)
        setEndpoint(first.endpoint)
        setEnabled(first.enabled)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => { void load() }, [activeVaultId])

  const resetForm = () => {
    setSelectedId(null)
    setName('')
    setEndpoint('')
    setApiKey('')
    setEnabled(true)
    setShowApiKey(false)
  }

  const selectIntegration = (integration: KomariIntegration) => {
    setSelectedId(integration.id)
    setName(integration.name)
    setEndpoint(integration.endpoint)
    setApiKey('')
    setEnabled(integration.enabled)
    setShowApiKey(false)
    setError('')
  }

  const save = async () => {
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
        vaultId: activeVaultId,
        name,
        endpoint,
        enabled,
      })
      const credentialRef = saved.credentialRef || komariCredentialKey(saved.id)
      if (apiKey.trim()) await handleSaveSecret(credentialRef, apiKey.trim())
      if (credentialRef !== saved.credentialRef) {
        await upsertKomariIntegration({
          id: saved.id,
          vaultId: activeVaultId,
          name: saved.name,
          endpoint: saved.endpoint,
          credentialRef,
          enabled: saved.enabled,
        })
      }
      setApiKey('')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!selectedId) return
    setBusy(true)
    setError('')
    try {
      await deleteKomariIntegration(selectedId, activeVaultId)
      resetForm()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
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
        </div>
      </div>
    </section>
  )
}
