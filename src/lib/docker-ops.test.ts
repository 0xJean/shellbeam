import { describe, expect, it } from 'vitest'
import { buildDockerCommand, isSafeDockerTarget, parseDockerContainers } from './docker-ops'

describe('docker operations', () => {
  it('parses bounded container markers and running state', () => {
    const rows = parseDockerContainers('__SB_DOCKER=abc123|api|ghcr.io/acme/api:latest|Up 5 minutes|0.0.0.0:8080->80/tcp\n__SB_DOCKER=def456|worker|acme/worker|Exited (1) 2 hours ago|')
    expect(rows).toEqual([
      { id: 'abc123', name: 'api', image: 'ghcr.io/acme/api:latest', status: 'Up 5 minutes', ports: '0.0.0.0:8080->80/tcp', running: true },
      { id: 'def456', name: 'worker', image: 'acme/worker', status: 'Exited (1) 2 hours ago', ports: '', running: false },
    ])
  })

  it('rejects shell metacharacters and quotes command targets', () => {
    expect(isSafeDockerTarget('api; rm -rf /')).toBe(false)
    expect(() => buildDockerCommand('stop', 'api;rm')).toThrow()
    expect(buildDockerCommand('logs', 'api')).toContain("docker logs --tail 100 --timestamps 'api'")
  })
})
