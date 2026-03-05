import { useState } from 'react'
import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  updateSnippet,
  type SnippetDraft,
  type SnippetEntry,
} from '@/lib/snippets'

export function useSnippets(activeVaultId: string, setOutput: (msg: string) => void) {
  const [snippets, setSnippets] = useState<SnippetEntry[]>([])
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)

  async function refresh() {
    const items = await listSnippets(activeVaultId)
    setSnippets(items)
    setSelectedSnippetId((current) => {
      if (current && items.some((item) => item.id === current)) return current
      return items[0]?.id ?? null
    })
  }

  async function handleCreate(payload: SnippetDraft) {
    setSaving(true)
    try {
      await createSnippet(payload, activeVaultId)
      await refresh()
    } catch (error) {
      setOutput(String(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdate(payload: SnippetEntry) {
    setSaving(true)
    try {
      await updateSnippet(payload, activeVaultId)
      await refresh()
    } catch (error) {
      setOutput(String(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setSaving(true)
    try {
      await deleteSnippet(id, activeVaultId)
      await refresh()
    } catch (error) {
      setOutput(String(error))
    } finally {
      setSaving(false)
    }
  }

  return {
    snippets, selectedSnippetId, setSelectedSnippetId,
    saving, running, setRunning,
    refresh, handleCreate, handleUpdate, handleDelete,
  }
}
