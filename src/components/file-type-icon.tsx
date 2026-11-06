import { Link2, Unlink } from 'lucide-react'
import { fileIconName, type FileIconName } from '@/lib/file-icons'
import { cn } from '@/lib/utils'

const urls = import.meta.glob<string>('../assets/file-icons/*.svg', { eager: true, query: '?url', import: 'default' })
const iconUrl = (name: FileIconName) => urls[`../assets/file-icons/${name}.svg`] ?? urls['../assets/file-icons/file.svg']

/** A directory entry's file-type glyph; links carry a small link badge, broken links a broken one. */
export function FileTypeIcon({ fileName, isDir, isSymlink, linkBroken, className }: {
  fileName: string; isDir: boolean; isSymlink?: boolean; linkBroken?: boolean; className?: string
}) {
  const name = fileIconName(fileName, isDir)
  const Badge = linkBroken ? Unlink : Link2
  return <span className={cn('relative inline-flex h-4 w-4 shrink-0 md:h-3.5 md:w-3.5', className)} data-file-icon={name}>
    <img src={iconUrl(name)} alt="" aria-hidden="true" draggable={false} className={cn('h-full w-full', linkBroken && 'opacity-40 grayscale')} />
    {isSymlink && <Badge aria-hidden="true" className={cn('absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-sm bg-[var(--workspace-surface-900)]',
      linkBroken ? 'text-[var(--workspace-status-bad)]' : 'text-[var(--workspace-text-muted)]')} />}
  </span>
}
