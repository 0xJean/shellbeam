import { useMemo } from 'react'
import { cn } from '@/lib/utils'

const FLAG_CDN_BASE = 'https://flagcdn.com/24x18'

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  argentina: 'AR',
  australia: 'AU',
  austria: 'AT',
  belgium: 'BE',
  brazil: 'BR',
  bulgaria: 'BG',
  canada: 'CA',
  chile: 'CL',
  china: 'CN',
  czechia: 'CZ',
  'czech republic': 'CZ',
  denmark: 'DK',
  estonia: 'EE',
  finland: 'FI',
  france: 'FR',
  germany: 'DE',
  greece: 'GR',
  hongkong: 'HK',
  'hong kong': 'HK',
  'hong kong sar': 'HK',
  hungary: 'HU',
  india: 'IN',
  indonesia: 'ID',
  ireland: 'IE',
  israel: 'IL',
  italy: 'IT',
  japan: 'JP',
  korea: 'KR',
  latvia: 'LV',
  lithuania: 'LT',
  luxembourg: 'LU',
  malaysia: 'MY',
  mexico: 'MX',
  moldova: 'MD',
  netherlands: 'NL',
  'new zealand': 'NZ',
  norway: 'NO',
  philippines: 'PH',
  poland: 'PL',
  portugal: 'PT',
  'republic of korea': 'KR',
  romania: 'RO',
  russia: 'RU',
  singapore: 'SG',
  'south africa': 'ZA',
  'south korea': 'KR',
  spain: 'ES',
  sweden: 'SE',
  switzerland: 'CH',
  taiwan: 'TW',
  thailand: 'TH',
  'the netherlands': 'NL',
  turkey: 'TR',
  uae: 'AE',
  uk: 'GB',
  ukraine: 'UA',
  'united arab emirates': 'AE',
  'united kingdom': 'GB',
  'united states': 'US',
  us: 'US',
  usa: 'US',
  vietnam: 'VN',
  中国: 'CN',
  台湾: 'TW',
  香港: 'HK',
  美国: 'US',
  英国: 'GB',
  法国: 'FR',
  德国: 'DE',
  日本: 'JP',
  韩国: 'KR',
  新加坡: 'SG',
  加拿大: 'CA',
  澳大利亚: 'AU',
  荷兰: 'NL',
}

interface CountryFlagProps {
  countryCode?: string
  countryName?: string
  className?: string
}

function normalizeCountryCode(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed && /^[a-z]{2}$/i.test(trimmed) ? trimmed.toUpperCase() : undefined
}

function inferCountryCode(countryName: string | undefined) {
  const value = countryName?.trim()
  if (!value) return undefined

  const candidates = [
    value,
    ...value.split(/\s*[·,|/]\s*/),
    ...value.split(/\s+-\s+/),
  ].map((candidate) => candidate.trim().toLowerCase()).filter(Boolean)
  const prefixes = candidates.map((candidate) => (
    Object.keys(COUNTRY_NAME_TO_CODE).find((country) => candidate === country || candidate.startsWith(`${country} `))
  )).filter((candidate): candidate is string => !!candidate)

  return [...candidates, ...prefixes].map((candidate) => COUNTRY_NAME_TO_CODE[candidate]).find(Boolean)
}

export function getCountryFlagCode(countryCode: string | undefined, countryName: string | undefined) {
  return (normalizeCountryCode(countryCode) ?? inferCountryCode(countryName))?.toLowerCase()
}

export function CountryFlag({ countryCode, countryName, className }: CountryFlagProps) {
  const normalizedCode = useMemo(() => (
    getCountryFlagCode(countryCode, countryName)
  ), [countryCode, countryName])

  if (!normalizedCode) return null

  return (
    <span
      className={cn(
        'inline-flex h-3.5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[2px] border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)]',
        className,
      )}
      title={countryName ? `${countryName} (${normalizedCode.toUpperCase()})` : normalizedCode.toUpperCase()}
      aria-hidden="true"
    >
      <img
        src={`${FLAG_CDN_BASE}/${normalizedCode}.png`}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
        decoding="async"
      />
    </span>
  )
}
