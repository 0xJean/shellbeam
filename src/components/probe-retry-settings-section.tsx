import { Button } from '@/components/ui/button'
import { SettingRow, SettingsGroup, SettingStepper } from '@/components/settings-controls'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { settingsV3Copy } from '@/lib/locales/settings-v3'
import {
  DEFAULT_PROBE_RETRY_SETTINGS,
  loadProbeRetrySettings,
  saveProbeRetrySettings,
  type ProbeRetrySettings,
} from '@/lib/probe-retry-settings'
import { Check, RotateCcw, Timer } from 'lucide-react'
import { useState } from 'react'

export function ProbeRetrySettingsSection() {
  const { t, locale } = useT()
  const v3 = settingsV3Copy[locale]
  const [settings, setSettings] = useState<ProbeRetrySettings>(loadProbeRetrySettings)
  const [saved, setSaved] = useState(false)

  const update = (patch: Partial<ProbeRetrySettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
    setSaved(false)
  }

  const save = () => {
    setSettings(saveProbeRetrySettings(settings))
    setSaved(true)
  }

  const reset = () => {
    setSettings({ ...DEFAULT_PROBE_RETRY_SETTINGS })
    setSaved(false)
  }

  return (
    <SettingsGroup title={<><Timer className="h-4 w-4" />{t('settings.probeRetry.title')}</>} testId="probe-retry-settings">
      <p className="px-4 py-3 text-xs text-[var(--workspace-text-subtle)]">{t('settings.probeRetry.description')}</p>
      <SettingRow label={t('settings.probeRetry.maxRetries')} description={v3.retriesRange} htmlFor="probe-retry-max">
        <SettingStepper id="probe-retry-max" min={0} max={5} unit={v3.times} value={settings.maxRetries}
          decreaseLabel={fill(v3.decrease, { label: t('settings.probeRetry.maxRetries') })} increaseLabel={fill(v3.increase, { label: t('settings.probeRetry.maxRetries') })}
          onChange={(maxRetries) => update({ maxRetries })} />
      </SettingRow>
      <SettingRow label={t('settings.probeRetry.delay')} description={t('settings.probeRetry.delayDesc')} htmlFor="probe-retry-delay">
        <SettingStepper id="probe-retry-delay" min={0} max={2000} step={50} unit="ms" value={settings.retryDelayMs}
          decreaseLabel={fill(v3.decrease, { label: t('settings.probeRetry.delay') })} increaseLabel={fill(v3.increase, { label: t('settings.probeRetry.delay') })}
          onChange={(retryDelayMs) => update({ retryDelayMs })} />
      </SettingRow>
      <div className="flex flex-wrap items-center gap-2 bg-[var(--workspace-surface-900)] px-4 py-2.5">
        {saved && <span role="status" className="flex items-center gap-1 text-xs text-[var(--workspace-status-good-text)]"><Check className="h-3.5 w-3.5" />{t('settings.probeRetry.saved')}</span>}
        <span className="grow" />
        <Button type="button" variant="ghost" size="sm" onClick={reset}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t('settings.probeRetry.reset')}
        </Button>
        <Button type="button" size="sm" onClick={save}>{t('settings.probeRetry.save')}</Button>
      </div>
    </SettingsGroup>
  )
}
