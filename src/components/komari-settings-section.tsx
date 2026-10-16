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
import { Eye, EyeOff, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

export function KomariSettingsSection() {
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
      setError('Unlock the active Vault before saving a Komari API Key.')
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
          <h3 className="flex items-center gap-2 font-semibold"><Server className="h-4 w-4" />Komari monitoring</h3>
          <p className="mt-1 text-xs text-muted-foreground">Connect a Komari Server for read-only node metrics. API Keys stay in the active Vault.</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Refresh Komari integrations" onClick={() => void load()} disabled={busy}>
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
          <Button variant="outline" size="sm" onClick={resetForm}>New</Button>
        </div>
      )}

      <div className="mt-4 space-y-3">
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-name">Name</label>
          <Input id="komari-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production Komari" className="mt-1" />
        </div>
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-endpoint">Server endpoint</label>
          <Input id="komari-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://komari.example" className="mt-1" />
        </div>
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-api-key">Server API Key</label>
          <div className="relative mt-1">
            <Input id="komari-api-key" type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selectedId ? 'Leave blank to keep the Vault key' : 'Paste API Key'} className="pr-10" />
            <button type="button" aria-label={showApiKey ? 'Hide API Key' : 'Show API Key'} onClick={() => setShowApiKey((value) => !value)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="rounded" />
          Enabled for read-only sync
        </label>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!unlocked && <p className="text-xs text-amber-600 dark:text-amber-400">Unlock the active Vault to save or update the API Key.</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy || !name.trim() || !endpoint.trim()}>{busy ? 'Saving…' : 'Save integration'}</Button>
          {selectedId && <Button variant="outline" size="sm" onClick={() => void remove()} disabled={busy}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove</Button>}
        </div>
      </div>
    </section>
  )
}
