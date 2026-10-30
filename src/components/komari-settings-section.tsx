import { monitoringDiagnostic } from '@/lib/monitoring-presentation'
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
import { komariOnboardingCopy } from '@/lib/locales/komari-onboarding'
import { settingsNavigationCopy } from '@/lib/locales/settings-navigation'
import { MonitoringServicePanel } from './monitoring-service-panel'
import { monitoringServiceCopy } from '@/lib/locales/monitoring-service'
import { closeServiceScope, serviceRequest, serviceScope, serviceErrorCode, type ServiceScope } from '@/lib/monitoring-service'
import { requestUserDecision } from '@/lib/user-confirmation'
import { KomariMappingsPanel } from './komari-mappings-panel'
import { monitorSettingsCopy } from '@/lib/locales/monitor-settings-v3'
import { Banner, CardHead, Note, StatusDot, checkboxClass, dangerButton, fieldLabel, mutedText, primaryButton, softBorder } from './monitor-settings-ui'
import { cn } from '@/lib/utils'
import { Activity, ArrowRight, Check, CircleCheck, Eye, EyeOff, Info, KeyRound, Lock, Plus, PlugZap, Radar, RefreshCw, ServerOff, ShieldCheck, Sparkles, Trash2, TriangleAlert, UserCog } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

function integrationVersion(integration: KomariIntegration | null | undefined): string {
  return JSON.stringify(integration ? [integration.vaultId, integration.id, integration.endpoint, integration.credentialRef, integration.updatedAt, integration.enabled, integration.name] : null)
}

interface KomariSettingsSectionProps {
  /** When set, server configuration moves to its own page instead of rendering inline. */
  onOpenServiceConfiguration?: (integrationId: string) => void
  onIntegrationsChange?: (vaultId: string, integrations: KomariIntegration[]) => void
}

export function KomariSettingsSection(props: KomariSettingsSectionProps) {
  const { activeVaultId } = useVault()
  // Vault changes remount form and console state immediately. Old requests
  // cannot populate the new Vault, even when integration IDs are identical.
  return <VaultKomariSettingsSection key={activeVaultId} vaultId={activeVaultId} {...props} />
}

function VaultKomariSettingsSection({ vaultId, onOpenServiceConfiguration, onIntegrationsChange }: KomariSettingsSectionProps & { vaultId: string }) {
  const { t, locale } = useT()
  const copy = komariOnboardingCopy[locale]
  const navigation = settingsNavigationCopy[locale]
  const v3 = monitorSettingsCopy[locale]
  const integrationsListener = useRef(onIntegrationsChange)
  useEffect(() => { integrationsListener.current = onIntegrationsChange })
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
  const accessScope = useRef<ServiceScope | null>(null)
  const access = monitoringServiceCopy[locale]
  const [authMode, setAuthMode] = useState<'key' | 'authorize' | 'initialize'>('key')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [twoFactor, setTwoFactor] = useState('')
  const [metricDsn, setMetricDsn] = useState('./data/metrics.db')
  const alive = useRef(true)
  const loadSequence = useRef(0)
  const selected = useRef<string | null>(null)
  const selectedConfiguration = useRef<KomariIntegration | null>(null)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const savedFormIntegrationId = useRef<string | null>(null)
  const unlocked = vaultStatusState?.unlocked === true
  unlockedRef.current = unlocked
  if (unlockSession.current.unlocked !== unlocked) unlockSession.current = { unlocked }
  const savedIntegration = integrations.find((item) => item.vaultId === vaultId && item.id === selectedId)

  const resetVerification = useCallback(() => {
    verificationSequence.current += 1
    if (accessScope.current) { void closeServiceScope(accessScope.current).catch(() => {}); accessScope.current = null }
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
    selected.current = null
    selectedConfiguration.current = null
    savedFormIntegrationId.current = null
    setSelectedId(null)
    setName('')
    setEndpoint('')
    setApiKey('')
    setAuthMode('key'); setUsername(''); setPassword(''); setTwoFactor('')
    setEnabled(true)
    setShowApiKey(false)
  }, [resetVerification])

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
          setSavedNotice(false)
          if (!dirtyRef.current) {
            setName(retained.name)
            setEndpoint(retained.endpoint)
            setEnabled(retained.enabled)
          }
        }
        selectedConfiguration.current = retained
        setIntegrations(next)
        integrationsListener.current?.(vaultId, next)
        return true
      }
      setIntegrations(next)
      integrationsListener.current?.(vaultId, next)
      const first = next[0]
      if (first) {
        resetVerification()
        setDirty(false)
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
  }, [vaultId, resetForm, resetVerification])

  useEffect(() => {
    alive.current = true
    if (unlocked) void load()
    return () => { if (accessScope.current) { void closeServiceScope(accessScope.current).catch(() => {}); accessScope.current = null }; alive.current = false; verificationSequence.current += 1; loadSequence.current += 1 }
  }, [load, unlocked])

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
    selected.current = integration.id
    selectedConfiguration.current = integration
    savedFormIntegrationId.current = null
    setSelectedId(integration.id)
    setName(integration.name)
    setEndpoint(integration.endpoint)
    setApiKey('')
    setAuthMode('key'); setUsername(''); setPassword(''); setTwoFactor('')
    setEnabled(integration.enabled)
    setShowApiKey(false)
    setError('')
  }

  const addIntegration = () => {
    if (!unlocked || busy) return
    resetForm()
    setAuthMode('authorize')
    setEditorOpen(true)
  }

  const editForm = () => {
    resetVerification()
    setDirty(true)
    loadSequence.current += 1
    setSavedNotice(false)
  }

  const save = async () => {
    if (!alive.current) return
    if (!unlocked) {
      setError(t('settings.komariUnlockToSave'))
      return
    }
    resetVerification()
    setBusy(true)
    setSavedNotice(false)
    setError('')
    const capturedVault = captureVaultScope()
    const capturedUnlock = unlockSession.current
    const isCurrentVault = () => capturedVault() && capturedUnlock === unlockSession.current && capturedUnlock.unlocked
    try {
      if (!isCurrentVault()) return
      if (authMode === 'initialize') {
        const answer = await requestUserDecision({ vaultId, message: `${name} · ${endpoint}\n${access.initConfirm}`, risk: 'high', isCurrent: isCurrentVault })
        if (!answer.accepted || answer.isCurrent?.() === false || !isCurrentVault()) return
      }
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
      if (authMode !== 'key') {
        const scope = await serviceScope(saved)
        accessScope.current = scope
        try {
          if (!isCurrentVault() || !alive.current) return
          await serviceRequest(scope, authMode, { username, password, twoFactor, metricDsn, confirmed: authMode === 'initialize' })
        } finally { await closeServiceScope(scope).catch(() => {}); if (accessScope.current === scope) accessScope.current = null }
        if (!isCurrentVault()) return
        setPassword(''); setTwoFactor('')
      } else if (apiKey.trim()) {
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
      if (reloaded && alive.current && isCurrentVault()) {
        setSavedNotice(true); setDirty(false)
        if (authMode !== 'key') {
          const token = await handleRevealSecret(credentialRef)
          if (!isCurrentVault() || !alive.current || !token) return
          const nodes = await verifyKomariConnection({ endpoint: saved.endpoint, token })
          const profiles = await listHosts(vaultId)
          if (!isCurrentVault() || !alive.current) return
          setVerifiedNodes(nodes); setHosts(profiles.filter(h => !h.vaultId || h.vaultId === vaultId)); setStep('mapping')
        }
      }
    } catch (cause) {
      if (alive.current && isCurrentVault()) { const code = serviceErrorCode(cause); setError(code === 'MONITORING_SHELLBEAM_REQUIRED' ? access.ownServer : code === 'MONITORING_IDENTITY_UNAVAILABLE' ? access.identityUnavailable : authMode === 'key' ? (cause instanceof Error ? cause.message : String(cause)) : code.includes('PERMISSION') ? access.permission : code.includes('UNSUPPORTED') ? access.unsupported : code.includes('INVALID') ? access.invalid : access.network) }
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

  const steps = ['connection', 'mapping', 'complete'] as const
  const stepIndex = steps.indexOf(step)
  const modes = [['authorize', access.account, v3.accountMode, UserCog], ['key', access.key, v3.keyMode, KeyRound], ['initialize', access.initialize, v3.initializeMode, Sparkles]] as const
  const openServer = onOpenServiceConfiguration && savedIntegration && !dirty ? () => onOpenServiceConfiguration(savedIntegration.id) : null

  return (
    <section className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)] lg:items-start" data-testid="komari-settings">
      <div className="min-w-0 space-y-2.5">
        <div className="sb-card overflow-hidden">
          <CardHead title={v3.servicesTitle} hint={v3.servicesHint}>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('settings.komariRefresh')} onClick={() => void load()} disabled={busy || !unlocked}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </CardHead>
          {integrations.length > 0 ? (
            <div aria-label={navigation.savedSources}>
              {integrations.map((integration) => {
                const active = editorOpen && selectedId === integration.id
                return <button key={integration.id} type="button" aria-label={integration.name}
                  onClick={() => selectIntegration(integration)} disabled={busy || !unlocked}
                  className={cn('flex w-full min-w-0 items-center gap-3 border-b border-l-2 px-3 py-2.5 text-left transition-colors disabled:opacity-60', softBorder, active ? 'border-l-[color:var(--workspace-primary-500)] bg-[color:var(--workspace-accent-subtle)]' : 'border-l-transparent hover:bg-[color:var(--workspace-surface-800)]')}>
                  <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', integration.enabled ? 'bg-[color:var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good)]' : 'bg-[color:var(--workspace-surface-700)] text-[color:var(--workspace-text-muted)]')}>
                    {integration.enabled ? <Activity className="h-4 w-4" /> : <ServerOff className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[color:var(--workspace-text-strong)]">{integration.name}</span>
                    <span className={cn('block truncate text-xs', mutedText)}>{integration.endpoint}</span>
                  </span>
                  <StatusDot tone={integration.enabled ? 'good' : undefined}>{integration.enabled ? navigation.enabled : navigation.paused}</StatusDot>
                </button>
              })}
            </div>
          ) : unlocked && <p className={cn('px-4 py-6 text-center text-xs', mutedText)}>{v3.noServices}</p>}
          <div className="space-y-1.5 p-3">
            <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={addIntegration} disabled={busy || !unlocked}><Plus className="h-3.5 w-3.5" />{navigation.addSource}</Button>
            {editorOpen && <Button variant="ghost" size="sm" className="w-full" onClick={resetForm} disabled={busy}>{navigation.closeEditor}</Button>}
          </div>
        </div>
        <Note icon={ShieldCheck}>{v3.ownServerNote}</Note>
        <Note>{navigation.optionalKomari}</Note>
        {unlocked ? <Note icon={Lock}>{v3.lockedNote}</Note> : <Note icon={Lock} tone="warn">{t('settings.komariUnlockHint')}</Note>}
        {!editorOpen && error && <p role="alert" className="text-xs text-[color:var(--workspace-status-bad-text)]">{monitoringDiagnostic(error, locale)}</p>}
      </div>

      {editorOpen && unlocked ? <div className="sb-card min-w-0 overflow-hidden" data-testid="komari-connection-editor">
        <ol className={cn('flex flex-wrap items-center gap-2 border-b px-4 py-3 text-xs', softBorder)} aria-label={copy.title}>
          {steps.map((item, index) => {
            const current = step === item
            const done = index < stepIndex
            return <li key={item} aria-current={current ? 'step' : undefined} className="flex items-center gap-2">
              {index > 0 && <span aria-hidden="true" className="h-px w-6 bg-[color:var(--workspace-border-strong)]" />}
              <span aria-hidden="true" className={cn('grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold', current ? 'bg-[color:var(--workspace-primary-500)] text-white' : done ? 'bg-[color:var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' : 'border border-[color:var(--workspace-border-strong)] text-[color:var(--workspace-text-muted)]')}>{done ? <Check className="h-3 w-3" /> : index + 1}</span>
              <span className={current ? 'font-semibold text-[color:var(--workspace-text-strong)]' : mutedText}>{copy[item].replace(/^\d+\.\s*/, '')}</span>
            </li>
          })}
        </ol>
        {step === 'connection' && <>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <p className={cn('text-xs sm:col-span-2', mutedText)}>{copy.connectHint}</p>
            <div>
              <label className={fieldLabel} htmlFor="komari-name">{t('settings.komariName')}</label>
              <Input id="komari-name" value={name} onChange={(event) => { editForm(); setName(event.target.value) }} disabled={busy} placeholder={t('settings.komariNamePlaceholder')} className="mt-1" />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="komari-endpoint">{t('settings.komariEndpoint')}</label>
              <Input id="komari-endpoint" value={endpoint} onChange={(event) => { editForm(); setEndpoint(event.target.value) }} disabled={busy} placeholder={t('settings.komariEndpointPlaceholder')} className="mt-1 font-mono text-xs" />
            </div>
            <div className="sm:col-span-2" role="radiogroup" aria-label={access.access}>
              <div className={fieldLabel}>{access.access}</div>
              <div className="mt-1 grid gap-2 md:grid-cols-3">
                {modes.map(([mode, label, hint, Icon]) => <label key={mode} className={cn('flex cursor-pointer gap-2.5 rounded-lg border p-3 text-xs transition-colors focus-within:ring-2 focus-within:ring-[hsl(var(--primary))]', authMode === mode ? 'border-[color:var(--workspace-primary-500)] bg-[color:var(--workspace-accent-subtle)]' : cn(softBorder, 'hover:bg-[color:var(--workspace-surface-800)]'), busy && 'cursor-not-allowed opacity-60')}>
                  <input type="radio" name={`komari-access-${vaultId}`} value={mode} aria-label={label} checked={authMode === mode} disabled={busy} className="sr-only"
                    onChange={() => { editForm(); setAuthMode(mode); setApiKey(''); setPassword(''); setTwoFactor('') }} />
                  <span aria-hidden="true" className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-md', authMode === mode ? 'bg-[color:var(--workspace-primary-500)] text-white' : 'bg-[color:var(--workspace-surface-700)] text-[color:var(--workspace-text-muted)]')}><Icon className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0"><span className="block text-sm font-medium text-[color:var(--workspace-text-strong)]">{label}</span><span className={mutedText}>{hint}</span></span>
                </label>)}
              </div>
            </div>
            {authMode !== 'key' && <>
              <label className={fieldLabel}>{access.user}<Input className="mt-1" value={username} disabled={busy} autoComplete="username" onChange={e => { editForm(); setUsername(e.target.value) }} /></label>
              <label className={fieldLabel}>{access.pass}<Input className="mt-1" type="password" value={password} disabled={busy} autoComplete={authMode === 'initialize' ? 'new-password' : 'current-password'} onChange={e => { editForm(); setPassword(e.target.value) }} /></label>
              {authMode === 'authorize' && <label className={fieldLabel}>{access.twoFactor}<Input className="mt-1 font-mono text-xs" value={twoFactor} disabled={busy} autoComplete="one-time-code" onChange={e => setTwoFactor(e.target.value)} /></label>}
              {authMode === 'initialize' && <label className={fieldLabel}>{access.database}<Input className="mt-1 font-mono text-xs" value={metricDsn} disabled={busy} onChange={e => setMetricDsn(e.target.value)} /></label>}
            </>}
            {authMode === 'key' && <div className="sm:col-span-2">
              <label className={fieldLabel} htmlFor="komari-api-key">{t('settings.komariApiKey')}</label>
              <div className="relative mt-1">
                <Input id="komari-api-key" type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={(event) => { editForm(); setApiKey(event.target.value) }} disabled={busy} placeholder={selectedId ? t('settings.komariApiKeyKeep') : t('settings.komariApiKeyPaste')} className="pr-10" />
                <button type="button" aria-label={showApiKey ? t('settings.komariHideApiKey') : t('settings.komariShowApiKey')} onClick={() => setShowApiKey((value) => !value)} disabled={busy} className={cn('absolute right-2 top-1/2 -translate-y-1/2', mutedText)}>
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className={cn('mt-1 text-xs', mutedText)}>{t('settings.komariApiKeyHelp')}</p>
            </div>}
            <label className="flex items-center gap-2 self-end text-sm text-[color:var(--workspace-text)]">
              <input type="checkbox" checked={enabled} onChange={(event) => { editForm(); setEnabled(event.target.checked) }} disabled={busy} className={checkboxClass} />
              {t('settings.komariEnabled')}
            </label>
            {authMode !== 'key' && <Note icon={Info} className="sm:col-span-2">{authMode === 'initialize' ? access.initHint : access.accountHint}</Note>}
          </div>
          <div className={cn('flex flex-wrap items-center gap-2 border-t px-4 py-3', softBorder)}>
            <Button size="sm" className={cn('gap-1.5', primaryButton)} onClick={() => void save()} disabled={busy || !name.trim() || !endpoint.trim() || (authMode !== 'key' && (!username.trim() || !password))}><PlugZap className="h-3.5 w-3.5" />{busy ? t('settings.komariSaving') : authMode === 'key' ? t('settings.komariSave') : access.connect}</Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void verify()} disabled={busy || verifying || !unlocked || !savedIntegration || dirty}><Radar className="h-3.5 w-3.5" />{verifying ? copy.verifying : copy.verify}</Button>
            {savedIntegration && <Button variant="ghost" size="sm" onClick={() => void manageMappings()} disabled={busy || verifying || !unlocked || dirty}>{copy.manage}</Button>}
            {openServer && <Button variant="ghost" size="sm" className="gap-1.5" onClick={openServer}>{v3.serverConfiguration}<ArrowRight className="h-3.5 w-3.5" /></Button>}
            <span className="flex-1" />
            {selectedId && <Button variant="ghost" size="sm" className={cn('gap-1.5', dangerButton)} onClick={() => void remove()} disabled={busy}><Trash2 className="h-3.5 w-3.5" />{t('settings.komariRemove')}</Button>}
          </div>
          {(error || savedNotice || !unlocked || dirty || verificationError) && <div className="space-y-2 px-4 pb-3">
            {error && <p role="alert" className="text-xs text-[color:var(--workspace-status-bad-text)]">{monitoringDiagnostic(error, locale)}</p>}
            {savedNotice && <p role="status" className="text-xs text-[color:var(--workspace-status-good-text)]">{t('settings.komariSaved')}</p>}
            {!unlocked && <p className="text-xs text-[color:var(--workspace-status-warn-text)]">{t('settings.komariUnlockHint')}</p>}
            {dirty && <Note icon={TriangleAlert} tone="warn">{copy.saveFirst}</Note>}
            {verificationError && <p role="alert" className="text-xs text-[color:var(--workspace-status-bad-text)]">{verificationError}</p>}
          </div>}
        </>}
        {step === 'mapping' && savedIntegration && <div className="space-y-3 p-4">
          {verifiedNodes && <Banner icon={ShieldCheck} tone="good"><p role="status">{copy.verified} · {copy.nodes}: {verifiedNodes.length}</p></Banner>}
          {verifiedNodes?.length === 0 && <p className={cn('text-xs', mutedText)}>{copy.empty}</p>}
          <KomariMappingsPanel key={`${vaultId}:${savedIntegration.id}`} activeVaultId={vaultId} hosts={hosts} vaultUnlocked={unlocked} onLoadVaultSecret={handleRevealSecret} integrationId={savedIntegration.id} initiallyOpen discoveredNodes={verifiedNodes ?? undefined} onStateChange={setMappingState} onHostImported={host => setHosts(current => current.some(h => h.id === host.id) ? current : [...current, host])} />
          {!mappingState.busy && <p className={cn('text-xs', mutedText)}>{copy.unmapped}: {mappingState.unmapped}</p>}
          {mappingState.unsaved && <Note icon={TriangleAlert} tone="warn">{copy.unsavedMappings}</Note>}
          <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setStep('connection')}>{copy.back}</Button>
            {verifiedNodes && <Button size="sm" className={primaryButton} disabled={mappingState.busy || mappingState.unsaved || mappingState.failed} onClick={() => setStep('complete')}>{copy.finish}</Button>}</div>
        </div>}
        {step === 'complete' && <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <span aria-hidden="true" className="grid h-12 w-12 place-items-center rounded-2xl bg-[color:var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good)]"><CircleCheck className="h-6 w-6" /></span>
          <h4 role="status" className="text-base font-semibold text-[color:var(--workspace-text-strong)]">{copy.ready}</h4><p className={cn('max-w-md text-sm', mutedText)}>{copy.readyHint}</p>
          {verifiedNodes?.length === 0 && <p className={cn('text-xs', mutedText)}>{copy.empty}</p>}
          <p className={cn('text-xs', mutedText)}>{copy.unmapped}: {mappingState.unmapped}</p>
          {!enabled && <p className={cn('text-xs', mutedText)}>{copy.disabled}</p>}
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep('connection')}>{copy.back}</Button>
            {openServer && <Button size="sm" className={cn('gap-1.5', primaryButton)} onClick={openServer}>{v3.serverConfiguration}<ArrowRight className="h-3.5 w-3.5" /></Button>}
          </div>
        </div>}
        {!onOpenServiceConfiguration && savedIntegration && !dirty && <div className={cn('border-t px-4 pb-4', softBorder)}><MonitoringServicePanel key={integrationVersion(savedIntegration)} service={savedIntegration} /></div>}
      </div> : <div className={cn('sb-card grid min-h-40 place-items-center p-6 text-center text-xs', mutedText)}>{navigation.editSource}</div>}
    </section>
  )
}
