import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import { buildDockerCommand, DOCKER_LIST_COMMAND, parseDockerContainers, runDockerContainerAction, type DockerContainer } from './docker-ops'
import { buildCertificateOperationCommand, runCertificateOperation, runSiteOperation, runSiteSslScan } from './sites-ssl'
import { getOperationJob, listOperationAudit, listOperationJobs, type OperationJob } from './operation-job'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { runBatchDockerOperation, type BatchOperationResult } from './multi-host-operations'
import type { CommandRunResult } from './sessions'

// Only the Tauri boundary and human confirmation are substituted. Commands,
// SSH/ProxyJump, Docker/nginx/OpenSSL output and SQLite jobs are all real.
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }))
const ENABLED = process.env.SHELLBEAM_OPS_LIVE === '1'
const PREFIX = '__SHELLBEAM_OPS_LIVE__'
type Route = 'direct' | 'jump'
interface ContainerFixture { containerId: string; containerName: string }
interface AcmeFixture { managedCertificatePath: string; certificateName: string; domains: string[]; issuerCAPath: string; transportCAPath: string; directoryUrl: string; initialSerial: string; initialNotAfter: number; httpsPort: number }
interface Ready {
  type: 'ready'
  vaultId: string
  hosts: Record<Route, HostProfile> & { peerJump: HostProfile }
  fixture: ContainerFixture & { siteName: string; server: 'nginx'; certificatePath: string; domains: string[]; expectedBody: string; logMarker?: string; peer: ContainerFixture; acme: AcmeFixture }
}
interface Counts { commandCount: number; mutationCount: number; executedCommandCount: number }
interface Stats extends Counts { byHost: Record<string, Counts>; commands: Array<{ hostId: string; summary: string; executed: boolean }> }
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** A real native test process, not a canned invoke response. Deliberately do
 * not print its stderr or command result bodies: CI emits only safe outcomes. */
class NativeOpsBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private pending = new Map<number, Pending>()
  private sequence = 0
  private exited: Promise<void> = Promise.resolve()
  ready!: Ready

  async start() {
    const executable = process.env.SHELLBEAM_OPS_LIVE_BRIDGE
    if (!executable) throw new Error('OPS_LIVE_BRIDGE_REQUIRED')
    const args: unknown = JSON.parse(process.env.SHELLBEAM_OPS_LIVE_BRIDGE_ARGS ?? '[]')
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('OPS_LIVE_BRIDGE_ARGS_INVALID')
    const child = spawn(executable, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stderr.resume()
    child.stdin.on('error', () => this.rejectPending())
    this.exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    this.reader = createInterface({ input: child.stdout })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OPS_LIVE_READY_TIMEOUT')), 60_000)
      child.once('error', () => { clearTimeout(timer); reject(new Error('OPS_LIVE_BRIDGE_START_FAILED')) })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('OPS_LIVE_BRIDGE_EXITED_BEFORE_READY'))
        this.rejectPending()
      })
      this.reader!.on('line', (line: string) => {
        const prefixAt = line.indexOf(PREFIX)
        if (prefixAt < 0) return
        let message: Record<string, unknown>
        try { message = JSON.parse(line.slice(prefixAt + PREFIX.length)) as Record<string, unknown> }
        catch { clearTimeout(timer); reject(new Error('OPS_LIVE_PROTOCOL_INVALID')); return }
        if (message.type === 'ready') {
          clearTimeout(timer)
          this.ready = message as unknown as Ready
          resolve()
          return
        }
        if (typeof message.id !== 'number') return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error != null) pending.reject(new Error('OPS_LIVE_NATIVE_COMMAND_FAILED'))
        else pending.resolve(message.result)
      })
    })
  }

  request<T>(command: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const child = this.child
    if (!child || child.exitCode !== null || !child.stdin.writable) return Promise.reject(new Error('OPS_LIVE_BRIDGE_NOT_RUNNING'))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('OPS_LIVE_REQUEST_TIMEOUT')) }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(`${JSON.stringify({ id, command, args })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('OPS_LIVE_REQUEST_WRITE_FAILED'))
      })
    })
  }

  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('OPS_LIVE_BRIDGE_EXITED'))
    }
    this.pending.clear()
  }

  async stop() {
    const child = this.child
    if (!child) return true
    let forced = false
    if (child.exitCode === null) {
      try { await this.request('ops_live_control', { action: 'shutdown' }, 5000) }
      catch { /* The outer fixture runner also owns process cleanup. */ }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(() => { forced = true; child.kill('SIGTERM'); resolve() }, 5000) })])
      if (timer) clearTimeout(timer)
    }
    this.reader?.close()
    this.rejectPending()
    this.child = null
    return !forced && child.exitCode === 0
  }

  async restart() {
    const previousPid = this.child?.pid
    if (!await this.stop()) throw new Error('OPS_LIVE_BRIDGE_RESTART_REQUIRES_CLEAN_EXIT')
    await this.start()
    if (this.child?.pid === previousPid) throw new Error('OPS_LIVE_BRIDGE_PROCESS_DID_NOT_CHANGE')
  }
}

const bridge = new NativeOpsBridge()
const routes = ['direct', 'jump'] as const
const retainedJobs: Array<Pick<OperationJob, 'jobId' | 'hostId' | 'status' | 'confirmationStatus' | 'transport'>> = []
const retainedBatches: Array<{ batchId: string; jobs: Array<Pick<OperationJob, 'jobId' | 'hostId' | 'status' | 'confirmationStatus' | 'transport' | 'requestId' | 'source' | 'provider'>> }> = []
const resolveAuthSecret = async () => { throw new Error('OPS_LIVE_CREDENTIALS_MUST_REMAIN_NATIVE') }
const stats = () => bridge.request<Stats>('ops_live_control', { action: 'stats' })
const jobs = (host: HostProfile) => listOperationJobs({ vaultId: bridge.ready.vaultId, hostId: host.id, source: 'workspace', limit: 500 })
const control = (action: string, hostId?: string) => bridge.request('ops_live_control', { action, ...(hostId ? { hostId } : {}) })

function retain(job: OperationJob) {
  retainedJobs.push({ jobId: job.jobId, hostId: job.hostId, status: job.status, confirmationStatus: job.confirmationStatus, transport: job.transport })
}
async function containerFor(host: HostProfile, fixture: ContainerFixture = bridge.ready.fixture): Promise<DockerContainer> {
  const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: DOCKER_LIST_COMMAND, audit: { action: 'docker.list', target: 'containers' } })
  expect(result.exitCode, 'real Docker list must complete').toBe(0)
  const row = parseDockerContainers(result.stdout).find((entry) => entry.name === fixture.containerName && fixture.containerId.startsWith(entry.id))
  expect(Boolean(row), 'fixture immutable container must be discovered').toBe(true)
  return row!
}
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
async function certificateProof(host: HostProfile) {
  const { managedCertificatePath, issuerCAPath } = bridge.ready.fixture.acme
  // Independent OpenSSL checks complement the product scan/verification. No
  // certificate/private-key bodies are emitted or persisted by this probe.
  const path = shellQuote(managedCertificatePath)
  const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret,
    command: `openssl verify -CAfile ${shellQuote(issuerCAPath)} -untrusted ${path} ${path} >/dev/null && openssl x509 -in ${path} -noout -serial -startdate -enddate -ext subjectAltName`,
    audit: { action: 'ssl.inspect', target: managedCertificatePath } })
  expect(result.exitCode, 'managed certificate must verify against the private fixture issuer').toBe(0)
  const serial = result.stdout.match(/^serial=([A-Fa-f0-9]+)$/m)?.[1].toUpperCase()
  const notBefore = Date.parse(result.stdout.match(/^notBefore=(.+)$/m)?.[1] ?? '')
  const notAfter = Date.parse(result.stdout.match(/^notAfter=(.+)$/m)?.[1] ?? '')
  const domains = [...result.stdout.matchAll(/DNS:([^\s,]+)/g)].map((match) => match[1]).sort()
  expect(Boolean(serial), 'real certificate serial must be readable').toBe(true)
  expect(Number.isFinite(notBefore) && Number.isFinite(notAfter)).toBe(true)
  expect(domains).toEqual(bridge.ready.fixture.acme.domains.slice().sort())
  expect(notBefore).toBeLessThanOrEqual(Date.now())
  expect(notAfter).toBeGreaterThan(Date.now())
  return { serial: serial!, notBefore, notAfter, observedAt: Date.now() }
}
async function servedCertificateProof(host: HostProfile, diskSerial: string) {
  const { domains, issuerCAPath, httpsPort } = bridge.ready.fixture.acme
  for (const domain of domains) {
    const script = `body=$(curl -q --noproxy '*' --proto '=https' --fail --silent --show-error --max-time 15 --cacert ${shellQuote(issuerCAPath)} --resolve ${shellQuote(`${domain}:${httpsPort}:127.0.0.1`)} ${shellQuote(`https://${domain}:${httpsPort}/`)}) || exit $?
[ "$body" = ${shellQuote(bridge.ready.fixture.expectedBody)} ] || exit 65
served=$(timeout 15 openssl s_client -connect ${shellQuote(`127.0.0.1:${httpsPort}`)} -servername ${shellQuote(domain)} -verify_return_error -verify_hostname ${shellQuote(domain)} -CAfile ${shellQuote(issuerCAPath)} -showcerts </dev/null 2>/dev/null) || exit $?
printf '%s\\n' "$served" | openssl x509 -noout -serial`
    // This verifies actual Nginx deployment independently of the product's
    // on-disk post-state contract. TLS is verified for each SAN; no -k or
    // certificate/key bodies reach the result or SQLite audit.
    const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: `bash -o pipefail -c ${shellQuote(script)}`, audit: { action: 'ssl.https.verify', target: domain } })
    expect(result.exitCode, 'real HTTPS must verify hostname/issuer, fixed content and the served certificate').toBe(0)
    // Rust's Option is serialized as null; both absent/null mean no native
    // transport error. A concrete error code must still fail this proof.
    expect(result.errorType ?? null).toBeNull()
    expect(result.stdout.match(/^serial=([A-Fa-f0-9]+)$/m)?.[1].toUpperCase()).toBe(diskSerial)
  }
}
function batchHosts() { return [bridge.ready.hosts.direct, bridge.ready.hosts.peerJump] }
function batchOptions(dockerAction: 'start' | 'stop' | 'restart', label: string) {
  return { hosts: batchHosts(), selectedHostIds: batchHosts().map((host) => host.id), vaultId: bridge.ready.vaultId, containerName: bridge.ready.fixture.containerName, dockerAction, resolveAuthSecret, confirmMessage: 'Operate both isolated Docker targets?', maxConcurrency: 2, requestId: `ops-live:batch:${label}:${crypto.randomUUID()}` }
}
const hostCount = (value: Stats, host: HostProfile): Counts => value.byHost[host.id] ?? { commandCount: 0, mutationCount: 0, executedCommandCount: 0 }

/** Batch identity is the production batchId/requestId grouping. There is no
 * separate parent OperationJob in this model, and this test does not invent one. */
async function assertBatchAudit(batch: Pick<BatchOperationResult<CommandRunResult>, 'batchId' | 'selectedHostIds' | 'outcomes'>) {
  const belongs = (job: OperationJob) => batch.selectedHostIds.some((hostId) => job.requestId === `${batch.batchId}:${hostId}`)
  const grouped = (await listOperationJobs({ vaultId: bridge.ready.vaultId, source: 'workspace', limit: 500 })).filter(belongs)
  expect(grouped.map((job) => job.jobId).sort()).toEqual(batch.outcomes.map((outcome) => outcome.job!.jobId).sort())
  expect(grouped).toHaveLength(2)
  expect((await listOperationJobs({ vaultId: bridge.ready.vaultId, source: 'terminal', limit: 500 })).filter(belongs)).toEqual([])
  for (const outcome of batch.outcomes) {
    const job = grouped.find((entry) => entry.jobId === outcome.job?.jobId)!
    expect(job).toMatchObject({ vaultId: bridge.ready.vaultId, hostId: outcome.host.id, source: 'workspace', provider: 'ssh-agentless', requestId: `${batch.batchId}:${outcome.host.id}`, status: outcome.status, transport: outcome.transport })
    const scoped = (await jobs(outcome.host)).filter(belongs)
    expect(scoped.map((entry) => entry.jobId)).toEqual([job.jobId])
    const audit = await listOperationAudit({ vaultId: bridge.ready.vaultId, hostId: outcome.host.id, source: 'workspace', jobId: job.jobId, limit: 100 })
    expect(audit.length).toBeGreaterThanOrEqual(2)
    expect(audit.every((entry) => entry.vaultId === bridge.ready.vaultId && entry.hostId === outcome.host.id && entry.source === 'workspace' && entry.transport === outcome.transport)).toBe(true)
    expect(await listOperationAudit({ vaultId: bridge.ready.vaultId, hostId: outcome.host.id, source: 'terminal', jobId: job.jobId, limit: 100 })).toEqual([])
    await assertAudit(job, outcome.host, outcome.status)
  }
}
function retainBatch(batch: BatchOperationResult<CommandRunResult>) {
  retainedBatches.push({ batchId: batch.batchId, jobs: batch.outcomes.map(({ job }) => ({ jobId: job!.jobId, hostId: job!.hostId, status: job!.status, confirmationStatus: job!.confirmationStatus, transport: job!.transport, requestId: job!.requestId, source: job!.source, provider: job!.provider })) })
}
async function assertAudit(job: OperationJob, host: HostProfile, status = job.status) {
  const stored = await getOperationJob(job.jobId)
  expect(stored?.vaultId).toBe(bridge.ready.vaultId)
  expect(stored?.hostId).toBe(host.id)
  expect(stored?.status).toBe(status)
  const audit = await listOperationAudit({ vaultId: bridge.ready.vaultId, hostId: host.id, jobId: job.jobId, limit: 100 })
  expect(audit.length).toBeGreaterThanOrEqual(2)
  expect(audit.every((entry) => entry.vaultId === bridge.ready.vaultId && entry.hostId === host.id)).toBe(true)
  expect(audit.some((entry) => entry.status === status && entry.confirmationStatus === job.confirmationStatus)).toBe(true)
}

describe.skipIf(!ENABLED)('Real isolated SSH Docker / Sites / SSL and SQLite audit', () => {
  beforeAll(async () => {
    localStorage.setItem('shellbeam.locale', 'en')
    await bridge.start()
    expect(bridge.ready.vaultId).toBe('ops-live-vault')
    expect(bridge.ready.hosts.direct.id).toBe('ops-live-direct')
    expect(bridge.ready.hosts.jump.id).toBe('ops-live-jump')
    expect(bridge.ready.hosts.peerJump.id).toBe('ops-live-peer-jump')
    expect(bridge.ready.fixture.domains).toHaveLength(2)
    expect(bridge.ready.fixture.server).toBe('nginx')
    expect(bridge.ready.hosts.direct.vaultId).toBe(bridge.ready.vaultId)
    expect(bridge.ready.hosts.jump.vaultId).toBe(bridge.ready.vaultId)
    expect(Boolean(bridge.ready.hosts.jump.jumpHostId || bridge.ready.hosts.jump.jumpHost)).toBe(true)
    expect(bridge.ready.hosts.peerJump.vaultId).toBe(bridge.ready.vaultId)
    expect(Boolean(bridge.ready.hosts.peerJump.jumpHostId || bridge.ready.hosts.peerJump.jumpHost)).toBe(true)
    expect(`${bridge.ready.hosts.peerJump.address}:${bridge.ready.hosts.peerJump.port}`).not.toBe(`${bridge.ready.hosts.direct.address}:${bridge.ready.hosts.direct.port}`)
    expect(bridge.ready.fixture.peer.containerName).toBe(bridge.ready.fixture.containerName)
    expect(bridge.ready.fixture.peer.containerId).toMatch(/^[a-f0-9]{64}$/)
    expect(bridge.ready.fixture.peer.containerId).not.toBe(bridge.ready.fixture.containerId)
    expect(bridge.ready.fixture.acme.managedCertificatePath).toBe(`/etc/letsencrypt/live/${bridge.ready.fixture.acme.certificateName}/fullchain.pem`)
    expect(bridge.ready.fixture.acme.domains.slice().sort()).toEqual(bridge.ready.fixture.domains.slice().sort())
    expect(bridge.ready.fixture.acme.initialSerial).toMatch(/^[A-Fa-f0-9]+$/)
    expect(bridge.ready.fixture.acme.initialNotAfter).toBeGreaterThan(Date.now())
    expect(Number.isInteger(bridge.ready.fixture.acme.httpsPort) && bridge.ready.fixture.acme.httpsPort > 1024 && bridge.ready.fixture.acme.httpsPort <= 65535).toBe(true)
    expect(typeof bridge.ready.fixture.expectedBody === 'string' && bridge.ready.fixture.expectedBody.length > 0 && bridge.ready.fixture.expectedBody.length <= 240).toBe(true)
    const directory = new URL(bridge.ready.fixture.acme.directoryUrl)
    expect(directory.protocol).toBe('https:')
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(directory.hostname)
    const wireReady = JSON.stringify(bridge.ready)
    expect(/BEGIN [A-Z ]*PRIVATE KEY/.test(wireReady)).toBe(false)
    expect(Object.values(bridge.ready.hosts).some((host) => Object.hasOwn(host, 'privateKey') || Object.hasOwn(host, 'password'))).toBe(false)
    ipc.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => bridge.request(command, args))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })
  beforeEach(() => { vi.mocked(window.confirm).mockClear().mockReturnValue(true) })
  afterAll(async () => {
    const cleanExit = await bridge.stop()
    vi.restoreAllMocks()
    if (!cleanExit) throw new Error('OPS_LIVE_BRIDGE_CLEANUP_FAILED')
  })

  it.each(routes)('%s: executes Docker start/restart/stop and real logs with one confirmation and verified post-state', async (route: Route) => {
    const host = bridge.ready.hosts[route]
    const container = await containerFor(host)
    if (container.running) {
      const stopped = await runDockerContainerAction({ host, resolveAuthSecret, container, action: 'stop', confirmMessage: 'Stop isolated test container?' })
      expect(stopped?.job.status).toBe('completed')
    }
    for (const action of ['start', 'restart', 'stop'] as const) {
      vi.mocked(window.confirm).mockClear()
      const before = await stats()
      const existingJobs = new Set((await jobs(host)).map((job) => job.jobId))
      const execution = await runDockerContainerAction({ host, resolveAuthSecret, container, action, confirmMessage: 'Operate isolated test container?' })
      expect(execution?.value.exitCode).toBe(0)
      expect(execution?.value.verification.status).toBe('verified')
      expect(execution?.value.verifiedHostKeys?.map((key) => key.stage).sort()).toEqual(route === 'jump' ? ['jump', 'target'] : ['target'])
      expect(execution?.value.container?.running).toBe(action !== 'stop')
      expect(execution?.job.status).toBe('completed')
      expect(execution?.job.transport).toBe(route === 'jump' ? 'proxy-jump' : 'direct')
      expect(window.confirm).toHaveBeenCalledTimes(1)
      const review = vi.mocked(window.confirm).mock.calls[0][0] ?? ''
      expect(review.includes(host.name) && review.includes(`docker ${action}`)).toBe(true)
      const after = await stats()
      expect(after.mutationCount - before.mutationCount).toBe(1)
      expect(after.commandCount - before.commandCount).toBe(2)
      expect((await jobs(host)).filter((job) => !existingJobs.has(job.jobId))).toHaveLength(1)
      await assertAudit(execution!.job, host)
      retain(execution!.job)
      if (action === 'restart') {
        vi.mocked(window.confirm).mockClear()
        const beforeLogs = new Set((await jobs(host)).map((job) => job.jobId))
        const logs = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: buildDockerCommand('logs', container.id), audit: { action: 'docker.logs', target: container.name } })
        expect(logs.exitCode).toBe(0)
        expect((logs.stdout + logs.stderr).includes(bridge.ready.fixture.logMarker ?? 'SHELLBEAM_OPS_LIVE_CONTAINER_READY')).toBe(true)
        expect(window.confirm).not.toHaveBeenCalled()
        const logJobs = (await jobs(host)).filter((job) => !beforeLogs.has(job.jobId))
        expect(logJobs).toHaveLength(1)
        expect(logJobs[0].action).toBe('docker.logs')
        expect(logJobs[0].confirmationStatus).toBe('not_required')
        await assertAudit(logJobs[0], host, 'completed')
      }
    }
  })

  it.each(routes)('%s: observes Nginx sites and two-SAN certificate validity, then verifies config/reload/post-scan', async (route: Route) => {
    const host = bridge.ready.hosts[route]
    const beforeScan = new Set((await jobs(host)).map((job) => job.jobId))
    const scan = await runSiteSslScan({ host, resolveAuthSecret })
    expect(scan.errorCode).toBeUndefined()
    expect(scan.transport).toBe(route === 'jump' ? 'proxy-jump' : 'direct')
    expect(scan.sites.some((site) => site.server === 'nginx' && bridge.ready.fixture.domains.every((domain) => site.domains.includes(domain)))).toBe(true)
    const certificate = scan.certificates.find((entry) => entry.path === bridge.ready.fixture.certificatePath)
    expect(Boolean(certificate), 'real OpenSSL certificate must be discovered').toBe(true)
    expect(certificate!.domains.slice().sort()).toEqual(bridge.ready.fixture.domains.slice().sort())
    expect(certificate!.notBefore).not.toBeNull()
    expect(certificate!.notAfter).not.toBeNull()
    expect(certificate!.notBefore!).toBeLessThanOrEqual(scan.checkedAt)
    expect(certificate!.notAfter!).toBeGreaterThan(scan.checkedAt)
    expect(certificate!.notAfter! - certificate!.notBefore!).toBeGreaterThan(0)
    expect(['valid', 'expiring'].includes(certificate!.status)).toBe(true)
    const scanJobs = (await jobs(host)).filter((job) => !beforeScan.has(job.jobId))
    expect(scanJobs).toHaveLength(1)
    expect(scanJobs[0].action).toBe('sites.scan')
    expect(scanJobs[0].confirmationStatus).toBe('not_required')
    await assertAudit(scanJobs[0], host, 'completed')
    const site = { server: 'nginx' as const, name: bridge.ready.fixture.siteName }
    for (const operation of ['config-test', 'reload'] as const) {
      vi.mocked(window.confirm).mockClear()
      const before = await stats()
      const existingJobs = new Set((await jobs(host)).map((job) => job.jobId))
      const execution = await runSiteOperation({ host, resolveAuthSecret, site, operation, confirmMessage: 'Reload isolated Nginx fixture?' })
      expect(execution?.value.exitCode).toBe(0)
      expect(execution?.value.verification.status).toBe('verified')
      expect(execution?.value.verifiedHostKeys?.map((key) => key.stage).sort()).toEqual(route === 'jump' ? ['jump', 'target'] : ['target'])
      expect(execution?.job.status).toBe('completed')
      expect(window.confirm).toHaveBeenCalledTimes(operation === 'reload' ? 1 : 0)
      const after = await stats()
      expect(after.commandCount - before.commandCount).toBe(operation === 'reload' ? 3 : 1)
      expect(after.mutationCount - before.mutationCount).toBe(operation === 'reload' ? 1 : 0)
      expect((await jobs(host)).filter((job) => !existingJobs.has(job.jobId))).toHaveLength(1)
      if (operation === 'reload') expect(execution?.value.snapshot?.sites.some((entry) => entry.domains.includes(bridge.ready.fixture.siteName))).toBe(true)
      await assertAudit(execution!.job, host)
      retain(execution!.job)
    }
  })

  it.each(routes)('%s: rejected Docker and Nginx confirmations persist cancelled/rejected with zero remote calls', async (route: Route) => {
    const host = bridge.ready.hosts[route]
    const container = await containerFor(host)
    for (const action of ['docker.restart', 'site.reload']) {
      vi.mocked(window.confirm).mockClear().mockReturnValue(false)
      const before = await stats()
      const known = new Set((await jobs(host)).map((job) => job.jobId))
      const execution = action === 'docker.restart'
        ? await runDockerContainerAction({ host, resolveAuthSecret, container, action: 'restart', confirmMessage: 'Cancel fixture action?' })
        : await runSiteOperation({ host, resolveAuthSecret, site: { server: 'nginx', name: bridge.ready.fixture.siteName }, operation: 'reload', confirmMessage: 'Cancel fixture action?' })
      expect(execution).toBeNull()
      expect(window.confirm).toHaveBeenCalledTimes(1)
      const after = await stats()
      expect(after.commandCount - before.commandCount).toBe(0)
      expect(after.mutationCount - before.mutationCount).toBe(0)
      const created = (await jobs(host)).filter((job) => !known.has(job.jobId))
      expect(created).toHaveLength(1)
      expect(created[0].action).toBe(action)
      expect(created[0].status).toBe('cancelled')
      expect(created[0].confirmationStatus).toBe('rejected')
      await assertAudit(created[0], host, 'cancelled')
      retain(created[0])
    }
  })

  it('does not replay a successful mutation when a real SSH post-state connection is lost', async () => {
    const host = bridge.ready.hosts.jump
    const container = await containerFor(host)
    expect(container.running).toBe(false)
    const before = await stats()
    await control('arm-disconnect-after-mutation')
    const execution = await runDockerContainerAction({ host, resolveAuthSecret, container, action: 'start', confirmMessage: 'Start isolated disconnect fixture?' })
    expect(execution?.value.exitCode).toBe(0)
    expect(execution?.value.verification.status).toBe('unknown')
    expect(execution?.job.status).toBe('unknown')
    expect(execution?.job.errorCode).toBe('remote_state_unknown')
    expect(window.confirm).toHaveBeenCalledTimes(1)
    const after = await stats()
    expect(after.mutationCount - before.mutationCount).toBe(1)
    expect(after.commandCount - before.commandCount).toBe(2)
    await assertAudit(execution!.job, host, 'unknown')
    retain(execution!.job)
    await control('restart-target')
    expect((await containerFor(host)).running).toBe(true)
    expect((await stats()).mutationCount - before.mutationCount).toBe(1)
  })

  it.each(routes)('%s: executes product Certbot dry-run and renewal against private ACME HTTP01, independently verifying the live serial and expiry', async (route: Route) => {
    const host = bridge.ready.hosts[route]
    const baseline = await certificateProof(host)
    vi.mocked(window.confirm).mockClear()
    const beforeDryRun = await stats()
    const knownDryJobs = new Set((await jobs(host)).map((job) => job.jobId))
    const dryRun = await runCertificateOperation({ host, resolveAuthSecret, operation: 'renew-dry-run', confirmMessage: 'Dry-run renewal of the isolated private-ACME lineage?' })
    expect(dryRun?.value.exitCode).toBe(0)
    expect(dryRun?.value.verification.status).toBe('verified')
    expect(dryRun?.job).toMatchObject({ action: 'ssl.renew-dry-run', status: 'completed', confirmationStatus: 'confirmed', paramsSummary: buildCertificateOperationCommand('renew-dry-run'), transport: route === 'jump' ? 'proxy-jump' : 'direct' })
    expect(dryRun?.value.verifiedHostKeys?.map((key) => key.stage).sort()).toEqual(route === 'jump' ? ['jump', 'target'] : ['target'])
    expect(window.confirm).toHaveBeenCalledTimes(1)
    const afterDryRun = await stats()
    expect(afterDryRun.commandCount - beforeDryRun.commandCount).toBe(1)
    expect(afterDryRun.mutationCount - beforeDryRun.mutationCount).toBe(1)
    expect((await jobs(host)).filter((job) => !knownDryJobs.has(job.jobId))).toHaveLength(1)
    await assertAudit(dryRun!.job, host)
    retain(dryRun!.job)
    const afterDryProof = await certificateProof(host)
    expect(afterDryProof.serial).toBe(baseline.serial)
    expect(afterDryProof.notBefore).toBe(baseline.notBefore)
    expect(afterDryProof.notAfter).toBe(baseline.notAfter)

    // X.509 validity has one-second resolution. Cross the observed second
    // before issuance so a genuinely renewed fixed-duration cert can extend.
    await new Promise((resolve) => setTimeout(resolve, 1050 - Date.now() % 1000))
    vi.mocked(window.confirm).mockClear()
    const beforeRenewal = await stats()
    const knownRenewalJobs = new Set((await jobs(host)).map((job) => job.jobId))
    const renewal = await runCertificateOperation({ host, resolveAuthSecret, operation: 'renew', confirmMessage: 'Renew the isolated private-ACME lineage?' })
    expect(renewal?.value.exitCode).toBe(0)
    expect(renewal?.value.verification.status).toBe('verified')
    expect(renewal?.value.verification.summary).toMatch(/expiry extended=[1-9][0-9]*/)
    expect(renewal?.job).toMatchObject({ action: 'ssl.renew', status: 'completed', confirmationStatus: 'confirmed', paramsSummary: buildCertificateOperationCommand('renew'), transport: route === 'jump' ? 'proxy-jump' : 'direct' })
    expect(renewal?.value.verifiedHostKeys?.map((key) => key.stage).sort()).toEqual(route === 'jump' ? ['jump', 'target'] : ['target'])
    expect(window.confirm).toHaveBeenCalledTimes(1)
    const afterRenewal = await stats()
    expect(afterRenewal.commandCount - beforeRenewal.commandCount).toBe(3)
    expect(afterRenewal.mutationCount - beforeRenewal.mutationCount).toBe(1)
    expect((await jobs(host)).filter((job) => !knownRenewalJobs.has(job.jobId))).toHaveLength(1)
    await assertAudit(renewal!.job, host)
    retain(renewal!.job)
    const afterRenewProof = await certificateProof(host)
    expect(afterRenewProof.serial).not.toBe(afterDryProof.serial)
    expect(afterRenewProof.notBefore).toBeGreaterThanOrEqual(afterDryProof.notBefore)
    expect(afterRenewProof.notAfter).toBeGreaterThan(afterDryProof.notAfter)
    const observed = renewal!.value.snapshot?.certificates.find((certificate) => certificate.path === bridge.ready.fixture.acme.managedCertificatePath)
    expect(observed).toMatchObject({ hostId: host.id, serial: afterRenewProof.serial, notBefore: afterRenewProof.notBefore, notAfter: afterRenewProof.notAfter, transport: route === 'jump' ? 'proxy-jump' : 'direct' })
    expect(observed?.domains.slice().sort()).toEqual(bridge.ready.fixture.acme.domains.slice().sort())
    expect(renewal!.value.snapshot?.errorCode).toBeUndefined()
    await servedCertificateProof(host, afterRenewProof.serial)
  })

  it.each(routes)('%s: rejecting either product certificate action creates one cancelled audit job with zero remote calls', async (route: Route) => {
    const host = bridge.ready.hosts[route]
    for (const operation of ['renew-dry-run', 'renew'] as const) {
      vi.mocked(window.confirm).mockClear().mockReturnValue(false)
      const before = await stats()
      const known = new Set((await jobs(host)).map((job) => job.jobId))
      const execution = await runCertificateOperation({ host, resolveAuthSecret, operation, confirmMessage: 'Cancel the isolated certificate action?' })
      expect(execution).toBeNull()
      expect(window.confirm).toHaveBeenCalledTimes(1)
      const after = await stats()
      expect(after.commandCount - before.commandCount).toBe(0)
      expect(after.mutationCount - before.mutationCount).toBe(0)
      const created = (await jobs(host)).filter((job) => !known.has(job.jobId))
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({ action: `ssl.${operation}`, status: 'cancelled', confirmationStatus: 'rejected' })
      await assertAudit(created[0], host, 'cancelled')
      retain(created[0])
    }
  })

  it('keeps a real Certbot renewal unknown when its post-scan SSH disconnects and never replays the successful issuance', async () => {
    const host = bridge.ready.hosts.jump
    const baseline = await certificateProof(host)
    await new Promise((resolve) => setTimeout(resolve, 1050 - Date.now() % 1000))
    const before = await stats()
    const known = new Set((await jobs(host)).map((job) => job.jobId))
    await control('arm-disconnect-after-mutation', host.id)
    try {
      const renewal = await runCertificateOperation({ host, resolveAuthSecret, operation: 'renew', confirmMessage: 'Renew the isolated lineage before the controlled SSH disconnect?' })
      expect(renewal?.value.exitCode).toBe(0)
      expect(renewal?.value.verification.status).toBe('unknown')
      expect(renewal?.job).toMatchObject({ action: 'ssl.renew', status: 'unknown', errorCode: 'remote_state_unknown', confirmationStatus: 'confirmed', transport: 'proxy-jump' })
      expect(window.confirm).toHaveBeenCalledTimes(1)
      const after = await stats()
      expect(after.commandCount - before.commandCount).toBe(3)
      expect(after.mutationCount - before.mutationCount).toBe(1)
      expect(hostCount(after, host).executedCommandCount - hostCount(before, host).executedCommandCount).toBe(2)
      expect((await jobs(host)).filter((job) => !known.has(job.jobId))).toHaveLength(1)
      await assertAudit(renewal!.job, host, 'unknown')
      retain(renewal!.job)
    } finally { await control('restart-target', host.id) }
    const current = await certificateProof(host)
    expect(current.serial).not.toBe(baseline.serial)
    expect(current.notAfter).toBeGreaterThan(baseline.notAfter)
    await servedCertificateProof(host, current.serial)
    expect((await stats()).mutationCount - before.mutationCount).toBe(1)
  })

  it('completes one bounded mixed-route batch against independent SSH targets and same-name containers with distinct immutable IDs', async () => {
    const selected = batchHosts()
    await containerFor(selected[0])
    await containerFor(selected[1], bridge.ready.fixture.peer)
    vi.mocked(window.confirm).mockClear()
    const before = await stats()
    const known = new Set((await listOperationJobs({ vaultId: bridge.ready.vaultId, source: 'workspace', limit: 500 })).map((job) => job.jobId))
    const batch = await runBatchDockerOperation(batchOptions('restart', 'success'))
    expect(batch).toMatchObject({ status: 'completed', completedCount: 2, failedCount: 0, unknownCount: 0, cancelledCount: 0, selectedHostIds: selected.map((host) => host.id) })
    expect(window.confirm).toHaveBeenCalledTimes(1)
    const after = await stats()
    expect(after.commandCount - before.commandCount).toBe(6)
    expect(after.mutationCount - before.mutationCount).toBe(2)
    const expectedIds = [bridge.ready.fixture.containerId, bridge.ready.fixture.peer.containerId]
    const targetKeys: string[] = []
    for (const [index, outcome] of batch.outcomes.entries()) {
      expect(outcome.job).toMatchObject({ status: 'completed', confirmationStatus: 'confirmed', transport: index === 0 ? 'direct' : 'proxy-jump' })
      expect(outcome.value).toMatchObject({ exitCode: 0, verification: { status: 'verified' } })
      expect(outcome.value!.stdout.trim()).toBe(expectedIds[index])
      expect(outcome.value!.verifiedHostKeys?.map((key) => key.stage).sort()).toEqual(index === 0 ? ['target'] : ['jump', 'target'])
      const targetKey = outcome.value!.verifiedHostKeys?.find((key) => key.stage === 'target')?.fingerprintSha256
      expect(Boolean(targetKey)).toBe(true)
      targetKeys.push(targetKey!)
      expect(hostCount(after, outcome.host).commandCount - hostCount(before, outcome.host).commandCount).toBe(3)
      expect(hostCount(after, outcome.host).mutationCount - hostCount(before, outcome.host).mutationCount).toBe(1)
    }
    expect(targetKeys[0]).not.toBe(targetKeys[1])
    expect((await listOperationJobs({ vaultId: bridge.ready.vaultId, source: 'workspace', limit: 500 })).filter((job) => !known.has(job.jobId))).toHaveLength(2)
    await assertBatchAudit(batch)
    retainBatch(batch)
    expect((await containerFor(selected[0])).running).toBe(true)
    expect((await containerFor(selected[1], bridge.ready.fixture.peer)).running).toBe(true)
  })

  it('cancels the mixed batch once and persists both rejected child jobs with zero remote calls or writes', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    const before = await stats()
    const known = new Set((await listOperationJobs({ vaultId: bridge.ready.vaultId, source: 'workspace', limit: 500 })).map((job) => job.jobId))
    const batch = await runBatchDockerOperation(batchOptions('stop', 'cancelled'))
    expect(batch).toMatchObject({ status: 'cancelled', completedCount: 0, failedCount: 0, unknownCount: 0, cancelledCount: 2 })
    expect(window.confirm).toHaveBeenCalledTimes(1)
    const after = await stats()
    expect(after.commandCount - before.commandCount).toBe(0)
    expect(after.mutationCount - before.mutationCount).toBe(0)
    expect((await listOperationJobs({ vaultId: bridge.ready.vaultId, source: 'workspace', limit: 500 })).filter((job) => !known.has(job.jobId))).toHaveLength(2)
    for (const outcome of batch.outcomes) expect(outcome.job).toMatchObject({ status: 'cancelled', confirmationStatus: 'rejected', errorCode: 'confirmation_rejected' })
    await assertBatchAudit(batch)
    retainBatch(batch)
  })

  it('keeps only the independent jump target unknown after one mutation and a real post-state SSH disconnect, without replaying either write', async () => {
    const [direct, peer] = batchHosts()
    const before = await stats()
    await control('arm-disconnect-after-mutation', peer.id)
    try {
      const batch = await runBatchDockerOperation(batchOptions('restart', 'partial'))
      expect(batch).toMatchObject({ status: 'partial', completedCount: 1, failedCount: 0, unknownCount: 1, cancelledCount: 0 })
      expect(window.confirm).toHaveBeenCalledTimes(1)
      expect(batch.outcomes.find((outcome) => outcome.host.id === direct.id)?.job).toMatchObject({ status: 'completed', confirmationStatus: 'confirmed', transport: 'direct' })
      expect(batch.outcomes.find((outcome) => outcome.host.id === peer.id)?.job).toMatchObject({ status: 'unknown', confirmationStatus: 'confirmed', transport: 'proxy-jump', errorCode: 'remote_state_unknown' })
      const after = await stats()
      expect(after.commandCount - before.commandCount).toBe(6)
      expect(after.mutationCount - before.mutationCount).toBe(2)
      for (const host of [direct, peer]) {
        expect(hostCount(after, host).commandCount - hostCount(before, host).commandCount).toBe(3)
        expect(hostCount(after, host).mutationCount - hostCount(before, host).mutationCount).toBe(1)
      }
      expect(hostCount(after, direct).executedCommandCount - hostCount(before, direct).executedCommandCount).toBe(3)
      expect(hostCount(after, peer).executedCommandCount - hostCount(before, peer).executedCommandCount).toBe(2)
      await assertBatchAudit(batch)
      retainBatch(batch)
    } finally { await control('restart-target', peer.id) }
    expect((await containerFor(peer, bridge.ready.fixture.peer)).running).toBe(true)
    expect((await containerFor(direct)).running).toBe(true)
    expect((await stats()).mutationCount - before.mutationCount).toBe(2)
  })

  it('recovers identical scoped SQLite job/audit outcomes after the native bridge process restarts', async () => {
    expect(retainedJobs.some((job) => job.status === 'completed')).toBe(true)
    expect(retainedJobs.some((job) => job.status === 'cancelled')).toBe(true)
    expect(retainedJobs.some((job) => job.status === 'unknown')).toBe(true)
    await bridge.restart()
    expect(bridge.ready.vaultId).toBe('ops-live-vault')
    for (const job of retainedJobs) {
      const host = Object.values(bridge.ready.hosts).find((entry) => entry.id === job.hostId)!
      const restored = await getOperationJob(job.jobId)
      expect(restored?.status).toBe(job.status)
      expect(restored?.confirmationStatus).toBe(job.confirmationStatus)
      expect(restored?.transport).toBe(job.transport)
      await assertAudit(restored!, host, job.status)
    }
    expect(retainedBatches).toHaveLength(3)
    for (const batch of retainedBatches) {
      const grouped = (await listOperationJobs({ vaultId: bridge.ready.vaultId, source: 'workspace', limit: 500 })).filter((job) => batch.jobs.some((child) => child.requestId === job.requestId))
      expect(grouped).toHaveLength(2)
      const outcomes = batch.jobs.map((expected) => {
        const job = grouped.find((entry) => entry.jobId === expected.jobId)!
        expect(job).toMatchObject(expected)
        const host = Object.values(bridge.ready.hosts).find((entry) => entry.id === expected.hostId)!
        return { host, job, status: job.status, transport: job.transport as 'direct' | 'proxy-jump' }
      })
      await assertBatchAudit({ batchId: batch.batchId, selectedHostIds: outcomes.map((outcome) => outcome.host.id), outcomes })
    }
    // The controlled bridge rejects a foreign scope before dispatch; do not
    // replace this refusal with invented empty database responses.
    await expect(listOperationJobs({ vaultId: 'ops-live-foreign-vault', limit: 500 })).rejects.toThrow('OPS_LIVE_NATIVE_COMMAND_FAILED')
    await expect(listOperationAudit({ vaultId: 'ops-live-foreign-vault', limit: 500 })).rejects.toThrow('OPS_LIVE_NATIVE_COMMAND_FAILED')
    console.log('Scoped Ops audit recovery checked after a native process restart; the runner reports whole-suite acceptance only when every live case passes without skips.')
  })
})
