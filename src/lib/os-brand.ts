// Brand tint for OS badges; unknown systems fall back to the accent colour.
const OS_BRAND: Array<[RegExp, string]> = [
  [/ubuntu/i, '#E95420'], [/debian/i, '#D70A53'], [/alpine/i, '#0D9AD8'], [/rocky/i, '#10B981'], [/alma/i, '#0F4266'],
  [/centos/i, '#932279'], [/fedora/i, '#51A2DA'], [/red ?hat|rhel/i, '#EE0000'], [/arch/i, '#1793D1'], [/opensuse|suse/i, '#73BA25'],
  [/synology|dsm/i, '#8E8E93'], [/freebsd/i, '#AB2B28'], [/mac|darwin/i, '#8E8E93'], [/windows/i, '#0078D4'],
]

export function osBrandColor(os: string) {
  return OS_BRAND.find(([pattern]) => pattern.test(os))?.[1] ?? 'var(--workspace-primary-500)'
}
