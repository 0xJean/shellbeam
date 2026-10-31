// Generate shellbeam-app/src/styles/theme-palettes.css from the v3 design tokens.
// Usage: node scripts/generate-theme-palettes.mjs docs/design/shellbeam-designs/v3/tokens.css src/styles/theme-palettes.css
import { readFileSync, writeFileSync } from 'node:fs'

const [, , src, out] = process.argv
const css = readFileSync(src, 'utf8')

// Collect `--name: value` declarations for every block whose selector matches `sel` exactly.
function block(sel) {
  const vars = {}
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim())
    if (!sels.includes(sel)) continue
    for (const d of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim()
  }
  return vars
}

const PAL = {
  'aqua-dark': ['dark', 'blue'], midnight: ['dark', 'violet'], nord: ['dark', 'cyan'], dracula: ['dark', 'pink'], graphite: ['dark', 'amber'], ocean: ['dark', 'blue'], 'solarized-dark': ['dark', 'teal'], 'mist-dark': ['dark', 'green'],
  aqua: ['light', 'blue'], paper: ['light', 'orange'], solarized: ['light', 'teal'], mist: ['light', 'green'], lavender: ['light', 'violet'], 'nord-light': ['light', 'cyan'], 'dracula-light': ['light', 'pink'], 'ocean-light': ['light', 'blue'],
}
const ACCENTS = ['violet', 'blue', 'cyan', 'teal', 'green', 'amber', 'orange', 'pink']

function parse(c) {
  c = c.trim().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3')
  let m = c.match(/^#([0-9a-f]{6})$/i)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1)
  m = c.match(/^rgba?\(([^)]+)\)$/)
  if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return [p[0], p[1], p[2], p[3] ?? 1] }
  return null
}
const over = (fg, bg) => { const a = fg[3]; return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))).concat(1) }
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2
  let h = 0, s = 0
  if (mx !== mn) {
    const d = mx - mn
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
  }
  const f = (x) => Math.round(x * 10) / 10
  return `${f(h)} ${f(s * 100)}% ${f(l * 100)}%`
}
const hex = ([r, g, b]) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`

// Opaque HSL triplet for shadcn variables; translucent colours are composited over the page background.
function triplet(v, base) {
  const c = parse(v)
  return hsl(c[3] < 1 ? over(c, parse(base)) : c)
}
function solid(v, base) {
  const c = parse(v)
  return hex(c[3] < 1 ? over(c, parse(base)) : c)
}

const lines = [
  '/* Generated from docs/design/shellbeam-designs/v3/tokens.css — do not edit by hand.',
  '   data-dark-palette / data-light-palette swap the whole colour set for that family, and',
  '   data-dark-accent / data-light-accent set its accent (see src/lib/appearance.ts).',
  '   Selectors carry an element type so they win over the :root / .dark defaults in index.css. */',
  '',
]

for (const [id, [fam]] of Object.entries(PAL)) {
  const v = { ...block(`[data-theme="${fam}"]`), ...(id === 'midnight' || id === 'aqua' ? {} : block(`[data-theme="${fam}"][data-palette="${id}"]`)) }
  const base = v['main-bg']
  const sel = fam === 'dark' ? `html.dark[data-dark-palette="${id}"]` : `html:not(.dark)[data-light-palette="${id}"]`
  const status = (name, k) => {
    const c = parse(v[k])
    return [
      [`--workspace-status-${name}`, v[k]],
      [`--workspace-status-${name}-text`, v[`${k}-text`] ?? v[k]],
      [`--workspace-status-${name}-bg`, v[`${k}-soft`]],
      [`--workspace-status-${name}-border`, rgba(c, 0.3)],
    ]
  }
  const text3 = parse(v['text-3'])
  const decl = [
    ['--background', triplet(v.bg, base)],
    ['--foreground', triplet(v.text, base)],
    ['--card', triplet(v.surface, base)],
    ['--card-foreground', triplet(v.text, base)],
    ['--popover', triplet(v.overlay, base)],
    ['--popover-foreground', triplet(v.text, base)],
    ['--secondary', triplet(v['surface-2'], base)],
    ['--secondary-foreground', triplet(v.text, base)],
    ['--muted', triplet(v['surface-2'], base)],
    ['--muted-foreground', triplet(v['text-3'], base)],
    ['--accent', triplet(v['surface-2'], base)],
    ['--accent-foreground', triplet(v.text, base)],
    ['--destructive', triplet(v.bad, base)],
    ['--border', triplet(v.border, base)],
    ['--input', triplet(v.border, base)],
    ['--workspace-bg-950', v.bg],
    ['--workspace-bg-900', solid(v['main-bg'], base)],
    ['--workspace-bg-850', solid(v['surface-2'], base)],
    ['--workspace-content-bg', solid(v['main-bg'], base)],
    ['--workspace-surface-950', solid(v['main-bg'], base)],
    ['--workspace-surface-900', solid(v.surface, base)],
    ['--workspace-surface-800', solid(v['surface-2'], base)],
    ['--workspace-surface-700', solid(v['surface-3'], base)],
    ['--workspace-surface-panel', solid(v.surface, base)],
    ['--workspace-surface-input', solid(v.surface, base)],
    ['--workspace-surface-row', solid(v.surface, base)],
    ['--workspace-nav-translucent', v['sidebar-bg']],
    ['--workspace-nav-hover-bg', v.hover],
    ['--workspace-nav-hover-text', v.text],
    ['--workspace-border-strong', v['border-strong']],
    ['--workspace-border-soft', v.border],
    ['--workspace-text-strong', v.text],
    ['--workspace-text', v['text-2']],
    ['--workspace-text-muted', v['text-3']],
    ['--workspace-text-subtle', hex(over([...text3.slice(0, 3), 0.7], parse(base)))],
    ['--workspace-meter-track', v['meter-track']],
    ['--workspace-elevated-ring', v.border],
    ...status('good', 'ok'),
    ...status('warn', 'warn'),
    ...status('bad', 'bad'),
    ...status('info', 'info'),
    ['--workspace-metric-cpu-from', v.c4], ['--workspace-metric-cpu-to', v.c4],
    ['--workspace-metric-memory-from', v.c6], ['--workspace-metric-memory-to', v.c6],
    ['--workspace-metric-disk-from', v.c2], ['--workspace-metric-disk-to', v.c2],
    ['--workspace-metric-network-from', v.c1], ['--workspace-metric-network-to', v.c1],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`--chart-${i}`, v[`c${i}`]]),
    ['--chart-grid', v['chart-grid']], ['--chart-axis', v['chart-axis']], ['--chart-track', v['chart-track']],
  ]
  lines.push(`/* ${id} · ${fam} */`, `${sel} {`, ...decl.filter(([, x]) => x).map(([k, x]) => `  ${k}: ${x};`), '}', '')
}

function accentBlock(selector, v) {
    const c = parse(v.accent)
    lines.push(`${selector} {`,
      `  --primary: ${hsl(c)};`,
      `  --primary-foreground: ${hsl(parse(v['accent-fg']))};`,
      `  --ring: ${hsl(c)};`,
      `  --workspace-primary-500: ${v.accent};`,
      `  --workspace-primary-400: ${v['accent-hover']};`,
      `  --workspace-primary-300: ${v['accent-text']};`,
      `  --workspace-primary-foreground: ${v['accent-fg']};`,
      `  --workspace-accent-solid: ${v.accent};`,
      `  --workspace-accent-soft: ${v['accent-soft']};`,
      `  --workspace-accent-subtle: ${rgba(c, 0.08)};`,
      `  --workspace-accent-muted: ${rgba(c, 0.18)};`,
      `  --workspace-accent-text: ${v['accent-text']};`,
      // A row is far larger than a nav item, so it takes a lighter tint than accent-soft.
      `  --workspace-surface-row-selected: ${v['accent-row'] ?? rgba(c, 0.07)};`,
      `  --workspace-nav-active-bg: ${v['accent-soft']};`,
      `  --workspace-nav-active-text: ${v['accent-text']};`,
      `  --workspace-border-glow: ${rgba(c, 0.48)};`,
      `  --workspace-metric-cpu-glow: ${rgba(c, 0.14)};`,
      `  --workspace-mobile-accent: ${v.accent};`,
      '}', '')
}

for (const fam of ['dark', 'light']) {
  const famSel = fam === 'dark' ? 'html.dark' : 'html:not(.dark)'
  for (const a of ACCENTS) {
    const v = block(`[data-theme="${fam}"][data-accent="${a}"]`)
    if (!v.accent) throw new Error(`missing accent ${fam}/${a}`)
    accentBlock(`${famSel}[data-${fam}-accent="${a}"]`, v)
  }
}

// Aqua Dark shares Aqua's exact blue instead of the brighter dark-family one.
accentBlock('html.dark[data-dark-palette="aqua-dark"][data-dark-accent="blue"]', block('[data-theme="dark"][data-palette="aqua-dark"][data-accent="blue"]'))

writeFileSync(out, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'))
console.log('wrote', out)
