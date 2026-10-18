import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildShellbeamAgentArtifactInstallPlan } from './shellbeam-agent-artifact'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
describe('Agent atomic activation and daemon rollback', () => {
  it('restores and activates the exact previous executable when new activation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shellbeam-agent-activation-'))
    try {
      const installPath = join(directory, 'agent')
      const stagingPath = join(directory, 'staged')
      const backupPath = join(directory, 'backup')
      const previous = '#!/bin/sh\n[ "$1" = install ] && exit 0\nexit 1\n'
      const failing = '#!/bin/sh\nexit 1\n'
      await writeFile(installPath, previous); await chmod(installPath, 0o755); await writeFile(stagingPath, failing)
      const plan = buildShellbeamAgentArtifactInstallPlan({ version: '0.2.0', installPath, stagingPath, backupPath, sha256: hash(failing), previousSha256: hash(previous) })
      const result = spawnSync('/bin/sh', ['-c', plan.installCommand], { encoding: 'utf8' })
      expect(result.status).toBe(29)
      expect(result.stdout).toContain('__SB_AGENT_ROLLBACK=verified')
      expect(await readFile(installPath, 'utf8')).toBe(previous)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('blocks replacing an unexpected installed executable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shellbeam-agent-guard-'))
    try {
      const installPath = join(directory, 'agent'); const stagingPath = join(directory, 'staged'); const backupPath = join(directory, 'backup')
      await writeFile(installPath, 'unexpected'); await writeFile(stagingPath, 'new')
      const plan = buildShellbeamAgentArtifactInstallPlan({ version: '0.2.0', installPath, stagingPath, backupPath, sha256: hash('new'), previousSha256: hash('expected') })
      expect(spawnSync('/bin/sh', ['-c', plan.installCommand]).status).toBe(23)
      expect(await readFile(installPath, 'utf8')).toBe('unexpected')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
