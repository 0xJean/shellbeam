import { useMemo } from 'react'
import { Server } from 'lucide-react'
import amazonIconUrl from '@/assets/os-icons/amazon.svg'
import archIconUrl from '@/assets/os-icons/arch.svg'
import centosIconUrl from '@/assets/os-icons/centos.svg'
import debianIconUrl from '@/assets/os-icons/debian.svg'
import fedoraIconUrl from '@/assets/os-icons/fedora.svg'
import freebsdIconUrl from '@/assets/os-icons/freebsd.svg'
import linuxIconUrl from '@/assets/os-icons/linux.svg'
import redhatIconUrl from '@/assets/os-icons/redhat.svg'
import almalinuxIconUrl from '@/assets/os-icons/almalinux.svg'
import rockylinuxIconUrl from '@/assets/os-icons/rockylinux.svg'
import suseIconUrl from '@/assets/os-icons/suse.svg'
import ubuntuIconUrl from '@/assets/os-icons/ubuntu.svg'
import { cn } from '@/lib/utils'

interface WorkspaceOsIconConfig {
  slug: string
  iconUrl?: string
}

const OS_ICON_CONFIGS: Array<[RegExp, WorkspaceOsIconConfig]> = [
  [/ubuntu/i, { slug: 'ubuntu', iconUrl: ubuntuIconUrl }],
  [/debian/i, { slug: 'debian', iconUrl: debianIconUrl }],
  [/centos/i, { slug: 'centos', iconUrl: centosIconUrl }],
  [/rocky/i, { slug: 'rockylinux', iconUrl: rockylinuxIconUrl }],
  [/alma/i, { slug: 'almalinux', iconUrl: almalinuxIconUrl }],
  [/red hat|rhel/i, { slug: 'redhat', iconUrl: redhatIconUrl }],
  [/fedora/i, { slug: 'fedora', iconUrl: fedoraIconUrl }],
  [/arch/i, { slug: 'archlinux', iconUrl: archIconUrl }],
  [/alpine/i, { slug: 'alpinelinux' }],
  [/opensuse|suse/i, { slug: 'opensuse', iconUrl: suseIconUrl }],
  [/oracle/i, { slug: 'oracle' }],
  [/amazon/i, { slug: 'amazonlinux', iconUrl: amazonIconUrl }],
  [/freebsd/i, { slug: 'freebsd', iconUrl: freebsdIconUrl }],
  [/linux/i, { slug: 'linux', iconUrl: linuxIconUrl }],
]

const fallbackPalette: Record<string, { bg: string; fg: string; accent?: string }> = {
  rockylinux: { bg: '#10B981', fg: '#fff', accent: '#1F7A4D' },
  almalinux: { bg: '#0F172A', fg: '#22C55E', accent: '#38BDF8' },
  alpinelinux: { bg: '#0D597F', fg: '#fff', accent: '#8DD7F7' },
  oracle: { bg: '#C74634', fg: '#fff' },
}

export function getWorkspaceOsIconConfig(os: string | null | undefined) {
  const value = os?.trim()
  if (!value) return undefined
  return OS_ICON_CONFIGS.find(([pattern]) => pattern.test(value))?.[1] ?? { slug: 'linux', iconUrl: linuxIconUrl }
}

export function getWorkspaceOsIconSlug(os: string | null | undefined) {
  return getWorkspaceOsIconConfig(os)?.slug
}

interface WorkspaceOsIconProps {
  os?: string | null
  className?: string
}

function AssetOsIcon({ config, className, title }: { config: WorkspaceOsIconConfig; className?: string; title?: string }) {
  return (
    <img
      className={cn('h-4 w-4 shrink-0 object-contain', className)}
      src={config.iconUrl}
      alt=""
      data-os-icon={config.slug}
      aria-hidden="true"
      title={title}
    />
  )
}

function FallbackOsIcon({ slug, className, title }: { slug: string; className?: string; title?: string }) {
  const colors = fallbackPalette[slug] ?? { bg: '#2563EB', fg: '#fff', accent: '#93C5FD' }

  return (
    <svg viewBox="0 0 24 24" className={cn('h-4 w-4 shrink-0', className)} aria-hidden="true" data-os-icon={slug}>
      {title && <title>{title}</title>}
      <circle cx="12" cy="12" r="10" fill={colors.bg} />
      {slug === 'oracle' ? (
        <rect x="6" y="8" width="12" height="8" rx="4" fill="none" stroke={colors.fg} strokeWidth="2" />
      ) : (
        <>
          <path d="M6.2 15.7 10 8.2l2.2 4 1.5-2.5 4.1 6H6.2Z" fill={colors.fg} />
          <path d="M6.2 15.7h11.6" stroke={colors.accent ?? colors.fg} strokeWidth="1.6" strokeLinecap="round" opacity=".85" />
        </>
      )}
    </svg>
  )
}

export function WorkspaceOsIcon({ os, className }: WorkspaceOsIconProps) {
  const config = useMemo(() => getWorkspaceOsIconConfig(os), [os])
  const title = os?.trim()

  if (config?.iconUrl) return <AssetOsIcon config={config} className={className} title={title} />
  if (config?.slug) return <FallbackOsIcon slug={config.slug} className={className} title={title} />

  return <Server className={cn('h-4 w-4 shrink-0', className)} aria-hidden="true" />
}
