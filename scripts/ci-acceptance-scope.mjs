#!/usr/bin/env node
// Decides which packaged acceptance suites a list of changed paths needs. The
// first matching rule wins. A path no rule names runs every suite, so a new
// directory is covered until someone decides otherwise.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SUITES = ['ops', 'agent', 'probe', 'extension']
const NONE = []

const RULES = [
  // Harness scripts used by one journey. Shared ones fall through to every suite.
  [/^scripts\/(ci-ops-ui-live|install-ops-ui-dunst|ops-ui-(notifications|alert-notifications|probe-fixture|probe-journey|probe-notifications))[.]/, ['ops']],
  [/^scripts\/(ci-monitoring-agent-ui|run-monitoring-agent-ui|monitoring-agent-ui-(journey|report))[.]|^scripts\/monitoring-agent-ui[.]test[.]/, ['agent']],
  [/^scripts\/(ci-probe-transfer-ui|run-probe-transfer-ui)[.]|^scripts\/probe-transfer-ui-report[.]/, ['probe']],
  [/^scripts\/(probe-transfer-ui|fixtures\/probe-transfer\/)/, ['agent', 'probe']],
  [/^scripts\/(ci-extension-ui|run-extension-ui|extension-ui-(observer|report))[.]/, ['extension']],
  [/^scripts\/extension-ui/, ['agent', 'extension']],
  // Scripts that no suite runs.
  [/^scripts\/(build-|ios-|ci-ops-acme|ci-ops-live|run-ops-live|mcp-readonly|generate-theme-palettes|monitoring-extension)/, NONE],

  // Tests, docs and files that cannot change how the app behaves on screen.
  [/^src\/.*[.]test[.]tsx?$|^src\/test\//, NONE],
  [/^docs\/|[.]md$|^LICENSE$|^TRADEMARK[.]md$|^[.]vscode\/|^[.]git(ignore|attributes)$|^[.]env[.]example$/, NONE],
  [/^eslint[.]config[.]js$|^vitest[.]/, NONE],
  [/^src\/assets\/|^src\/styles\/theme-palettes[.]css$/, NONE],

  // Surfaces no journey opens.
  [/^src\/components\/(.*\/)?(ai-|sftp-|mobile)/, NONE],

  // Surfaces only some journeys open.
  [/^src\/components\/probe-transfer/, ['agent', 'probe']],
  [/^src\/components\/(compatible-agent|probe-install|probe-batch|agent-deployments)/, ['agent', 'probe']],
  [/^src\/components\/(notification-|local-alert|host-notification-rules|host-alerts|probe-alert-runtime)/, ['ops']],
  [/^src\/components\/komari-/, ['agent', 'probe', 'extension']],
  [/^monitoring-extension\//, ['agent', 'extension']],
  [/^releases\//, ['agent', 'probe']],

  // Parts of the repository the Linux acceptance package never contains.
  [/^src-tauri\/tests\/fixtures\/notifications-session[.]conf$/, SUITES],
  [/^agent\/|^src-tauri\/(gen|tests)\/|^src-tauri\/Entitlements[.]plist$/, NONE],
  [/^[.]github\/workflows\/(?!packaged-acceptance[.]yml$)/, NONE],
]

export function suitesForPath(path) {
  for (const [pattern, suites] of RULES) if (pattern.test(path)) return suites
  return SUITES
}

export function selectSuites(paths) {
  const selected = new Set(paths.flatMap(suitesForPath))
  return Object.fromEntries(SUITES.map((suite) => [suite, selected.has(suite)]))
}

export function formatOutputs(selection) {
  const lines = SUITES.map((suite) => `${suite}=${selection[suite]}`)
  return [...lines, `build=${SUITES.some((suite) => selection[suite])}`].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = readFileSync(0, 'utf8').split('\n').filter(Boolean)
  console.log(formatOutputs(selectSuites(paths)))
}
