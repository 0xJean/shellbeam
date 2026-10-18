import type { HostProfile } from './hosts'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { operationTransport, runConfirmedOperation, type OperationJob } from './operation-job'
import { hostOperationReview } from './operation-review'
import { remoteOperationStatus, verifiedOperationAudit, type VerifiedOperationResult } from './operation-verification'

export interface DockerContainer {
  id: string
  name: string
  image: string
  status: string
  ports: string
  running: boolean
}

export type DockerContainerAction = 'start' | 'stop' | 'restart' | 'logs'

export const DOCKER_LIST_COMMAND = "if command -v docker >/dev/null 2>&1; then docker ps -a --format '__SB_DOCKER={{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' | head -n 100; else printf '%s\\n' '__SB_DOCKER_UNAVAILABLE'; exit 127; fi"

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function isSafeDockerTarget(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
}

export function parseDockerContainers(output: string): DockerContainer[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('__SB_DOCKER='))
    .map((line) => {
      const [id = '', name = '', image = '', status = '', ports = ''] = line.slice('__SB_DOCKER='.length).split('|')
      return {
        id: id.trim(),
        name: name.trim(),
        image: image.trim(),
        status: status.trim(),
        ports: ports.trim(),
        running: /^up\b/i.test(status.trim()),
      }
    })
    .filter((row) => row.id && isSafeDockerTarget(row.id) && isSafeDockerTarget(row.name))
}

export function buildDockerCommand(action: DockerContainerAction, target: string) {
  if (!isSafeDockerTarget(target)) throw new Error('Invalid Docker container name')
  const quoted = shellQuote(target)
  if (action === 'logs') return `docker logs --tail 100 --timestamps ${quoted}`
  return `docker ${action} ${quoted}`
}

export function buildDockerVerificationCommand(target: string) {
  if (!isSafeDockerTarget(target)) throw new Error('Invalid Docker container name')
  return `docker inspect --format '__SB_DOCKER_VERIFY={{.Id}}|{{.State.Status}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Restarting}}' ${shellQuote(target)}`
}

export function dockerPostState(output: string, container: DockerContainer) {
  const markers = output.split('\n').filter((line) => line.startsWith('__SB_DOCKER_VERIFY='))
  if (markers.length !== 1) return null
  const fields = markers[0].slice('__SB_DOCKER_VERIFY='.length).trim().split('|')
  if (fields.length !== 5) return null
  const [id, status, running, paused, restarting] = fields
  if (!isSafeDockerTarget(id) || !id.startsWith(container.id) || !['created', 'running', 'paused', 'restarting', 'exited', 'dead', 'removing'].includes(status) || ![running, paused, restarting].every((value) => value === 'true' || value === 'false')) return null
  return { status, running: running === 'true', paused: paused === 'true', restarting: restarting === 'true' }
}

export interface DockerContainerResult extends VerifiedOperationResult {
  container?: DockerContainer
}

export interface DockerContainerOperation {
  value: DockerContainerResult
  job: OperationJob
}

/** Run a mutating Docker action through the existing confirmation + audit path. */
export async function runDockerContainerAction(options: {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  action: Exclude<DockerContainerAction, 'logs'>
  container: DockerContainer
  confirmMessage: string
}) {
  const { host, resolveAuthSecret, action, container, confirmMessage } = options
  // The selected immutable id prevents a renamed/replaced container with the
  // same display name from becoming the target of this confirmed operation.
  const command = buildDockerCommand(action, container.id)
  const execution = await runConfirmedOperation({
    host,
    action: `docker.${action}`,
    target: container.name,
    risk: action === 'start' ? 'low' : 'high',
    paramsSummary: command,
    confirmMessage: `${confirmMessage}\n\n${hostOperationReview(host, command)}`,
    source: 'workspace',
    provider: 'ssh-agentless',
    transport: operationTransport(host),
    execute: async (): Promise<DockerContainerResult> => {
      const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command })
      if (remoteOperationStatus(result) !== 'completed') return { ...result, verification: { status: 'not-run', summary: 'Docker command did not complete; no post-state was claimed.' } }
      try {
        const observed = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: buildDockerVerificationCommand(container.id) })
        const state = remoteOperationStatus(observed) === 'completed' ? dockerPostState(observed.stdout, container) : null
        const expected = action === 'stop' ? 'stopped' : 'running'
        const verified = state && !state.paused && !state.restarting && (action === 'stop'
          ? !state.running && ['exited', 'created'].includes(state.status)
          : state.running && state.status === 'running')
        return {
          ...result,
          durationMs: result.durationMs + observed.durationMs,
          ...(state ? { container: { ...container, status: state.status, running: state.running } } : {}),
          verification: { status: verified ? 'verified' : 'unknown', summary: state ? `Expected ${expected}; observed ${state.status}, running=${state.running}, paused=${state.paused}, restarting=${state.restarting}.` : `Expected ${expected}; container post-state is unavailable. Recheck before retrying.` },
        }
      } catch {
        return { ...result, verification: { status: 'unknown', summary: 'Docker command returned successfully, but container post-state is unavailable. Recheck before retrying.' } }
      }
    },
    getResult: verifiedOperationAudit,
  })
  return execution as DockerContainerOperation | null
}
