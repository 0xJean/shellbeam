import type { WorkspaceInventory, WorkspaceInventoryProject } from './workspace-inventory'

const DEPLOYMENT_POINTER_DIRS = new Set(['current', 'live'])
const DEPLOYMENT_RELEASE_DIRS = new Set(['releases'])
const PROJECT_KIND_ORDER = ['compose', 'node', 'python', 'go', 'php', 'rust', 'project']

function normalizeUnixPath(path: string) {
  const trimmed = path.trim().replace(/\/+/g, '/')
  if (!trimmed) return ''
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

function splitUnixPath(path: string) {
  return normalizeUnixPath(path).split('/').filter(Boolean)
}

function buildUnixPath(parts: string[], absolute: boolean) {
  if (parts.length === 0) return absolute ? '/' : ''
  return `${absolute ? '/' : ''}${parts.join('/')}`
}

function pathBasename(path: string) {
  return splitUnixPath(path).at(-1) ?? ''
}

function cleanProjectDisplayName(name: string) {
  return name.trim().replace(/\s+/g, ' ')
}

function normalizeProjectPath(path: string) {
  const normalized = normalizeUnixPath(path)
  if (!normalized) return ''

  const parts = splitUnixPath(normalized)
  const absolute = normalized.startsWith('/')
  const releaseIndex = parts.findIndex((part, index) => (
    DEPLOYMENT_RELEASE_DIRS.has(part)
    && index > 0
    && index < parts.length - 1
  ))
  if (releaseIndex > 0) {
    return buildUnixPath(parts.slice(0, releaseIndex), absolute)
  }

  const leaf = parts.at(-1)
  if (leaf && DEPLOYMENT_POINTER_DIRS.has(leaf) && parts.length > 1) {
    return buildUnixPath(parts.slice(0, -1), absolute)
  }

  return normalized
}

function deriveProjectName(normalizedPath: string, rawName: string, rawPath: string) {
  const cleaned = cleanProjectDisplayName(rawName)
  const normalizedRawPath = normalizeUnixPath(rawPath)
  const rawLeaf = pathBasename(normalizedRawPath)
  const normalizedChanged = normalizedRawPath !== '' && normalizedRawPath !== normalizedPath
  if (cleaned && (!normalizedChanged || cleaned !== rawLeaf)) return cleaned
  return pathBasename(normalizedPath) || cleaned || 'project'
}

function splitProjectKinds(kind: string) {
  return kind
    .split(/[·,]/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function mergeProjectKinds(...kinds: string[]) {
  const unique = new Set(kinds.flatMap(splitProjectKinds))
  if (unique.size === 0) unique.add('project')
  return [...unique].sort((a, b) => {
    const aIndex = PROJECT_KIND_ORDER.indexOf(a)
    const bIndex = PROJECT_KIND_ORDER.indexOf(b)
    const aRank = aIndex === -1 ? PROJECT_KIND_ORDER.length : aIndex
    const bRank = bIndex === -1 ? PROJECT_KIND_ORDER.length : bIndex
    return aRank === bRank ? a.localeCompare(b) : aRank - bRank
  }).join(' · ')
}

function preferProjectName(existing: string, next: string, path: string) {
  const fallback = pathBasename(path)
  if (!existing) return next || fallback
  if (next && existing === fallback && next !== fallback) return next
  return existing
}

function latestModifiedAt(existing: string, next: string) {
  if (!existing) return next
  if (!next) return existing
  return next.localeCompare(existing) > 0 ? next : existing
}

function normalizeWorkspaceInventoryProjects(projects: WorkspaceInventoryProject[]) {
  const byPath = new Map<string, WorkspaceInventoryProject>()

  projects.forEach((project) => {
    const path = normalizeProjectPath(project.path)
    if (!path) return

    const name = deriveProjectName(path, project.name, project.path)
    const kind = mergeProjectKinds(project.kind || 'project')
    const existing = byPath.get(path)
    if (!existing) {
      byPath.set(path, {
        path,
        kind,
        name,
        modifiedAt: project.modifiedAt,
      })
      return
    }

    existing.kind = mergeProjectKinds(existing.kind, kind)
    existing.name = preferProjectName(existing.name, name, path)
    existing.modifiedAt = latestModifiedAt(existing.modifiedAt, project.modifiedAt)
  })

  return [...byPath.values()]
}

export function normalizeWorkspaceInventory(inventory: WorkspaceInventory): WorkspaceInventory {
  return {
    ...inventory,
    projects: normalizeWorkspaceInventoryProjects(inventory.projects),
  }
}
