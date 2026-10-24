import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
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
  const { t } = useT()
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

  return (
    <section className="rounded-lg border p-4" data-testid="agent-release-settings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold"><Radio className="h-4 w-4" />{t('settings.agentRelease.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.agentRelease.description')}</p>
        </div>
        <span className="rounded-full border px-2 py-1 text-[10px] font-medium text-muted-foreground">
          {summary.enabled ? t('settings.agentRelease.enabled') : t('settings.agentRelease.disabled')}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.enabled} onChange={(event) => update({ enabled: event.target.checked })} className="rounded" />
          {t('settings.agentRelease.enable')}
        </label>

        <div>
          <span className="text-sm text-muted-foreground">{t('settings.agentRelease.channel')}</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {CHANNELS.map((channel) => (
              <label key={channel} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  checked={settings.allowedChannels.includes(channel)}
                  onChange={(event) => toggleChannel(channel, event.target.checked)}
                  aria-label={t(`settings.agentRelease.channel.${channel}`)}
                  className="rounded"
                />
                {t(`settings.agentRelease.channel.${channel}`)}
              </label>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {settings.allowedChannels.map((channel) => (
              <Button key={channel} type="button" variant={settings.channel === channel ? 'default' : 'outline'} size="sm" onClick={() => update({ channel })}>
                {t(`settings.agentRelease.channel.${channel}`)}
              </Button>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" aria-label={t('settings.agentRelease.previewOptIn')} checked={settings.allowPreview} disabled={!previewAvailable} onChange={(event) => update({ allowPreview: event.target.checked })} className="mt-0.5 rounded" />
          <span>
            {t('settings.agentRelease.previewOptIn')}
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('settings.agentRelease.previewOptInDesc')}</span>
          </span>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-sm text-muted-foreground" htmlFor="agent-release-rollout">{t('settings.agentRelease.rollout')}</label>
            <div className="mt-1 flex items-center gap-2">
              <Input id="agent-release-rollout" type="number" min={0} max={100} value={settings.rolloutPercentage} onChange={(event) => update({ rolloutPercentage: Number(event.target.value) })} className="w-24" />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div>
            <label className="text-sm text-muted-foreground" htmlFor="agent-release-salt">{t('settings.agentRelease.rolloutSalt')}</label>
            <Input id="agent-release-salt" value={settings.rolloutSalt} onChange={(event) => update({ rolloutSalt: event.target.value })} className="mt-1" />
          </div>
        </div>

        <div>
          <label className="text-sm text-muted-foreground" htmlFor="agent-release-manifest-url">{t('settings.agentRelease.manifestUrl')}</label>
          <Input id="agent-release-manifest-url" value={settings.releaseManifestUrl} onChange={(event) => update({ releaseManifestUrl: event.target.value })} placeholder="https://example.com/release-catalog.json" className="mt-1" />
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.agentRelease.manifestUrlDesc')}</p>
        </div>

        <div>
          <label className="text-sm text-muted-foreground" htmlFor="agent-release-hosts">{t('settings.agentRelease.allowedHosts')}</label>
          <Input id="agent-release-hosts" value={hostText} onChange={(event) => { setHostText(event.target.value); setSaved(false) }} placeholder={t('settings.agentRelease.allowedHostsPlaceholder')} className="mt-1" />
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.agentRelease.allowedHostsDesc')}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-sm text-muted-foreground" htmlFor="agent-release-artifact-key">{t('settings.agentRelease.artifactKey')}</label>
            <Input id="agent-release-artifact-key" value={settings.artifactTrustedPublicKeyBase64} onChange={(event) => update({ artifactTrustedPublicKeyBase64: event.target.value })} placeholder={t('settings.agentRelease.publicKeyPlaceholder')} className="mt-1 font-mono text-xs" autoComplete="off" />
          </div>
          <div>
            <label className="text-sm text-muted-foreground" htmlFor="agent-release-release-key">{t('settings.agentRelease.releaseKey')}</label>
            <Input id="agent-release-release-key" value={settings.trustedReleasePublicKeyBase64} onChange={(event) => update({ trustedReleasePublicKeyBase64: event.target.value })} placeholder={t('settings.agentRelease.publicKeyPlaceholder')} className="mt-1 font-mono text-xs" autoComplete="off" />
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>{t('settings.agentRelease.signatureNote')}</span>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>{t('settings.agentRelease.storageNote')}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={save}>{t('settings.agentRelease.save')}</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { setSettings(DEFAULT_SHELLBEAM_AGENT_RELEASE_SETTINGS); setHostText(''); setSaved(false); setError('') }}>{t('settings.agentRelease.reset')}</Button>
          {saved && <span role="status" className="text-xs text-emerald-600">{t('settings.agentRelease.saved')}</span>}
          {error && <span role="alert" className="text-xs text-red-500">{error}</span>}
        </div>
      </div>
    </section>
  )
}
