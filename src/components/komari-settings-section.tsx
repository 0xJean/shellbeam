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
import { KomariApiError, verifyKomariConnection, type KomariClient } from '@/lib/komari'
import { listHosts, type HostProfile } from '@/lib/hosts'
import { vaultStatus } from '@/lib/vault'
import { komariOnboardingCopy } from '@/lib/locales/komari-onboarding'
import { settingsNavigationCopy } from '@/lib/locales/settings-navigation'
import { KomariAdministrationPanel } from './komari-administration-panel'
import { KomariMappingsPanel } from './komari-mappings-panel'
import { cancelMobileKomariConsole, komariConsoleMode, komariConsoleUrl, openMobileKomariConsole, prepareMobileKomariConsole } from '@/lib/komari-console'
import { ExternalLink, Eye, EyeOff, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

function integrationVersion(integration: KomariIntegration | null | undefined): string {
  return JSON.stringify(integration ? [integration.vaultId, integration.id, integration.endpoint, integration.credentialRef, integration.updatedAt, integration.enabled, integration.name] : null)
}

export function KomariSettingsSection() {
  const { activeVaultId } = useVault()
  // Vault changes remount form and console state immediately. Old requests
  // cannot populate the new Vault, even when integration IDs are identical.
  return <VaultKomariSettingsSection key={activeVaultId} vaultId={activeVaultId} />
}

function VaultKomariSettingsSection({ vaultId }: { vaultId: string }) {
  const { t, locale } = useT()
  const copy = komariOnboardingCopy[locale]
  const navigation = settingsNavigationCopy[locale]
  const { vaultStatusState, handleSaveSecret, handleRevealSecret, captureVaultScope } = useVault()
  const [integrations, setIntegrations] = useState<KomariIntegration[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const [error, setError] = useState('')
  const [mappingState, setMappingState] = useState({ busy: true, unmapped: 0, unsaved: false, failed: false })
  const [step, setStep] = useState<'connection' | 'mapping' | 'complete'>('connection')
  const [dirty, setDirty] = useState(false)
  const [verifiedNodes, setVerifiedNodes] = useState<KomariClient[] | null>(null)
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [verifying, setVerifying] = useState(false)
  const [verificationError, setVerificationError] = useState('')
  const verificationSequence = useRef(0)
  const unlockedRef = useRef(false)
  const unlockSession = useRef({ unlocked: false })
  const [administration, setAdministration] = useState<{ id: string; name: string; url: string; sequence: number } | null>(null)
  const [consoleBusy, setConsoleBusy] = useState(false)
  const [consoleError, setConsoleError] = useState<'invalid-endpoint' | 'open-failed' | 'locked' | null>(null)
  const alive = useRef(true)
  const loadSequence = useRef(0)
  const consoleSequence = useRef(0)
  const mobileRequest = useRef<string | null>(null)
  const selected = useRef<string | null>(null)
  const selectedConfiguration = useRef<KomariIntegration | null>(null)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const savedFormIntegrationId = useRef<string | null>(null)
  const unlocked = vaultStatusState?.unlocked === true
  unlockedRef.current = unlocked
  if (unlockSession.current.unlocked !== unlocked) unlockSession.current = { unlocked }
  const savedIntegration = integrations.find((item) => item.vaultId === vaultId && item.id === selectedId)

  const invalidateConsole = useCallback(() => {
    consoleSequence.current += 1
    setAdministration(null)
    setConsoleBusy(false)
    const requestId = mobileRequest.current
    mobileRequest.current = null
    // The native token remains cancellable inside the actual platform queue.
    // This cleanup never opens a browser, and expired tokens also fail closed.
    if (requestId) void cancelMobileKomariConsole(requestId).catch(() => {})
  }, [])

  const resetVerification = useCallback(() => {
    verificationSequence.current += 1
    setVerifying(false)
    setVerificationError('')
    setVerifiedNodes(null)
    setStep('connection')
    setMappingState({ busy: true, unmapped: 0, unsaved: false, failed: false })
  }, [])

  const resetForm = useCallback(() => {
    setEditorOpen(false)
    setError('')
    resetVerification()
    setDirty(false)
    loadSequence.current += 1
    setSavedNotice(false)
    invalidateConsole()
    setConsoleBusy(false)
    selected.current = null
    selectedConfiguration.current = null
    savedFormIntegrationId.current = null
    setSelectedId(null)
    setName('')
    setEndpoint('')
    setApiKey('')
    setEnabled(true)
    setShowApiKey(false)
    setConsoleError(null)
  }, [invalidateConsole, resetVerification])

  const load = useCallback(async () => {
    if (!alive.current) return false
    const request = ++loadSequence.current
    try {
      setError('')
      const next = (await listKomariIntegrations(vaultId)).filter((item) => item.vaultId === vaultId)
      if (!alive.current || request !== loadSequence.current) return false
      const retained = next.find((item) => item.id === selected.current)
      if (retained) {
        const changed = integrationVersion(selectedConfiguration.current) !== integrationVersion(retained)
        // Invalidate before publishing new metadata: a reply for the previous
        // endpoint/key must never authenticate or seed mappings for this one.
        if (changed) {
          resetVerification()
          invalidateConsole()
          setSavedNotice(false)
          if (!dirtyRef.current) {
            setName(retained.name)
            setEndpoint(retained.endpoint)
            setEnabled(retained.enabled)
          }
        }
        selectedConfiguration.current = retained
        setIntegrations(next)
        return true
      }
      setIntegrations(next)
      const first = next[0]
      if (first) {
        resetVerification()
        setDirty(false)
        invalidateConsole()
        setConsoleBusy(false)
        selected.current = first.id
        selectedConfiguration.current = first
        setSelectedId(first.id)
        setName(first.name)
        setEndpoint(first.endpoint)
        setEnabled(first.enabled)
      } else resetForm()
      return true
    } catch (cause) {
      if (alive.current && request === loadSequence.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }, [vaultId, resetForm, invalidateConsole, resetVerification])

  useEffect(() => {
    alive.current = true
    if (unlocked) void load()
    return () => { alive.current = false; verificationSequence.current += 1; loadSequence.current += 1; invalidateConsole() }
  }, [load, invalidateConsole, unlocked])

  useEffect(() => {
    if (!unlocked) resetForm()
  }, [unlocked, resetForm])

  const selectIntegration = (integration: KomariIntegration) => {
    if (!unlocked || busy) return
    setEditorOpen(true)
    resetVerification()
    setDirty(false)
    loadSequence.current += 1
    setSavedNotice(false)
    invalidateConsole()
    setConsoleBusy(false)
    selected.current = integration.id
    selectedConfiguration.current = integration
    savedFormIntegrationId.current = null
    setSelectedId(integration.id)
    setName(integration.name)
    setEndpoint(integration.endpoint)
    setApiKey('')
    setEnabled(integration.enabled)
    setShowApiKey(false)
    setError('')
    setConsoleError(null)
  }

  const addIntegration = () => {
    if (!unlocked || busy) return
    resetForm()
    setEditorOpen(true)
  }

  const editForm = () => {
    resetVerification()
    setDirty(true)
    loadSequence.current += 1
    setSavedNotice(false)
  }

  const openConsole = async () => {
    if (!savedIntegration || !unlocked) return
    const integrationId = savedIntegration.id
    const version = integrationVersion(savedIntegration)
    const isCurrentVault = captureVaultScope()
    const request = ++consoleSequence.current
    const isCurrent = () => alive.current && unlockedRef.current && isCurrentVault() && consoleSequence.current === request && selected.current === integrationId && integrationVersion(selectedConfiguration.current) === version
    let url: string
    try { url = komariConsoleUrl(savedIntegration.endpoint) }
    catch { setConsoleError('invalid-endpoint'); return }
    let preparedMobile: string | null = null
    setConsoleBusy(true)
    setConsoleError(null)
    try {
      const mode = await komariConsoleMode()
      if (!isCurrent()) return
      if (mode === 'mobile') {
        preparedMobile = await prepareMobileKomariConsole(vaultId, integrationId)
        // A prepare reply may arrive after selection/unmount, before we knew its
        // token. Cancel that late token instead of ever sending an open request.
        if (!isCurrent()) { await cancelMobileKomariConsole(preparedMobile); preparedMobile = null; return }
        mobileRequest.current = preparedMobile
        await openMobileKomariConsole(preparedMobile)
        return
      }
      // Context status may still describe the previously selected Vault while
      // its refresh is pending. Query the explicit native Vault identity;
      // browser opening must not borrow that earlier unlocked status.
      const status = await vaultStatus(vaultId)
      if (!isCurrent()) return
      if (status?.unlocked !== true) throw new Error('VAULT_LOCKED')
      setAdministration({ id: integrationId, name: savedIntegration.name, url, sequence: request })
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : cause
      if (isCurrent()) setConsoleError(code === 'VAULT_LOCKED' ? 'locked' : code === 'KOMARI_CONSOLE_INVALID_ENDPOINT' ? 'invalid-endpoint' : 'open-failed')
    } finally {
      if (preparedMobile) {
        if (mobileRequest.current === preparedMobile) mobileRequest.current = null
        try { await cancelMobileKomariConsole(preparedMobile) } catch { /* Native TTL also bounds abandoned tokens. */ }
      }
      if (isCurrent()) setConsoleBusy(false)
    }
  }

  const save = async () => {
    if (!alive.current) return
    if (!unlocked) {
      setError(t('settings.komariUnlockToSave'))
      return
    }
    resetVerification()
    invalidateConsole()
    setConsoleBusy(false)
    setConsoleError(null)
    setBusy(true)
    setSavedNotice(false)
    setError('')
    const capturedVault = captureVaultScope()
    const capturedUnlock = unlockSession.current
    const isCurrentVault = () => capturedVault() && capturedUnlock === unlockSession.current && capturedUnlock.unlocked
    try {
      if (!isCurrentVault()) return
      const integrationId = selectedId ?? savedFormIntegrationId.current ?? crypto.randomUUID()
      const saved = await upsertKomariIntegration({
        id: integrationId,
        vaultId,
        name,
        endpoint,
        ...(savedIntegration?.credentialRef ? { credentialRef: savedIntegration.credentialRef } : {}),
        enabled,
      })
      if (!isCurrentVault()) return
      // Metadata may already exist when the separate Vault write fails. Keep
      // this form's identity so retry updates it instead of creating a copy.
      if (alive.current) savedFormIntegrationId.current = saved.id
      const credentialRef = saved.credentialRef || komariCredentialKey(saved.id)
      if (apiKey.trim()) {
        try {
          await handleSaveSecret(credentialRef, apiKey.trim())
        } catch {
          if (alive.current && isCurrentVault()) {
            setShowApiKey(false)
            setError(t('settings.komariCredentialSaveFailed'))
          }
          return
        }
        if (!isCurrentVault()) return
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
        if (!isCurrentVault()) return
      }
      // A page change only ends UI updates. Finish the requested credential
      // save while its original Vault generation is still current.
      if (!alive.current) return
      setShowApiKey(false)
      setApiKey('')
      const reloaded = await load()
      if (reloaded && alive.current && isCurrentVault()) { setSavedNotice(true); setDirty(false) }
    } catch (cause) {
      if (alive.current && isCurrentVault()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const verify = async () => {
    if (!savedIntegration || !unlocked || dirty || busy) return
    const request = ++verificationSequence.current
    const version = integrationVersion(savedIntegration)
    const isCurrentVault = captureVaultScope()
    const current = () => alive.current && unlockedRef.current && isCurrentVault() && request === verificationSequence.current && integrationVersion(selectedConfiguration.current) === version
    setVerifying(true); setVerificationError(''); setVerifiedNodes(null)
    setMappingState({ busy: true, unmapped: 0, unsaved: false, failed: false })
    try {
      let token: string | null
      try { token = await handleRevealSecret(savedIntegration.credentialRef) }
      catch { if (current()) setVerificationError(copy.credentialFailed); return }
      if (!current()) return
      if (!token?.trim()) { setVerificationError(copy.missingKey); return }
      const nodes = await verifyKomariConnection({ endpoint: savedIntegration.endpoint, token })
      if (!current()) return
      const profiles = await listHosts(vaultId)
      if (!current()) return
      setHosts(profiles.filter((host) => !host.vaultId || host.vaultId === vaultId))
      setVerifiedNodes(nodes); setStep('mapping')
    } catch (cause) {
      if (!current()) return
      const code = cause instanceof KomariApiError ? cause.code : null
      setVerificationError(code === 'permission' ? copy.permission : code === 'timeout' ? copy.timeout : code === 'unavailable' ? copy.unavailable : copy.failed)
    } finally { if (current()) setVerifying(false) }
  }

  const manageMappings = async () => {
    if (!savedIntegration || !unlocked || dirty || busy) return
    const request = ++verificationSequence.current
    const isCurrentVault = captureVaultScope()
    setMappingState({ busy: true, unmapped: 0, unsaved: false, failed: false })
    try {
      const profiles = await listHosts(vaultId)
      if (!alive.current || !unlockedRef.current || !isCurrentVault() || request !== verificationSequence.current) return
      setHosts(profiles.filter((host) => !host.vaultId || host.vaultId === vaultId))
      setStep('mapping')
    } catch { if (alive.current && isCurrentVault() && request === verificationSequence.current) setVerificationError(copy.failed) }
  }

  const remove = async () => {
    if (!alive.current || !selectedId) return
    resetVerification()
    invalidateConsole()
    setConsoleBusy(false)
    setConsoleError(null)
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
    <section className="rounded-lg border p-4" data-testid="komari-settings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold"><Server className="h-4 w-4" />{copy.title} · Komari</h3>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{navigation.optionalKomari}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('settings.komariRefresh')} onClick={() => void load()} disabled={busy || !unlocked}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {integrations.length > 0 && (
        <div className="mt-4 space-y-2" aria-label={navigation.savedSources}>
          <p className="text-xs text-muted-foreground">{navigation.editSource}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {integrations.map((integration) => (
              <button key={integration.id} type="button" aria-label={integration.name}
                onClick={() => selectIntegration(integration)} disabled={busy || !unlocked}
                className={`min-w-0 rounded-md border px-3 py-2 text-left ${editorOpen && selectedId === integration.id ? 'border-primary bg-primary/10' : 'border-border'}`}>
                <span className="block truncate text-sm font-medium">{integration.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{integration.enabled ? navigation.enabled : navigation.paused}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={addIntegration} disabled={busy || !unlocked}>{navigation.addSource}</Button>
        {editorOpen && <Button variant="ghost" size="sm" onClick={resetForm} disabled={busy}>{navigation.closeEditor}</Button>}
      </div>
      {!unlocked && <p className="mt-3 text-xs text-muted-foreground">{t('settings.komariUnlockHint')}</p>}
      {!editorOpen && error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
      {editorOpen && unlocked && <div data-testid="komari-connection-editor">
      <ol className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label={copy.title}>
        {(['connection', 'mapping', 'complete'] as const).map((item) => <li key={item} aria-current={step === item ? 'step' : undefined} className={step === item ? 'font-semibold text-foreground' : undefined}>{copy[item]}</li>)}
      </ol>
      {step === 'connection' && <div className="mt-4 space-y-3">
        <p className="text-xs text-muted-foreground">{copy.connectHint}</p>
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-name">{t('settings.komariName')}</label>
          <Input id="komari-name" value={name} onChange={(event) => { editForm(); setName(event.target.value) }} disabled={busy} placeholder={t('settings.komariNamePlaceholder')} className="mt-1" />
        </div>
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-endpoint">{t('settings.komariEndpoint')}</label>
          <Input id="komari-endpoint" value={endpoint} onChange={(event) => { editForm(); setEndpoint(event.target.value) }} disabled={busy} placeholder={t('settings.komariEndpointPlaceholder')} className="mt-1" />
        </div>
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="komari-api-key">{t('settings.komariApiKey')}</label>
          <div className="relative mt-1">
            <Input id="komari-api-key" type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={(event) => { editForm(); setApiKey(event.target.value) }} disabled={busy} placeholder={selectedId ? t('settings.komariApiKeyKeep') : t('settings.komariApiKeyPaste')} className="pr-10" />
            <button type="button" aria-label={showApiKey ? t('settings.komariHideApiKey') : t('settings.komariShowApiKey')} onClick={() => setShowApiKey((value) => !value)} disabled={busy} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.komariApiKeyHelp')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => { editForm(); setEnabled(event.target.checked) }} disabled={busy} className="rounded" />
          {t('settings.komariEnabled')}
        </label>
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        {savedNotice && <p role="status" className="text-xs text-muted-foreground">{t('settings.komariSaved')}</p>}
        {!unlocked && <p className="text-xs text-amber-600 dark:text-amber-400">{t('settings.komariUnlockHint')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy || !name.trim() || !endpoint.trim()}>{busy ? t('settings.komariSaving') : t('settings.komariSave')}</Button>
          {selectedId && <Button variant="outline" size="sm" onClick={() => void remove()} disabled={busy}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t('settings.komariRemove')}</Button>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void verify()} disabled={busy || verifying || !unlocked || !savedIntegration || dirty}>{verifying ? copy.verifying : copy.verify}</Button>
          {savedIntegration && <Button variant="ghost" size="sm" onClick={() => void manageMappings()} disabled={busy || verifying || !unlocked || dirty}>{copy.manage}</Button>}
        </div>
        {dirty && <p className="text-xs text-muted-foreground">{copy.saveFirst}</p>}
        {verificationError && <p role="alert" className="text-xs text-red-500">{verificationError}</p>}
      </div>}
      {step === 'mapping' && savedIntegration && <div className="mt-4 space-y-3">
        {verifiedNodes && <p role="status" className="text-sm">{copy.verified} · {copy.nodes}: {verifiedNodes.length}</p>}
        {verifiedNodes?.length === 0 && <p className="text-xs text-muted-foreground">{copy.empty}</p>}
        <KomariMappingsPanel key={`${vaultId}:${savedIntegration.id}`} activeVaultId={vaultId} hosts={hosts} vaultUnlocked={unlocked} onLoadVaultSecret={handleRevealSecret} integrationId={savedIntegration.id} initiallyOpen discoveredNodes={verifiedNodes ?? undefined} onStateChange={setMappingState} onHostImported={host => setHosts(current => current.some(h => h.id === host.id) ? current : [...current, host])} />
        {!mappingState.busy && <p className="text-xs text-muted-foreground">{copy.unmapped}: {mappingState.unmapped}</p>}
        {mappingState.unsaved && <p className="text-xs text-amber-600">{copy.unsavedMappings}</p>}
        <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setStep('connection')}>{copy.back}</Button>
          {verifiedNodes && <Button size="sm" disabled={mappingState.busy || mappingState.unsaved || mappingState.failed} onClick={() => setStep('complete')}>{copy.finish}</Button>}</div>
      </div>}
      {step === 'complete' && <div className="mt-4 space-y-3">
        <h4 role="status" className="font-medium">{copy.ready}</h4><p className="text-sm text-muted-foreground">{copy.readyHint}</p>
        {verifiedNodes?.length === 0 && <p className="text-xs text-muted-foreground">{copy.empty}</p>}
        <p className="text-xs text-muted-foreground">{copy.unmapped}: {mappingState.unmapped}</p>
        {!enabled && <p className="text-xs text-muted-foreground">{copy.disabled}</p>}
        <Button variant="outline" size="sm" onClick={() => setStep('connection')}>{copy.back}</Button>
      </div>}
      <details className="mt-4 border-t pt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">{copy.advanced}</summary>
        <p className="my-2 text-xs text-muted-foreground">{copy.advancedHint}</p>
        <p className="mb-2 text-xs text-muted-foreground">{copy.nativeHint}</p>
        <Button variant="outline" size="sm" onClick={() => void openConsole()} disabled={busy || consoleBusy || !savedIntegration || !unlocked}><ExternalLink className="mr-1.5 h-3.5 w-3.5" />{consoleBusy ? t('settings.komariConsoleOpening') : copy.open}</Button>
        {consoleError && <p role="alert" className="text-xs text-red-500">{t(consoleError === 'invalid-endpoint' ? 'settings.komariConsoleInvalidEndpoint' : consoleError === 'locked' ? 'settings.komariConsoleUnlock' : 'settings.komariConsoleOpenFailed')}</p>}
      </details>
      </div>}
      {administration && unlocked && <KomariAdministrationPanel vaultId={vaultId} integrationId={administration.id} name={administration.name} url={administration.url} onClose={invalidateConsole} onError={() => { if (alive.current && unlockedRef.current && consoleSequence.current === administration.sequence) { invalidateConsole(); setConsoleError('open-failed') } }} />}
    </section>
  )
}
