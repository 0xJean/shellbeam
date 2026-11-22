#!/usr/bin/env node
// Generate src/styles/theme-palettes.css from ShellBeam's curated v4 surface & accent tokens.
// Usage: node scripts/generate-theme-palettes.mjs [out-path]
import { writeFileSync } from 'node:fs'

const out = process.argv[2] ?? 'src/styles/theme-palettes.css'

function parse(c) {
  c = c.trim().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3')
  let m = c.match(/^#([0-9a-f]{6})$/i)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1)
  m = c.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x))
    return [p[0], p[1], p[2], p[3] ?? 1]
  }
  throw new Error(`Invalid colour: ${c}`)
}
const over = (fg, bg) => {
  const a = fg[3]
  return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))).concat(1)
}
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
const triplet = (v, base) => {
  const c = parse(v)
  return hsl(c[3] < 1 ? over(c, parse(base)) : c)
}

const DARK_STATUS = {
  ok: '#34d399', okText: '#4ade80',
  warn: '#f5b041', warnText: '#fbbf24',
  bad: '#f87171', badText: '#fca5a5',
  info: '#38bdf8', infoText: '#7dd3fc',
  cpu: '#38bdf8', mem: '#a78bfa', disk: '#f59e0b', net: '#34d399',
  charts: ['#60a5fa', '#34d399', '#f59e0b', '#38bdf8', '#f472b6', '#a78bfa', '#fb7185', '#94a3b8'],
}

const LIGHT_STATUS = {
  ok: '#059669', okText: '#047857',
  warn: '#d97706', warnText: '#b45309',
  bad: '#dc2626', badText: '#b91c1c',
  info: '#0284c7', infoText: '#0369a1',
  cpu: '#0284c7', mem: '#7c3aed', disk: '#d97706', net: '#059669',
  charts: ['#2563eb', '#059669', '#d97706', '#0284c7', '#db2777', '#7c3aed', '#e11d48', '#64748b'],
}

/**
 * Curated 4-step surface palettes (L0 frame/sidebar -> L1 canvas -> L2 card/panel -> L3 popover)
 * paired with translucent hairline borders and high-contrast WCAG AA typography.
 */
const PALETTES = {
  // ── Dark palettes ────────────────────────────────────────────────────────────
  obsidian: {
    family: 'dark', defaultAccent: 'blue',
    frame: '#0b0d12', canvas: '#10131b', surface: '#161b26', surface2: '#1d2332', surface3: '#262e41', popover: '#1c2230',
    sidebarBg: 'rgba(11, 13, 18, 0.88)',
    borderSoft: 'rgba(255, 255, 255, 0.075)', borderStrong: 'rgba(255, 255, 255, 0.145)',
    hover: 'rgba(255, 255, 255, 0.05)', meterTrack: 'rgba(255, 255, 255, 0.09)',
    textStrong: '#f3f5fa', text: '#cbd2e1', textMuted: '#8892a8', textSubtle: '#5e677d',
    signatureAccent: { accent: '#5e8bff', hover: '#799fff', text: '#8cb0ff', fg: '#ffffff' },
  },
  'tokyo-night': {
    family: 'dark', defaultAccent: 'blue',
    frame: '#13141c', canvas: '#1a1b26', surface: '#222436', surface2: '#292d42', surface3: '#343952', popover: '#25283b',
    sidebarBg: 'rgba(19, 20, 28, 0.9)',
    borderSoft: 'rgba(169, 177, 214, 0.1)', borderStrong: 'rgba(169, 177, 214, 0.18)',
    hover: 'rgba(122, 162, 247, 0.08)', meterTrack: 'rgba(169, 177, 214, 0.12)',
    textStrong: '#e6ecff', text: '#c0caf5', textMuted: '#8691b8', textSubtle: '#5c6587',
    signatureAccent: { accent: '#7aa2f7', hover: '#93b4fb', text: '#9ab8ff', fg: '#13141c' },
  },
  catppuccin: {
    family: 'dark', defaultAccent: 'violet',
    frame: '#161622', canvas: '#1e1e2e', surface: '#26263a', surface2: '#303048', surface3: '#3b3b57', popover: '#29293e',
    sidebarBg: 'rgba(22, 22, 34, 0.9)',
    borderSoft: 'rgba(205, 214, 244, 0.09)', borderStrong: 'rgba(205, 214, 244, 0.17)',
    hover: 'rgba(180, 190, 254, 0.08)', meterTrack: 'rgba(205, 214, 244, 0.12)',
    textStrong: '#eef1ff', text: '#cdd6f4', textMuted: '#9399b2', textSubtle: '#6c7086',
    signatureAccent: { accent: '#b4befe', hover: '#c7cfff', text: '#c4ccff', fg: '#161622' },
    status: { ok: '#a6e3a1', okText: '#a6e3a1', warn: '#f9e2af', warnText: '#f9e2af', bad: '#f38ba8', badText: '#f38ba8', info: '#89dceb', infoText: '#89dceb', cpu: '#89dceb', mem: '#cba6f7', disk: '#fab387', net: '#a6e3a1' },
  },
  'rose-pine': {
    family: 'dark', defaultAccent: 'pink',
    frame: '#14121d', canvas: '#191724', surface: '#221f31', surface2: '#2b273d', surface3: '#37324d', popover: '#262337',
    sidebarBg: 'rgba(20, 18, 29, 0.9)',
    borderSoft: 'rgba(224, 222, 244, 0.09)', borderStrong: 'rgba(224, 222, 244, 0.17)',
    hover: 'rgba(235, 188, 186, 0.08)', meterTrack: 'rgba(224, 222, 244, 0.11)',
    textStrong: '#f3f1fb', text: '#e0def4', textMuted: '#9e9ab8', textSubtle: '#6e6a86',
    signatureAccent: { accent: '#ebbcba', hover: '#f2ccc9', text: '#f0c6c4', fg: '#191724' },
    status: { ok: '#9ccfd8', okText: '#9ccfd8', warn: '#f6c177', warnText: '#f6c177', bad: '#eb6f92', badText: '#f08aa6', info: '#c4a7e7', infoText: '#c4a7e7', cpu: '#9ccfd8', mem: '#c4a7e7', disk: '#f6c177', net: '#31748f' },
  },
  nord: {
    family: 'dark', defaultAccent: 'cyan',
    frame: '#1b1f28', canvas: '#222733', surface: '#2a303e', surface2: '#333a4b', surface3: '#3f475b', popover: '#2e3545',
    sidebarBg: 'rgba(27, 31, 40, 0.9)',
    borderSoft: 'rgba(216, 222, 233, 0.09)', borderStrong: 'rgba(216, 222, 233, 0.18)',
    hover: 'rgba(136, 192, 208, 0.08)', meterTrack: 'rgba(216, 222, 233, 0.12)',
    textStrong: '#eceff4', text: '#d8dee9', textMuted: '#9aa5b8', textSubtle: '#6d788e',
    signatureAccent: { accent: '#88c0d0', hover: '#9dcedb', text: '#99ccd9', fg: '#1b1f28' },
    status: { ok: '#a3be8c', okText: '#a3be8c', warn: '#ebcb8b', warnText: '#ebcb8b', bad: '#bf616a', badText: '#d67b83', info: '#81a1c1', infoText: '#8fbcbb', cpu: '#88c0d0', mem: '#b48ead', disk: '#ebcb8b', net: '#a3be8c' },
  },
  graphite: {
    family: 'dark', defaultAccent: 'amber',
    frame: '#131210', canvas: '#1a1816', surface: '#23211d', surface2: '#2d2a25', surface3: '#38342e', popover: '#262420',
    sidebarBg: 'rgba(19, 18, 16, 0.9)',
    borderSoft: 'rgba(240, 234, 224, 0.08)', borderStrong: 'rgba(240, 234, 224, 0.16)',
    hover: 'rgba(229, 169, 60, 0.08)', meterTrack: 'rgba(240, 234, 224, 0.11)',
    textStrong: '#f5f1ea', text: '#d6cfc4', textMuted: '#999184', textSubtle: '#6c655a',
    signatureAccent: { accent: '#e5a93c', hover: '#eebc5e', text: '#f0bd5e', fg: '#161411' },
  },
  'emerald-ops': {
    family: 'dark', defaultAccent: 'green',
    frame: '#0b1210', canvas: '#101a17', surface: '#172420', surface2: '#1e2f2a', surface3: '#273d37', popover: '#192924',
    sidebarBg: 'rgba(11, 18, 16, 0.9)',
    borderSoft: 'rgba(209, 250, 229, 0.08)', borderStrong: 'rgba(209, 250, 229, 0.16)',
    hover: 'rgba(52, 211, 153, 0.08)', meterTrack: 'rgba(209, 250, 229, 0.11)',
    textStrong: '#edf7f3', text: '#c5dcd3', textMuted: '#7fa195', textSubtle: '#557268',
    signatureAccent: { accent: '#34d399', hover: '#4ee0ab', text: '#5ee3b3', fg: '#0a1410' },
  },
  'solarized-dark': {
    family: 'dark', defaultAccent: 'teal',
    frame: '#00212a', canvas: '#002b36', surface: '#073642', surface2: '#0d4351', surface3: '#145161', popover: '#093c49',
    sidebarBg: 'rgba(0, 33, 42, 0.92)',
    borderSoft: 'rgba(147, 161, 161, 0.14)', borderStrong: 'rgba(147, 161, 161, 0.24)',
    hover: 'rgba(42, 161, 152, 0.1)', meterTrack: 'rgba(147, 161, 161, 0.16)',
    textStrong: '#eee8d5', text: '#b5c2c2', textMuted: '#839496', textSubtle: '#586e75',
    signatureAccent: { accent: '#2aa198', hover: '#38b6ac', text: '#42c4ba', fg: '#00212a' },
  },

  // ── Light palettes ───────────────────────────────────────────────────────────
  'obsidian-light': {
    family: 'light', defaultAccent: 'blue',
    frame: '#eef1f6', canvas: '#f7f8fb', surface: '#ffffff', surface2: '#f1f4f9', surface3: '#e5eaf2', popover: '#ffffff',
    sidebarBg: 'rgba(238, 241, 246, 0.86)',
    borderSoft: 'rgba(15, 23, 42, 0.08)', borderStrong: 'rgba(15, 23, 42, 0.15)',
    hover: 'rgba(15, 23, 42, 0.045)', meterTrack: 'rgba(15, 23, 42, 0.09)',
    textStrong: '#0f172a', text: '#334155', textMuted: '#64748b', textSubtle: '#8e9bb0',
    signatureAccent: { accent: '#2563eb', hover: '#1d4ed8', text: '#1d4ed8', fg: '#ffffff' },
  },
  'tokyo-night-light': {
    family: 'light', defaultAccent: 'blue',
    frame: '#e4e6ee', canvas: '#f1f2f7', surface: '#fafbfd', surface2: '#eaecf4', surface3: '#dde0ec', popover: '#ffffff',
    sidebarBg: 'rgba(228, 230, 238, 0.88)',
    borderSoft: 'rgba(55, 65, 105, 0.1)', borderStrong: 'rgba(55, 65, 105, 0.18)',
    hover: 'rgba(46, 125, 233, 0.06)', meterTrack: 'rgba(55, 65, 105, 0.1)',
    textStrong: '#1f2335', text: '#374166', textMuted: '#616d91', textSubtle: '#8792b2',
    signatureAccent: { accent: '#2e7de9', hover: '#1e6bd6', text: '#2468c8', fg: '#ffffff' },
  },
  'catppuccin-light': {
    family: 'light', defaultAccent: 'violet',
    frame: '#e6e9ef', canvas: '#eff1f5', surface: '#fafbfe', surface2: '#e9ecf2', surface3: '#dce0e8', popover: '#ffffff',
    sidebarBg: 'rgba(230, 233, 239, 0.88)',
    borderSoft: 'rgba(76, 79, 105, 0.1)', borderStrong: 'rgba(76, 79, 105, 0.18)',
    hover: 'rgba(114, 135, 253, 0.07)', meterTrack: 'rgba(76, 79, 105, 0.1)',
    textStrong: '#303246', text: '#4c4f69', textMuted: '#6c6f85', textSubtle: '#8c8fa1',
    signatureAccent: { accent: '#7287fd', hover: '#5a71f5', text: '#5569e6', fg: '#ffffff' },
  },
  'rose-pine-light': {
    family: 'light', defaultAccent: 'pink',
    frame: '#f2e9de', canvas: '#faf4ed', surface: '#fffdf9', surface2: '#f4ece2', surface3: '#e7ddd0', popover: '#fffdf9',
    sidebarBg: 'rgba(242, 233, 222, 0.88)',
    borderSoft: 'rgba(87, 82, 121, 0.11)', borderStrong: 'rgba(87, 82, 121, 0.2)',
    hover: 'rgba(180, 99, 122, 0.07)', meterTrack: 'rgba(87, 82, 121, 0.11)',
    textStrong: '#393552', text: '#575279', textMuted: '#797593', textSubtle: '#9893a5',
    signatureAccent: { accent: '#b4637a', hover: '#9f5268', text: '#9b4d63', fg: '#ffffff' },
  },
  'nord-light': {
    family: 'light', defaultAccent: 'cyan',
    frame: '#e5e9f0', canvas: '#eef1f6', surface: '#f9fafc', surface2: '#e8ecf3', surface3: '#d8dee9', popover: '#ffffff',
    sidebarBg: 'rgba(229, 233, 240, 0.88)',
    borderSoft: 'rgba(46, 52, 64, 0.09)', borderStrong: 'rgba(46, 52, 64, 0.17)',
    hover: 'rgba(14, 116, 144, 0.06)', meterTrack: 'rgba(46, 52, 64, 0.1)',
    textStrong: '#242933', text: '#3b4252', textMuted: '#5e6a80', textSubtle: '#828ea3',
    signatureAccent: { accent: '#0e7490', hover: '#0b5f77', text: '#0b637c', fg: '#ffffff' },
  },
  'graphite-light': {
    family: 'light', defaultAccent: 'amber',
    frame: '#ede7dc', canvas: '#f6f2ea', surface: '#fffdf9', surface2: '#efeae0', surface3: '#e3dcd0', popover: '#fffdf9',
    sidebarBg: 'rgba(237, 231, 220, 0.88)',
    borderSoft: 'rgba(67, 61, 51, 0.1)', borderStrong: 'rgba(67, 61, 51, 0.18)',
    hover: 'rgba(180, 83, 9, 0.06)', meterTrack: 'rgba(67, 61, 51, 0.1)',
    textStrong: '#29241e', text: '#4a4338', textMuted: '#756c5e', textSubtle: '#998f80',
    signatureAccent: { accent: '#b45309', hover: '#9a4507', text: '#9a4507', fg: '#ffffff' },
  },
  'emerald-ops-light': {
    family: 'light', defaultAccent: 'green',
    frame: '#e7f0ec', canvas: '#f2f7f5', surface: '#fbfdfc', surface2: '#e9f2ee', surface3: '#d7e6e0', popover: '#ffffff',
    sidebarBg: 'rgba(231, 240, 236, 0.88)',
    borderSoft: 'rgba(17, 52, 42, 0.09)', borderStrong: 'rgba(17, 52, 42, 0.17)',
    hover: 'rgba(5, 150, 105, 0.06)', meterTrack: 'rgba(17, 52, 42, 0.1)',
    textStrong: '#132a23', text: '#2c4a40', textMuted: '#547368', textSubtle: '#7b998e',
    signatureAccent: { accent: '#059669', hover: '#047857', text: '#047857', fg: '#ffffff' },
  },
  solarized: {
    family: 'light', defaultAccent: 'teal',
    frame: '#ede7d3', canvas: '#f8f1dc', surface: '#fdf6e3', surface2: '#f1ead5', surface3: '#e4dcc4', popover: '#fffdf5',
    sidebarBg: 'rgba(237, 231, 211, 0.9)',
    borderSoft: 'rgba(88, 110, 117, 0.14)', borderStrong: 'rgba(88, 110, 117, 0.24)',
    hover: 'rgba(15, 118, 110, 0.07)', meterTrack: 'rgba(88, 110, 117, 0.13)',
    textStrong: '#073642', text: '#445960', textMuted: '#657b83', textSubtle: '#839496',
    signatureAccent: { accent: '#0f766e', hover: '#0c5f59', text: '#0d6861', fg: '#ffffff' },
  },
}

const ACCENTS = {
  dark: {
    violet: { accent: '#8b7cf8', hover: '#9f93fa', text: '#b3a8ff', fg: '#ffffff' },
    blue:   { accent: '#5e8bff', hover: '#799fff', text: '#8cb0ff', fg: '#ffffff' },
    cyan:   { accent: '#38bdf8', hover: '#5ecbfa', text: '#7dd3fc', fg: '#091520' },
    teal:   { accent: '#2dd4bf', hover: '#4ce0cd', text: '#5eead4', fg: '#071a18' },
    green:  { accent: '#34d399', hover: '#4ee0ab', text: '#6ee7b7', fg: '#071a12' },
    amber:  { accent: '#e5a93c', hover: '#eebc5e', text: '#f4c76b', fg: '#171207' },
    orange: { accent: '#fb923c', hover: '#fca75e', text: '#fdba74', fg: '#1a0e05' },
    pink:   { accent: '#f472b6', hover: '#f78ec5', text: '#f9a8d4', fg: '#1f0a15' },
  },
  light: {
    violet: { accent: '#6d5ce7', hover: '#5b49db', text: '#5b49db', fg: '#ffffff' },
    blue:   { accent: '#2563eb', hover: '#1d4ed8', text: '#1d4ed8', fg: '#ffffff' },
    cyan:   { accent: '#0284c7', hover: '#0369a1', text: '#0369a1', fg: '#ffffff' },
    teal:   { accent: '#0d9488', hover: '#0f766e', text: '#0f766e', fg: '#ffffff' },
    green:  { accent: '#059669', hover: '#047857', text: '#047857', fg: '#ffffff' },
    amber:  { accent: '#b45309', hover: '#92400e', text: '#92400e', fg: '#ffffff' },
    orange: { accent: '#c25200', hover: '#9e4200', text: '#9e4200', fg: '#ffffff' },
    pink:   { accent: '#c0266b', hover: '#9d1754', text: '#9d1754', fg: '#ffffff' },
  },
}

const lines = [
  '/* Generated by scripts/generate-theme-palettes.mjs — do not edit by hand.',
  '   data-dark-palette / data-light-palette swap the 4-step surface ladder for each family, and',
  '   data-dark-accent / data-light-accent set its accent (see src/lib/appearance.ts).',
  '   Selectors carry an element type so they win over the :root / .dark defaults in index.css. */',
  '',
]

for (const [id, p] of Object.entries(PALETTES)) {
  const st = { ...(p.family === 'dark' ? DARK_STATUS : LIGHT_STATUS), ...(p.status ?? {}) }
  const base = p.canvas
  const sel = p.family === 'dark' ? `html.dark[data-dark-palette="${id}"]` : `html:not(.dark)[data-light-palette="${id}"]`
  const status = (name, k) => {
    const c = parse(st[k])
    return [
      [`--workspace-status-${name}`, st[k]],
      [`--workspace-status-${name}-text`, st[`${k}Text`] ?? st[k]],
      [`--workspace-status-${name}-bg`, rgba(c, p.family === 'dark' ? 0.13 : 0.1)],
      [`--workspace-status-${name}-border`, rgba(c, 0.28)],
    ]
  }
  const decl = [
    ['--background', triplet(p.canvas, base)],
    ['--foreground', triplet(p.textStrong, base)],
    ['--card', triplet(p.surface, base)],
    ['--card-foreground', triplet(p.textStrong, base)],
    ['--popover', triplet(p.popover, base)],
    ['--popover-foreground', triplet(p.textStrong, base)],
    ['--secondary', triplet(p.surface2, base)],
    ['--secondary-foreground', triplet(p.textStrong, base)],
    ['--muted', triplet(p.surface2, base)],
    ['--muted-foreground', triplet(p.textMuted, base)],
    ['--accent', triplet(p.surface2, base)],
    ['--accent-foreground', triplet(p.textStrong, base)],
    ['--destructive', triplet(st.bad, base)],
    ['--border', triplet(p.borderSoft, base)],
    ['--input', triplet(p.borderStrong, base)],
    ['--workspace-bg-950', p.frame],
    ['--workspace-bg-900', p.canvas],
    ['--workspace-bg-850', p.surface2],
    ['--workspace-content-bg', p.canvas],
    ['--workspace-surface-950', p.canvas],
    ['--workspace-surface-900', p.surface],
    ['--workspace-surface-800', p.surface2],
    ['--workspace-surface-700', p.surface3],
    ['--workspace-surface-panel', p.surface],
    ['--workspace-surface-input', p.surface],
    ['--workspace-surface-row', p.surface],
    ['--workspace-nav-translucent', p.sidebarBg],
    ['--workspace-nav-hover-bg', p.hover],
    ['--workspace-nav-hover-text', p.textStrong],
    ['--workspace-border-strong', p.borderStrong],
    ['--workspace-border-soft', p.borderSoft],
    ['--workspace-text-strong', p.textStrong],
    ['--workspace-text', p.text],
    ['--workspace-text-muted', p.textMuted],
    ['--workspace-text-subtle', p.textSubtle],
    ['--workspace-meter-track', p.meterTrack],
    ['--workspace-elevated-ring', p.borderSoft],
    ...status('good', 'ok'),
    ...status('warn', 'warn'),
    ...status('bad', 'bad'),
    ...status('info', 'info'),
    ['--workspace-metric-cpu-from', st.cpu], ['--workspace-metric-cpu-to', st.cpu],
    ['--workspace-metric-memory-from', st.mem], ['--workspace-metric-memory-to', st.mem],
    ['--workspace-metric-disk-from', st.disk], ['--workspace-metric-disk-to', st.disk],
    ['--workspace-metric-network-from', st.net], ['--workspace-metric-network-to', st.net],
    ...st.charts.map((color, i) => [`--chart-${i + 1}`, color]),
    ['--chart-grid', p.family === 'dark' ? 'rgba(255, 255, 255, 0.055)' : 'rgba(15, 23, 42, 0.065)'],
    ['--chart-axis', p.textMuted],
    ['--chart-track', p.family === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.05)'],
  ]
  lines.push(`/* ${id} · ${p.family} */`, `${sel} {`, ...decl.map(([k, x]) => `  ${k}: ${x};`), '}', '')
}

function accentBlock(selector, fam, v) {
  const c = parse(v.accent)
  const softAlpha = fam === 'dark' ? 0.14 : 0.11
  const subtleAlpha = fam === 'dark' ? 0.09 : 0.07
  const mutedAlpha = fam === 'dark' ? 0.2 : 0.16
  lines.push(
    `${selector} {`,
    `  --primary: ${hsl(c)};`,
    `  --primary-foreground: ${hsl(parse(v.fg))};`,
    `  --ring: ${hsl(c)};`,
    `  --workspace-primary-500: ${v.accent};`,
    `  --workspace-primary-400: ${v.hover};`,
    `  --workspace-primary-300: ${v.text};`,
    `  --workspace-primary-foreground: ${v.fg};`,
    `  --workspace-accent-solid: ${v.accent};`,
    `  --workspace-accent-soft: ${rgba(c, softAlpha)};`,
    `  --workspace-accent-subtle: ${rgba(c, subtleAlpha)};`,
    `  --workspace-accent-muted: ${rgba(c, mutedAlpha)};`,
    `  --workspace-accent-text: ${v.text};`,
    `  --workspace-surface-row-selected: ${rgba(c, fam === 'dark' ? 0.08 : 0.06)};`,
    `  --workspace-nav-active-bg: ${rgba(c, softAlpha)};`,
    `  --workspace-nav-active-text: ${v.text};`,
    `  --workspace-border-glow: ${rgba(c, 0.44)};`,
    `  --workspace-metric-cpu-glow: ${rgba(c, 0.14)};`,
    `  --workspace-mobile-accent: ${v.accent};`,
    '}',
    '',
  )
}

for (const fam of ['dark', 'light']) {
  const famSel = fam === 'dark' ? 'html.dark' : 'html:not(.dark)'
  for (const [name, v] of Object.entries(ACCENTS[fam])) {
    accentBlock(`${famSel}[data-${fam}-accent="${name}"]`, fam, v)
  }
}

// Per-palette signature accent overrides so each theme keeps its authentic native accent when matching the theme.
for (const [id, p] of Object.entries(PALETTES)) {
  if (!p.signatureAccent) continue
  const fam = p.family
  const famSel = fam === 'dark' ? 'html.dark' : 'html:not(.dark)'
  accentBlock(`${famSel}[data-${fam}-palette="${id}"][data-${fam}-accent="${p.defaultAccent}"]`, fam, p.signatureAccent)
}

writeFileSync(out, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n')
console.log('wrote', out, `(${Object.keys(PALETTES).length} palettes)`)
