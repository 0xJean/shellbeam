import { Button } from '@/components/ui/button'
import { SegmentedChoice, SettingRow, SettingsGroup, SettingsNote, SettingSwitch } from '@/components/settings-controls'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { settingsV3Copy } from '@/lib/locales/settings-v3'
import { cn } from '@/lib/utils'
import {
  DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS,
  loadShellbeamAgentReleaseSettings,
  saveShellbeamAgentReleaseSettings,
  shellbeamAgentReleaseSettingsSummary,
  type ShellbeamAgentReleaseSettings,
} from '@/lib/shellbeam-agent-release-settings'
import type { ShellbeamAgentReleaseChannel } from '@/lib/shellbeam-agent-release'
import { LockKeyhole, Radio, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

const CHANNELS: ShellbeamAgentReleaseChannel[] = ['stable', 'preview', 'canary']

export function ShellbeamAgentReleaseSettingsSection() {
  const { t, locale } = useT()
  const v3 = settingsV3Copy[locale]
  const [settings, setSettings] = useState<ShellbeamAgentReleaseSettings>(loadShellbeamAgentReleaseSettings)
  const [hostText, setHostText] = useState(() => loadShellbeamAgentReleaseSettings().artifactAllowedHosts.join(', '))
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const update = (patch: Partial<ShellbeamAgentReleaseSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
    setSaved(false)
    setError('')
  }

  const toggleChannel = (channel: ShellbeamAgentReleaseChannel, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...settings.allowedChannels, channel])]
      : settings.allowedChannels.filter((item) => item !== channel)
    if (next.length === 0) return
    update({
      allowedChannels: CHANNELS.filter((item) => next.includes(item)),
      channel: settings.channel === channel && !enabled ? CHANNELS.find((item) => next.includes(item)) ?? 'stable' : settings.channel,
      allowPreview: settings.allowPreview && next.some((item) => item === 'preview' || item === 'canary'),
    })
  }

  const save = () => {
    try {
      const normalized = saveShellbeamAgentReleaseSettings({
        ...settings,
        artifactAllowedHosts: hostText.split(',').map((host) => host.trim()).filter(Boolean),
      })
      setSettings(normalized)
      setHostText(normalized.artifactAllowedHosts.join(', '))
      setSaved(true)
      setError('')
    } catch (cause) {
      setSaved(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const summary = shellbeamAgentReleaseSettingsSummary(settings)
  const previewAvailable = settings.allowedChannels.some((channel) => channel === 'preview' || channel === 'canary')

  const label = 'text-xs font-medium text-[var(--workspace-text)]'
  const hint = 'mt-1 text-[11px] text-[var(--workspace-text-subtle)]'
  const mono = 'mt-1 h-8 font-mono text-xs'
  return (
    <SettingsGroup title={<><Radio className="h-4 w-4" />{t('settings.agentRelease.title')}</>} testId="agent-release-settings">
      <SettingRow label={t('settings.agentRelease.enable')} description={t('settings.agentRelease.description')} htmlFor="agent-release-enabled">
        <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', summary.enabled
          ? 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]'
          : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}>
          {summary.enabled ? t('settings.agentRelease.enabled') : t('settings.agentRelease.disabled')}
        </span>
        <SettingSwitch id="agent-release-enabled" checked={settings.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
      </SettingRow>

      <SettingRow label={t('settings.agentRelease.channel')} description={v3.allowedChannelsHint}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {CHANNELS.map((channel) => (
            <label key={channel} className="flex cursor-pointer items-center gap-2 text-xs text-[var(--workspace-text)]">
              <Checkbox
                checked={settings.allowedChannels.includes(channel)}
                onChange={(event) => toggleChannel(channel, event.target.checked)}
                aria-label={t(`settings.agentRelease.channel.${channel}`)}
              />
              {t(`settings.agentRelease.channel.${channel}`)}
            </label>
          ))}
        </div>
      </SettingRow>

      <SettingRow label={v3.currentChannel}>
        <SegmentedChoice label={v3.currentChannel} value={settings.channel} onChange={(channel) => update({ channel })}
          options={CHANNELS.map((channel) => ({ value: channel, label: t(`settings.agentRelease.channel.${channel}`), disabled: !settings.allowedChannels.includes(channel) }))} />
      </SettingRow>

      <SettingRow label={t('settings.agentRelease.previewOptIn')} description={t('settings.agentRelease.previewOptInDesc')}>
        <SettingSwitch aria-label={t('settings.agentRelease.previewOptIn')} checked={settings.allowPreview} disabled={!previewAvailable} onChange={(event) => update({ allowPreview: event.target.checked })} />
      </SettingRow>

      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="agent-release-rollout">{fill(v3.rolloutPercent, { label: t('settings.agentRelease.rollout') })}</label>
          <Input id="agent-release-rollout" type="number" min={0} max={100} value={settings.rolloutPercentage} onChange={(event) => update({ rolloutPercentage: Number(event.target.value) })} className={mono} />
        </div>
        <div>
          <label className={label} htmlFor="agent-release-salt">{t('settings.agentRelease.rolloutSalt')}</label>
          <Input id="agent-release-salt" value={settings.rolloutSalt} onChange={(event) => update({ rolloutSalt: event.target.value })} className={mono} />
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="agent-release-manifest-url">{t('settings.agentRelease.manifestUrl')}</label>
          <Input id="agent-release-manifest-url" value={settings.releaseManifestUrl} onChange={(event) => update({ releaseManifestUrl: event.target.value })} placeholder="https://example.com/release-catalog.json" className={mono} />
          <p className={hint}>{t('settings.agentRelease.manifestUrlDesc')}</p>
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="agent-release-hosts">{t('settings.agentRelease.allowedHosts')}</label>
          <Input id="agent-release-hosts" value={hostText} onChange={(event) => { setHostText(event.target.value); setSaved(false) }} placeholder={t('settings.agentRelease.allowedHostsPlaceholder')} className={mono} />
          <p className={hint}>{t('settings.agentRelease.allowedHostsDesc')}</p>
        </div>
        <div>
          <label className={label} htmlFor="agent-release-artifact-key">{t('settings.agentRelease.artifactKey')}</label>
          <Input id="agent-release-artifact-key" value={settings.artifactTrustedPublicKeyBase64} onChange={(event) => update({ artifactTrustedPublicKeyBase64: event.target.value })} placeholder={t('settings.agentRelease.publicKeyPlaceholder')} className={mono} autoComplete="off" />
        </div>
        <div>
          <label className={label} htmlFor="agent-release-release-key">{t('settings.agentRelease.releaseKey')}</label>
          <Input id="agent-release-release-key" value={settings.trustedReleasePublicKeyBase64} onChange={(event) => update({ trustedReleasePublicKeyBase64: event.target.value })} placeholder={t('settings.agentRelease.publicKeyPlaceholder')} className={mono} autoComplete="off" />
        </div>
        <SettingsNote icon={LockKeyhole} className="sm:col-span-2">{t('settings.agentRelease.storageNote')}</SettingsNote>
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-[var(--workspace-surface-900)] px-4 py-2.5">
        <SettingsNote icon={ShieldCheck} className="min-w-0 flex-1 basis-56 px-0">{t('settings.agentRelease.signatureNote')}</SettingsNote>
        {saved && <span role="status" className="text-xs text-[var(--workspace-status-good-text)]">{t('settings.agentRelease.saved')}</span>}
        {error && <span role="alert" className="text-xs text-[var(--workspace-status-bad-text)]">{error}</span>}
        <Button type="button" variant="ghost" size="sm" onClick={() => { setSettings(DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS); setHostText(''); setSaved(false); setError('') }}>{t('settings.agentRelease.reset')}</Button>
        <Button type="button" size="sm" onClick={save}>{t('settings.agentRelease.save')}</Button>
      </div>
    </SettingsGroup>
  )
}
