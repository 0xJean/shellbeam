import { useCallback, useState } from 'react'

/** PC workspace layout: a list of apps beside one panel (default), or the windowed desktop. */
export type WorkspaceLayout = 'list' | 'desktop'
const STORAGE_KEY = 'shellbeam.workspace.layout'

export function loadWorkspaceLayout(): WorkspaceLayout {
  try { return localStorage.getItem(STORAGE_KEY) === 'desktop' ? 'desktop' : 'list' } catch { return 'list' }
}

export function useWorkspaceLayout() {
  const [layout, setLayoutState] = useState<WorkspaceLayout>(loadWorkspaceLayout)
  const setLayout = useCallback((next: WorkspaceLayout) => {
    setLayoutState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* layout stays for this session only */ }
  }, [])
  return { layout, setLayout }
}
