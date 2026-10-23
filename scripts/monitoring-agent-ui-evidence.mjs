import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

export const serverIdentity = Object.freeze({ product: 'ShellBeam Server', product_version: '0.1.0-dev', version: '1.6.0', hash: '0bbcac62ef6a012357e935108090c1e16900126c', upstream_version: '1.6.0', upstream_commit: '1b76b7ad5bc3de6529bb7f0577069b4ac241fec3' })
export function verifyServerIdentity(actual) {
  for (const [key, value] of Object.entries(serverIdentity)) assert.equal(actual[key], value, 'agent_ui_server_identity')
}
export const historicalCatalog = 'https://github.com/0xJean/shellbeam/releases/download/monitoring-probe-v1.5.11-r1/catalog.json'
export const historicalCatalogPin = Object.freeze({ size: 1248, sha256: '3e30865c816e0dd87d50438378a542b589bcf2b4d754933c0745ff33b2863b69' })
export const reviewed = JSON.parse(await readFile(new URL('../releases/compatible-probe-pins.json', import.meta.url))).versions
// Read original CPU and time together. Missing usage is not fabricated as 0;
// heartbeat/load-only data cannot prove that CPU collection resumed.
export function rawCpuSamples(value, node, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return []
  if (Array.isArray(value)) return value.flatMap(v => rawCpuSamples(v, node, depth + 1))
  if ('cpu' in value) {
    assert.equal(value.uuid ?? value.client, node, 'agent_ui_cpu_node_mismatch')
    const cpu = typeof value.cpu === 'number' ? value.cpu : value.cpu?.usage
    if (cpu === undefined) return []
    assert(Number.isFinite(cpu) && cpu >= 0 && cpu <= 100, 'agent_ui_cpu_invalid')
    const time = Date.parse(value.updated_at ?? value.time ?? '')
    assert(Number.isSafeInteger(time) && time > 0, 'agent_ui_original_time_missing')
    return [{ cpu, time }]
  }
  return ['data', 'result', 'records'].flatMap(k => rawCpuSamples(value[k], node, depth + 1))
}
export function verifyFreshCpu(sample, { before, started, verifiedAt }) {
  assert(sample && Number.isFinite(sample.cpu) && sample.cpu >= 0 && sample.cpu <= 100, 'agent_ui_cpu_missing')
  assert(Number.isSafeInteger(sample.time) && sample.time > before && sample.time >= started - 5000 && sample.time >= verifiedAt - 60000 && sample.time <= verifiedAt + 5000, 'agent_ui_cpu_not_fresh')
}
