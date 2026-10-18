#!/usr/bin/env node
/** Explicit, disposable GitHub-hosted Linux acceptance. Never runs against a
 * saved host/Vault or loads production credentials. The shell fixture owns all
 * Docker/nginx resources; the cfg(test) bridge owns its SSH children. */
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bridgeTest = 'ssh::ops_smoke::tests::ops_live_bridge'
const bridgeArgs = ['--exact', bridgeTest, '--ignored', '--nocapture', '--test-threads=1']

export function isWithin(parent, child) {
  const path = relative(parent, child)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function validateFixtureFields(fixture) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)
    || !/^[a-f0-9]{64}$/.test(fixture.containerId ?? '')
    || !/^shellbeam-ops-live-[a-z0-9-]+$/.test(fixture.containerName ?? '')
    || !/^shellbeam-ops-live-[a-z0-9-]+\.test$/.test(fixture.siteName ?? '')
    || !Array.isArray(fixture.domains) || fixture.domains.length !== 2
    || fixture.domains[0] !== fixture.siteName || fixture.domains[1] !== `www.${fixture.siteName}`
    || !Number.isInteger(fixture.httpsPort) || fixture.httpsPort < 1024 || fixture.httpsPort > 65535
    || !/^\/etc\/ssl\/certs\/shellbeam-ops-live-[a-z0-9-]+\.pem$/.test(fixture.certificatePath ?? '')
    || typeof fixture.rootFixtureDir !== 'string' || !isAbsolute(fixture.rootFixtureDir)) {
    throw new Error('ops_live_fixture_invalid')
  }
  const peer = fixture.peer
  const acme = fixture.acme
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)
    || !/^[a-f0-9]{64}$/.test(peer.containerId ?? '') || peer.containerId === fixture.containerId
    || peer.containerName !== fixture.containerName
    || peer.dockerHost !== `unix://${join(fixture.rootFixtureDir, 'peer.sock')}`
    || !acme || typeof acme !== 'object' || Array.isArray(acme)
    || acme.managedCertificatePath !== `/etc/letsencrypt/live/${fixture.containerName}/fullchain.pem`
    || acme.certbotBinPath !== join(fixture.rootFixtureDir, 'acme', 'venv', 'bin')
    || typeof acme.transportCAPath !== 'string' || !isWithin(join(fixture.rootFixtureDir, 'acme'), acme.transportCAPath)
    || typeof acme.issuerCAPath !== 'string' || !isWithin(join(fixture.rootFixtureDir, 'acme'), acme.issuerCAPath)) {
    throw new Error('ops_live_fixture_invalid')
  }
  return fixture
}

function requireHostedLinux() {
  if (process.platform !== 'linux' || process.env.RUNNER_OS !== 'Linux' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('ops_live_requires_disposable_github_hosted_linux')
  }
}

/** Keep builds and Vitest bounded; a failed observer never restarts a process. */
async function runProcess(command, args, { env = process.env, capture = false, timeoutMs = 600_000 } = {}) {
  const child = spawn(command, args, { cwd: project, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] })
  let timedOut = false
  let stderr = ''
  let force
  const stop = () => {
    child.kill('SIGTERM')
    force = setTimeout(() => child.kill('SIGKILL'), 5_000)
    force.unref()
  }
  const interrupt = () => stop()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  const artifacts = []
  if (capture) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const event = JSON.parse(line)
        if (event.reason === 'compiler-artifact' && event.profile?.test && event.target?.name === 'app_lib' && event.executable) artifacts.push(event.executable)
      } catch { /* cargo's human-readable status is not an artifact */ }
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16_384) })
  }
  try {
    const result = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => done({ code, signal }))
    })
    if (timedOut) throw new Error('ops_live_process_deadline_exceeded')
    if (result.code !== 0) {
      if (capture && stderr) process.stderr.write(stderr)
      throw new Error(`ops_live_process_failed:${result.code ?? result.signal}`)
    }
    return artifacts
  } finally {
    clearTimeout(timer)
    clearTimeout(force)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

async function buildBridge(outputPath) {
  requireHostedLinux()
  if (!outputPath) throw new Error('ops_live_build_output_required')
  const artifacts = await runProcess('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--lib', '--no-run', '--message-format=json'], { capture: true })
  const binary = artifacts.at(-1)
  if (!binary || !isWithin(join(project, 'src-tauri', 'target'), resolve(binary))) throw new Error('ops_live_bridge_artifact_missing')
  await writeFile(outputPath, `${await realpath(binary)}\n`, { mode: 0o600 })
  console.log('Built the native cfg(test) Ops bridge; no fixture or service started.')
}

async function runFixture(fixturePath) {
  requireHostedLinux()
  if (process.env.SHELLBEAM_OPS_LIVE !== '1') throw new Error('ops_live_requires_explicit_opt_in')
  if (process.getuid?.() !== 0) throw new Error('ops_live_fixture_requires_disposable_runner_root')
  const filename = await realpath(fixturePath)
  const file = await lstat(filename)
  if (!file.isFile() || file.uid !== 0 || (file.mode & 0o077) !== 0 || file.size > 16_384) throw new Error('ops_live_fixture_permissions_invalid')
  const fixture = validateFixtureFields(JSON.parse(await readFile(filename, 'utf8')))
  const root = await realpath(fixture.rootFixtureDir)
  const runnerTemp = await realpath(process.env.RUNNER_TEMP ?? '')
  if (!basename(root).startsWith('shellbeam-ops-live-') || !isWithin(runnerTemp, root) || !isWithin(root, filename)) throw new Error('ops_live_fixture_scope_invalid')
  const state = join(root, 'bridge-state')
  await mkdir(state, { mode: 0o700 })
  await chmod(state, 0o700)
  const bridge = await realpath(process.env.SHELLBEAM_OPS_LIVE_BRIDGE ?? '')
  if (!isWithin(join(project, 'src-tauri', 'target'), bridge)) throw new Error('ops_live_bridge_scope_invalid')
  const env = {
    ...process.env,
    SHELLBEAM_OPS_LIVE: '1',
    SHELLBEAM_OPS_LIVE_BRIDGE: bridge,
    SHELLBEAM_OPS_LIVE_BRIDGE_ARGS: JSON.stringify(bridgeArgs),
    SHELLBEAM_OPS_LIVE_STATE_DIR: state,
    SHELLBEAM_OPS_LIVE_FIXTURE_FILE: filename,
    SHELLBEAM_OPS_CONTAINER_ID: fixture.containerId,
    SHELLBEAM_OPS_CONTAINER_NAME: fixture.containerName,
    SHELLBEAM_OPS_SITE_NAME: fixture.siteName,
    SHELLBEAM_OPS_CERTIFICATE_PATH: fixture.certificatePath,
    SHELLBEAM_OPS_DOMAINS: JSON.stringify(fixture.domains),
  }
  let success = false
  let evidence = null
  try {
    const resultsPath = join(root, 'vitest-results.json')
    await runProcess(process.execPath, [join(project, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.ops-live.config.ts', '--reporter=default', '--reporter=json', `--outputFile=${resultsPath}`], { env, timeoutMs: 600_000 })
    const results = JSON.parse(await readFile(resultsPath, 'utf8'))
    if (results.numFailedTests !== 0 || results.numPendingTests !== 0 || results.numPassedTests < 1 || results.numPassedTests !== results.numTotalTests) throw new Error('ops_live_requires_executed_passing_tests_without_skips')
    evidence = { passed: results.numPassedTests, skipped: results.numPendingTests, assertions: results.testResults.flatMap((suite) => suite.assertionResults.filter((test) => test.status === 'passed').map((test) => test.fullName)) }
    success = true
  } finally {
    if (process.env.SHELLBEAM_OPS_LIVE_REPORT) {
      const report = resolve(process.env.SHELLBEAM_OPS_LIVE_REPORT)
      if (!isWithin(runnerTemp, report) || !basename(report).startsWith('shellbeam-ops-live-')) throw new Error('ops_live_report_scope_invalid')
      // Only this redacted summary is readable by the runner's artifact step;
      // fixture credentials and the full test report stay in the private root.
      await writeFile(report, JSON.stringify({ schemaVersion: 1, success, evidence, node: process.version, checkedOutCommit: process.env.GITHUB_SHA ?? null, routes: ['direct', 'proxy-jump'], resources: ['two independent Docker daemons', 'two independent SSH targets', 'systemd nginx', 'OpenSSL certificate', 'private ACME HTTP-01 / Certbot'], boundary: 'cfg(test) IPC bridge and isolated endpoints on one Linux kernel; no production Vault, desktop dialog or public CA validation' }, null, 2) + '\n', { mode: 0o644 })
      await chmod(report, 0o644)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--build' && args.length === 2) await buildBridge(resolve(args[1]))
    else if (args.length === 1 && !args[0].startsWith('--')) await runFixture(args[0])
    else throw new Error('Usage: run-ops-live.mjs --build <binary-path-file> | <fixture.json>')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
