import type { SiteSslScanResult } from '@/lib/sites-ssl'

/**
 * Last Sites & SSL scan per host, kept so the dashboard can show certificate
 * expiry without opening an SSH session. Only names and dates are stored.
 */
export interface CachedCertificate { hostId: string; path: string; domains: string[]; notAfter: number | null; observedAt: number }

const KEY = (vaultId: string) => `shellbeam.certificates.${vaultId}`
export const CERTIFICATE_CACHE_EVENT = 'shellbeam:certificates-changed'

export function loadCachedCertificates(vaultId: string | null | undefined): CachedCertificate[] {
  if (!vaultId) return []
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(vaultId)) ?? '[]')
    return Array.isArray(raw) ? raw.filter((row) => row && typeof row.hostId === 'string' && Array.isArray(row.domains)) : []
  } catch { return [] }
}

export function rememberCertificateScan(vaultId: string | null | undefined, scan: SiteSslScanResult) {
  if (!vaultId) return
  const rows = loadCachedCertificates(vaultId).filter((row) => row.hostId !== scan.hostId)
  for (const certificate of scan.certificates) rows.push({ hostId: scan.hostId, path: certificate.path, domains: certificate.domains.slice(0, 5), notAfter: certificate.notAfter, observedAt: certificate.observedAt })
  try { localStorage.setItem(KEY(vaultId), JSON.stringify(rows.slice(-200))) } catch { /* A display cache only. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CERTIFICATE_CACHE_EVENT, { detail: { vaultId } }))
}
