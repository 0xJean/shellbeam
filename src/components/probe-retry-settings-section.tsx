import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import {
  DEFAULT_PROBE_RETRY_SETTINGS,
  loadProbeRetrySettings,
  saveProbeRetrySettings,
  type ProbeRetrySettings,
} from '@/lib/probe-retry-settings'
import { RotateCcw, Timer } from 'lucide-react'
import { useState } from 'react'

export function ProbeRetrySettingsSection() {
  const { t } = useT()
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
    <section className="rounded-lg border p-4" data-testid="probe-retry-settings">
      <div className="flex items-start gap-3">
        <Timer className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h3 className="font-semibold">{t('settings.probeRetry.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.probeRetry.description')}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="probe-retry-max">{t('settings.probeRetry.maxRetries')}</label>
          <Input
            id="probe-retry-max"
            type="number"
            min={0}
            max={5}
            value={settings.maxRetries}
            onChange={(event) => update({ maxRetries: Number(event.target.value) })}
            className="mt-1 w-24"
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground" htmlFor="probe-retry-delay">{t('settings.probeRetry.delay')}</label>
          <div className="mt-1 flex items-center gap-2">
            <Input
              id="probe-retry-delay"
              type="number"
              min={0}
              max={2000}
              step={50}
              value={settings.retryDelayMs}
              onChange={(event) => update({ retryDelayMs: Number(event.target.value) })}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">ms</span>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('settings.probeRetry.delayDesc')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={save}>{t('settings.probeRetry.save')}</Button>
        <Button type="button" variant="outline" size="sm" onClick={reset}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t('settings.probeRetry.reset')}
        </Button>
        {saved && <span role="status" className="text-xs text-emerald-600">{t('settings.probeRetry.saved')}</span>}
      </div>
    </section>
  )
}
