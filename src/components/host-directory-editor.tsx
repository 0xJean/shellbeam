import { useState, type ComponentProps } from 'react'
import { hostConnections, validateHostDraft, withHostConnections, type ConnectionProfile, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { HostForm } from './host-form'
import { Button } from './ui/button'
import { Input } from './ui/input'

type Props = Omit<ComponentProps<typeof HostForm>, 'initial'> & { host: HostProfile }

/** One host save owns its metadata and connection set. Editing/removing a
 * connection never creates/deletes a host, monitoring binding or Vault secret. */
export function HostDirectoryEditor({ host, onSubmit, onCancel, metadataControls, ...form }: Props) {
  const { t } = useT()
  const [name, setName] = useState(host.name)
  const [group, setGroup] = useState(host.group)
  const [tags, setTags] = useState(host.tags.join(', '))
  const [connections, setConnections] = useState(() => hostConnections(host))
  const [defaultId, setDefaultId] = useState(host.defaultConnectionId ?? hostConnections(host)[0]?.id ?? null)
  const [editing, setEditing] = useState<ConnectionProfile | 'new' | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  if (editing) return <HostForm {...form} key={editing === 'new' ? 'new' : editing.id} connectionOnly
    initial={editing === 'new' ? null : { ...editing, name: editing.label }}
    onCancel={() => setEditing(null)} onSubmit={async draft => {
      const id = editing === 'new' ? crypto.randomUUID() : editing.id
      const connection: ConnectionProfile = {
        id, label: draft.name, address: draft.address, port: draft.port, username: draft.username, authType: draft.authType,
        secretKeyRef: draft.secretKeyRef, passwordKeyRef: draft.passwordKeyRef, privateKeyRef: draft.privateKeyRef,
        jumpHostId: draft.jumpHostId, jumpHost: draft.jumpHost, jumpPort: draft.jumpPort, jumpUser: draft.jumpUser,
      }
      setConnections(rows => editing === 'new' ? [...rows, connection] : rows.map(row => row.id === id ? connection : row))
      if (!defaultId) setDefaultId(id)
      setEditing(null)
    }} />

  async function save() {
    if (form.vaultUnlocked === false || saving) return
    setError('')
    const draft = withHostConnections({ ...host, name: name.trim(), group: group.trim(), tags: tags.split(/[,，]/).map(v => v.trim()).filter(Boolean) }, connections, defaultId)
    const validation = validateHostDraft(draft)
    if (!validation.isValid) { setError(validation.errors[0]); return }
    setSaving(true)
    try { await onSubmit(draft) } catch { setError(t('hostDirectory.saveFailed')) } finally { setSaving(false) }
  }

  return <div className="space-y-4 p-4" data-testid="host-directory-editor">
    <h2 className="font-semibold">{t('hostForm.editHost')}</h2>
    <label className="block space-y-1 text-sm">{t('hostForm.label')}<Input aria-label={t('hostForm.label')} value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="block space-y-1 text-sm">{t('hostForm.parentGroup')}<Input aria-label={t('hostForm.parentGroup')} value={group} onChange={e => setGroup(e.target.value)} /></label>
    <label className="block space-y-1 text-sm">{t('hostForm.tags')}<Input aria-label={t('hostForm.tags')} value={tags} onChange={e => setTags(e.target.value)} /></label>
    {metadataControls}
    <section className="space-y-3 border-t pt-3" aria-label={t('hostDirectory.connections')}>
      <h3 className="text-sm font-medium">{t('hostDirectory.connections')}</h3>
      <p className="text-xs text-muted-foreground">{t('hostDirectory.defaultHelp')}</p>
      {connections.length === 0 && <p role="status" className="text-sm">{t('hostDirectory.monitoringOnly')}</p>}
      {connections.map(c => <div key={c.id} className="flex flex-wrap items-center gap-2 rounded border p-2">
        <label className="min-w-0 flex-1 text-sm"><input type="radio" name="default-connection" aria-label={`${t('hostDirectory.defaultConnection')}: ${c.label}`} checked={defaultId === c.id} onChange={() => setDefaultId(c.id)} /> <span className="break-all">{c.label} · {c.username}@{c.address}:{c.port}</span></label>
        <Button size="sm" variant="outline" onClick={() => setEditing(c)}>{t('hostDirectory.edit')}</Button>
        <Button size="sm" variant="outline" onClick={() => { const rest = connections.filter(row => row.id !== c.id); setConnections(rest); if (defaultId === c.id) setDefaultId(rest[0]?.id ?? null) }}>{t('hostDirectory.removeConnection')}</Button>
      </div>)}
      <p className="text-xs text-muted-foreground">{t('hostDirectory.removeHelp')}</p>
      <Button variant="outline" size="sm" disabled={connections.length >= 16 || saving} onClick={() => setEditing('new')}>{t('hostDirectory.addConnection')}</Button>
    </section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={onCancel}>{t('hostForm.cancel')}</Button><Button disabled={saving || form.vaultUnlocked === false} onClick={() => void save()}>{saving ? t('hostForm.saving') : t('hostForm.save')}</Button></div>
  </div>
}
