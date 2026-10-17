import type { HostProfile } from './hosts'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { operationTransport, runConfirmedOperation, type OperationJob } from './operation-job'

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
  return `docker ${action} ${quoted} && docker inspect --format '__SB_DOCKER={{.ID}}|{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.State.Status}}' ${quoted}`
}

export interface DockerContainerOperation {
  value: { stdout: string; stderr: string; exitCode: number; durationMs: number }
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
  const command = buildDockerCommand(action, container.name)
  const execution = await runConfirmedOperation({
    host,
    action: `docker.${action}`,
    target: container.name,
    risk: action === 'start' ? 'low' : 'high',
    paramsSummary: command,
    confirmMessage,
    source: 'workspace',
    provider: 'ssh-agentless',
    transport: operationTransport(host),
    execute: () => runWorkspaceRemoteCommand({ host, resolveAuthSecret, command }),
    getResult: (result) => result,
  })
  return execution as DockerContainerOperation | null
}
