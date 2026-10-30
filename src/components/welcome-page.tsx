import { useEffect, useState, type ReactNode } from 'react'
import {
  SquareTerminal, FolderOpen, ArrowLeftRight, Sparkles, Activity, RefreshCw, Code2, Cable,
  ArrowLeft, ArrowRight, Check, Eye, EyeOff, Loader2, Lock, Plus, QrCode, ShieldAlert,
} from 'lucide-react'
import { useT } from '@/lib/i18n'
import { welcomeLockCopy } from '@/lib/locales/welcome-lock-v3'
import { fill } from '@/lib/locales/probe-install'
import { useApp } from '@/contexts/app-context'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import { parseSshConfig, type SshConfigEntry } from '@/lib/hosts'
import { updateVault } from '@/lib/vaults'
import { claimVaultSetup, useVaultSetupSubmit } from '@/lib/vault-setup-handoff'
import { SshImportDialog } from '@/components/ssh-import-dialog'
import logoUrl from '@/assets/logo.png'

type Copy = (typeof welcomeLockCopy)[keyof typeof welcomeLockCopy]
type Choice = 'import' | 'manual' | 'sync'

const FEATURES = [
  { icon: SquareTerminal, titleKey: 'welcome.sshTerminal' },
  { icon: FolderOpen, titleKey: 'welcome.sftpTransfer' },
  { icon: ArrowLeftRight, titleKey: 'welcome.portForwarding' },
  { icon: Sparkles, titleKey: 'welcome.aiAssistant' },
  { icon: Activity, titleKey: 'welcome.monitor' },
  { icon: RefreshCw, titleKey: 'welcome.crossDeviceSync' },
  { icon: Code2, titleKey: 'welcome.snippets' },
  { icon: Cable, titleKey: 'welcome.mcp' },
] as const

const STRENGTH_COLOR = ['', 'var(--workspace-status-bad)', 'var(--workspace-status-warn)', 'var(--workspace-primary-500)', 'var(--workspace-status-good)']
const PREVIEW_COUNT = 5

function passwordStrength(pw: string, c: Copy) {
  if (!pw) return { level: 0, label: '' }
  if (pw.length < 8) return { level: 1, label: c.tooShort }
  let score = 0
  if (/[a-z]/.test(pw)) score++
  if (/[A-Z]/.test(pw)) score++
  if (/[0-9]/.test(pw)) score++
  if (/[^a-zA-Z0-9]/.test(pw)) score++
  if (pw.length >= 12) score++
  if (score <= 2) return { level: 2, label: c.weak }
  if (score <= 3) return { level: 3, label: c.good }
  return { level: 4, label: c.strong }
}

const inputShell = 'flex h-10 items-center gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[color:var(--workspace-surface-900)] px-3 focus-within:border-[color:var(--workspace-primary-500)] focus-within:ring-2 focus-within:ring-[color:var(--workspace-accent-subtle)]'
const inputBare = 'min-w-0 flex-1 bg-transparent text-sm text-[color:var(--workspace-text-strong)] outline-none placeholder:text-[color:var(--workspace-text-subtle)] disabled:opacity-60'
const primaryBtn = 'inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[color:var(--workspace-primary-500)] px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
const linkBtn = 'text-xs text-[color:var(--workspace-text-muted)] transition-colors hover:text-[color:var(--workspace-text-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--workspace-primary-500)]'

export function WelcomePage({ onDismiss, onOpenGuide }: { onDismiss: () => void; onOpenGuide: () => void }) {
  const { t, locale } = useT()
  const c = welcomeLockCopy[locale]
  const vault = useVault()
  const [view, setView] = useState<1 | 2 | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => claimVaultSetup(), [])

  const vaultReady = !!vault.vaultStatusState?.initialized
  const current = view ?? (vaultReady ? 2 : 1)
  const vaultName = vault.vaults.find((item) => item.id === vault.activeVaultId)?.name ?? ''

  const footer = (
    <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      <button type="button" onClick={onOpenGuide} className={`${linkBtn} font-medium text-[color:var(--workspace-accent-text)]`}>{t('guide.start')}</button>
      <span className="text-[color:var(--workspace-text-subtle)]">·</span>
      <button data-testid="welcome-enter" type="button" onClick={onDismiss} className={linkBtn}>{t('guide.skip')}</button>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[9999] flex overflow-hidden bg-[color:var(--workspace-surface-950)] text-[color:var(--workspace-text)]" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      <aside className="hidden w-[min(500px,40%)] shrink-0 flex-col border-r border-[color:var(--workspace-border-soft)] bg-[color:var(--workspace-surface-900)] px-12 pb-10 pt-16 md:flex">
        <img src={logoUrl} alt="ShellBeam" className="h-[52px] w-[52px] rounded-xl" />
        <h1 className="mt-7 text-[28px] font-bold tracking-tight text-[color:var(--workspace-text-strong)]">{c.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--workspace-text-muted)]">{c.intro}</p>
        <ol className="mt-9 space-y-2">
          <StepItem n={1} state={vaultReady ? 'done' : current === 1 ? 'active' : 'todo'} title={c.step1} sub={c.step1Sub} />
          <StepItem n={2} state={current === 2 ? 'active' : 'todo'} title={c.step2} sub={c.step2Sub} />
          <StepItem n={3} state="todo" title={c.step3} sub={c.step3Sub} />
        </ol>
        <div className="mt-auto grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[color:var(--workspace-border-soft)] pt-6">
          {FEATURES.map((f) => (
            <div key={f.titleKey} className="flex min-w-0 items-center gap-2 text-[13px] text-[color:var(--workspace-text)]">
              <f.icon className="h-4 w-4 shrink-0 text-[color:var(--workspace-accent-text)]" />
              <span className="truncate">{t(f.titleKey)}</span>
            </div>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 justify-center overflow-y-auto px-6 py-12">
        <div className="my-auto w-full max-w-[500px]">
          {current === 1
            ? <VaultStep c={c} vaultName={vaultName} onCreated={(warning) => { setNotice(warning); setView(2) }} onContinue={() => setView(2)} footer={footer} />
            : <HostStep c={c} notice={notice} onBack={() => setView(1)} onDismiss={onDismiss} footer={footer} />}
        </div>
      </main>
    </div>
  )
}

function StepItem({ n, state, title, sub }: { n: number; state: 'done' | 'active' | 'todo'; title: string; sub: string }) {
  return (
    <li aria-current={state === 'active' ? 'step' : undefined}
      className={`flex items-center gap-3.5 rounded-xl px-3.5 py-3 ${state === 'active' ? 'bg-[color:var(--workspace-surface-800)]' : ''}`}>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        state === 'done' ? 'bg-[color:var(--workspace-status-good)] text-white'
          : state === 'active' ? 'bg-[color:var(--workspace-primary-500)] text-white'
            : 'border border-[color:var(--workspace-border-strong)] text-[color:var(--workspace-text-muted)]'}`}>
        {state === 'done' ? <Check className="h-4 w-4" /> : n}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-[color:var(--workspace-text-strong)]">{title}</div>
        <div className="text-xs text-[color:var(--workspace-text-muted)]">{sub}</div>
      </div>
    </li>
  )
}

function StepHeader({ eyebrow, title, desc }: { eyebrow: string; title: string; desc: string }) {
  return (
    <div className="mb-6">
      <div className="text-xs font-semibold text-[color:var(--workspace-accent-text)]">{eyebrow}</div>
      <h2 className="mt-1.5 text-2xl font-bold tracking-tight text-[color:var(--workspace-text-strong)]">{title}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--workspace-text-muted)]">{desc}</p>
    </div>
  )
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 rounded-lg bg-[color:var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">
      <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" /><span>{children}</span>
    </div>
  )
}

function VaultStep({ c, vaultName, onCreated, onContinue, footer }: {
  c: Copy
  vaultName: string
  onCreated: (warning: string) => void
  onContinue: () => void
  footer: ReactNode
}) {
  const vault = useVault()
  const submit = useVaultSetupSubmit()
  const status = vault.vaultStatusState
  const [name, setName] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reveal, setReveal] = useState(false)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const header = <StepHeader eyebrow={fill(c.stepOf, { n: 1 })} title={c.createTitle} desc={c.createDesc} />

  if (status?.initialized) {
    return (
      <>
        {header}
        <div className="sb-card flex items-center gap-3 p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]"><Check className="h-4 w-4" /></span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[color:var(--workspace-text-strong)]">{c.vaultReady}</div>
            <div className="text-xs text-[color:var(--workspace-text-muted)]">{status.unlocked ? fill(c.vaultReadyDesc, { name: vaultName }) : c.vaultLocked}</div>
          </div>
        </div>
        <button type="button" onClick={onContinue} className={`${primaryBtn} mt-5 w-full`}>{c.continue}<ArrowRight className="h-4 w-4" /></button>
        {footer}
      </>
    )
  }

  const nameValue = name ?? vaultName
  const strength = passwordStrength(password, c)
  const matches = confirm.length > 0 && confirm === password
  const canCreate = !!submit && !busy && password.length >= 8 && matches && ack

  async function handleCreate() {
    if (!submit || !canCreate) return
    setBusy(true)
    setError('')
    try {
      await submit(password)
      let warning = ''
      const nextName = nameValue.trim()
      if (nextName && nextName !== vaultName) {
        try {
          await updateVault(vault.activeVaultId, nextName)
          await vault.refreshVaults()
        } catch (e) {
          warning = fill(c.renameFailed, { error: String(e instanceof Error ? e.message : e) })
        }
      }
      setPassword('')
      setConfirm('')
      onCreated(warning)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form data-testid="welcome-vault-form" onSubmit={(e) => { e.preventDefault(); void handleCreate() }}>
      {header}
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[color:var(--workspace-text-strong)]">{c.vaultName}</span>
          <div className={inputShell}>
            <input className={inputBare} value={nameValue} onChange={(e) => setName(e.target.value)} disabled={busy} autoComplete="off" />
          </div>
        </label>
        <div>
          <label htmlFor="welcome-master-password" className="mb-1.5 block text-xs font-semibold text-[color:var(--workspace-text-strong)]">{c.masterPassword}</label>
          <div className={inputShell}>
            <Lock className="h-4 w-4 shrink-0 text-[color:var(--workspace-text-subtle)]" />
            <input id="welcome-master-password" data-testid="welcome-master-password" className={inputBare} type={reveal ? 'text' : 'password'}
              value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus disabled={busy} />
            <button type="button" onClick={() => setReveal((v) => !v)} aria-label={reveal ? c.hidePassword : c.showPassword}
              className="text-[color:var(--workspace-text-subtle)] hover:text-[color:var(--workspace-text-strong)]">
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {strength.level > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="grid flex-1 grid-cols-4 gap-1.5">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-1 rounded-full" style={{ background: i <= strength.level ? STRENGTH_COLOR[strength.level] : 'var(--workspace-surface-700)' }} />
                ))}
              </div>
              <span className="text-[11px] font-medium" style={{ color: STRENGTH_COLOR[strength.level] }}>{strength.label}</span>
            </div>
          )}
        </div>
        <div>
          <label htmlFor="welcome-confirm-password" className="mb-1.5 block text-xs font-semibold text-[color:var(--workspace-text-strong)]">{c.confirmPassword}</label>
          <div className={inputShell}>
            <Lock className="h-4 w-4 shrink-0 text-[color:var(--workspace-text-subtle)]" />
            <input id="welcome-confirm-password" data-testid="welcome-confirm-password" className={inputBare} type={reveal ? 'text' : 'password'}
              value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" disabled={busy} />
          </div>
          {confirm.length > 0 && (
            <div className={`mt-1.5 flex items-center gap-1 text-xs ${matches ? 'text-[color:var(--workspace-status-good-text)]' : 'text-[color:var(--workspace-status-bad-text)]'}`}>
              {matches && <Check className="h-3.5 w-3.5" />}{matches ? c.match : c.mismatch}
            </div>
          )}
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-[color:var(--workspace-text)]">
          <input data-testid="welcome-vault-ack" type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={busy}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--workspace-primary-500)]" />
          <span>{c.ack}</span>
        </label>
        {error && <ErrorLine>{error}</ErrorLine>}
        <button data-testid="welcome-create-vault" type="submit" disabled={!canCreate} className={`${primaryBtn} w-full`}>
          {busy ? <><Loader2 className="h-4 w-4 animate-spin" />{c.creating}</> : <>{c.createContinue}<ArrowRight className="h-4 w-4" /></>}
        </button>
      </div>
      {footer}
    </form>
  )
}

function HostStep({ c, notice, onBack, onDismiss, footer }: {
  c: Copy
  notice: string
  onBack: () => void
  onDismiss: () => void
  footer: ReactNode
}) {
  const app = useApp()
  const hosts = useHosts()
  const vault = useVault()
  const [entries, setEntries] = useState<SshConfigEntry[] | null>(null)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  useEffect(() => {
    let alive = true
    parseSshConfig()
      .then((res) => { if (alive) setEntries(res) })
      .catch(() => { if (alive) setEntries([]) })
    return () => { alive = false }
  }, [])

  const found = entries?.length ?? 0
  const active: Choice = choice ?? (found > 0 || entries === null ? 'import' : 'manual')
  const canImport = found > 0

  function proceed() {
    if (active === 'import') { if (canImport) setImportOpen(true); return }
    if (active === 'manual') {
      app.setPcSidebarNav('hosts')
      hosts.setPcOpenAddHost(true)
    } else {
      app.setPcSidebarNav('sync')
    }
    onDismiss()
  }

  const primaryLabel = active === 'import' ? fill(c.importN, { count: found }) : active === 'manual' ? c.addHost : c.openSync

  return (
    <>
      <StepHeader eyebrow={fill(c.stepOf, { n: 2 })} title={c.hostsTitle} desc={c.hostsDesc} />
      {notice && <div className="mb-4"><ErrorLine>{notice}</ErrorLine></div>}
      <div role="radiogroup" aria-label={c.hostsTitle} className="space-y-3">
        <ChoiceCard selected={active === 'import'} disabled={entries !== null && !canImport} onSelect={() => setChoice('import')}
          title={<>{c.importSsh}<span className="rounded px-1.5 py-px text-[11px] font-medium bg-[color:var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]">{c.recommended}</span></>}
          sub={entries === null ? c.importScanning : canImport ? fill(c.importFound, { count: found }) : c.importNone}>
          {active === 'import' && canImport && entries && (
            <div className="mt-3 space-y-1.5 rounded-lg bg-[color:var(--workspace-surface-800)] px-3 py-2.5">
              {entries.slice(0, PREVIEW_COUNT).map((e, i) => (
                <div key={`${e.alias}-${i}`} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3 text-[13px]">
                  <span className="truncate font-medium text-[color:var(--workspace-text-strong)]">{e.alias}</span>
                  <span className="truncate font-mono text-xs leading-5 text-[color:var(--workspace-text-muted)]">
                    {e.user ? `${e.user}@` : ''}{e.hostName || e.alias}{e.port && e.port !== 22 ? `:${e.port}` : ''}{e.proxyJump ? ` · ${c.viaJump}` : ''}
                  </span>
                </div>
              ))}
              {found > PREVIEW_COUNT && <div className="pt-0.5 text-center text-xs text-[color:var(--workspace-text-subtle)]">{fill(c.more, { count: found - PREVIEW_COUNT })}</div>}
            </div>
          )}
        </ChoiceCard>
        <ChoiceCard selected={active === 'manual'} onSelect={() => setChoice('manual')} title={c.manual} sub={c.manualSub} icon={<Plus className="h-4 w-4" />} />
        <ChoiceCard selected={active === 'sync'} onSelect={() => setChoice('sync')} title={c.sync} sub={c.syncSub} icon={<QrCode className="h-4 w-4" />} />
      </div>
      <div className="mt-5 flex items-center gap-2.5">
        <button type="button" onClick={onBack} className="inline-flex h-10 items-center gap-1.5 px-2 text-sm text-[color:var(--workspace-text)] hover:text-[color:var(--workspace-text-strong)]">
          <ArrowLeft className="h-4 w-4" />{c.back}
        </button>
        <span className="flex-1" />
        <button data-testid="welcome-host-action" type="button" onClick={proceed} disabled={active === 'import' && !canImport} className={primaryBtn}>{primaryLabel}</button>
      </div>
      {footer}
      {importOpen && (
        <SshImportDialog
          vaultId={vault.activeVaultId}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false)
            void hosts.refreshHosts()
            app.setPcSidebarNav('hosts')
            onDismiss()
          }}
        />
      )}
    </>
  )
}

function ChoiceCard({ selected, disabled, onSelect, title, sub, icon, children }: {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  title: ReactNode
  sub: string
  icon?: ReactNode
  children?: ReactNode
}) {
  return (
    <div role="radio" aria-checked={selected} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
      onClick={() => { if (!disabled) onSelect() }}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect() } }}
      className={`sb-card flex cursor-pointer items-start gap-3 p-4 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-primary-500)] ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      style={selected ? { borderColor: 'var(--workspace-primary-500)', boxShadow: '0 0 0 3px var(--workspace-accent-subtle)' } : undefined}>
      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-[color:var(--workspace-primary-500)]' : 'border-[color:var(--workspace-border-strong)]'}`}>
        {selected && <span className="h-2 w-2 rounded-full bg-[color:var(--workspace-primary-500)]" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--workspace-text-strong)]">{title}</div>
        <div className="mt-0.5 text-xs text-[color:var(--workspace-text-muted)]">{sub}</div>
        {children}
      </div>
      {icon && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color:var(--workspace-surface-800)] text-[color:var(--workspace-text-muted)]">{icon}</span>}
    </div>
  )
}
