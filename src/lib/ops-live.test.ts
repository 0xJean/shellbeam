import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import { buildDockerCommand, DOCKER_LIST_COMMAND, parseDockerContainers, runDockerContainerAction, type DockerContainer } from './docker-ops'
import { runSiteOperation, runSiteSslScan } from './sites-ssl'
import { getOperationJob, listOperationAudit, listOperationJobs, type OperationJob } from './operation-job'
import { runWorkspaceRemoteCommand } from './workspace-remote'

// Only the Tauri boundary and human confirmation are substituted. Commands,
// SSH/ProxyJump, Docker/nginx/OpenSSL output and SQLite jobs are all real.
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }))
const ENABLED = process.env.SHELLBEAM_OPS_LIVE === '1'
const PREFIX = '__SHELLBEAM_OPS_LIVE__'
type Route = 'direct' | 'jump'
interface Ready {
  type: 'ready'
  vaultId: string
  hosts: Record<Route, HostProfile>
  fixture: { containerId: string; containerName: string; siteName: string; server: 'nginx'; certificatePath: string; domains: string[]; logMarker?: string }
}
interface Stats { commandCount: number; mutationCount: number; byHost: Record<string, { commandCount: number; mutationCount: number }>; commands: Array<{ hostId: string; summary: string }> }
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
const resolveAuthSecret = async () => { throw new Error('OPS_LIVE_CREDENTIALS_MUST_REMAIN_NATIVE') }
const stats = () => bridge.request<Stats>('ops_live_control', { action: 'stats' })
const jobs = (host: HostProfile) => listOperationJobs({ vaultId: bridge.ready.vaultId, hostId: host.id, source: 'workspace', limit: 500 })
const control = (action: string) => bridge.request('ops_live_control', { action })

function retain(job: OperationJob) {
  retainedJobs.push({ jobId: job.jobId, hostId: job.hostId, status: job.status, confirmationStatus: job.confirmationStatus, transport: job.transport })
}
async function containerFor(host: HostProfile): Promise<DockerContainer> {
  const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: DOCKER_LIST_COMMAND, audit: { action: 'docker.list', target: 'containers' } })
  expect(result.exitCode, 'real Docker list must complete').toBe(0)
  const row = parseDockerContainers(result.stdout).find((entry) => entry.name === bridge.ready.fixture.containerName && bridge.ready.fixture.containerId.startsWith(entry.id))
  expect(Boolean(row), 'fixture immutable container must be discovered').toBe(true)
  return row!
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
    expect(bridge.ready.fixture.domains).toHaveLength(2)
    expect(bridge.ready.fixture.server).toBe('nginx')
    expect(bridge.ready.hosts.direct.vaultId).toBe(bridge.ready.vaultId)
    expect(bridge.ready.hosts.jump.vaultId).toBe(bridge.ready.vaultId)
    expect(Boolean(bridge.ready.hosts.jump.jumpHostId || bridge.ready.hosts.jump.jumpHost)).toBe(true)
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
    // The controlled bridge rejects a foreign scope before dispatch; do not
    // replace this refusal with invented empty database responses.
    await expect(listOperationJobs({ vaultId: 'ops-live-foreign-vault', limit: 500 })).rejects.toThrow('OPS_LIVE_NATIVE_COMMAND_FAILED')
    await expect(listOperationAudit({ vaultId: 'ops-live-foreign-vault', limit: 500 })).rejects.toThrow('OPS_LIVE_NATIVE_COMMAND_FAILED')
    console.log('Ops live acceptance passed: real loopback direct/ProxyJump SSH, Docker, Nginx/OpenSSL and temporary SQLite; no desktop, production Vault or Certbot issuance claim.')
  })
})
