import { invalidateProbeInstallSources } from '@/hooks/use-probe-install-readiness'
import { KomariApiError, normalizeKomariEndpoint, verifyKomariConnection } from './komari'
import {
  deleteKomariIntegration,
  komariCredentialKey,
  upsertKomariIntegration,
  type KomariIntegration,
} from './komari-config'
import { KOMARI_MAPPING_CHANGED_EVENT } from './komari-persistence'
import { closeServiceScope, serviceErrorCode, serviceRequest, serviceScope } from './monitoring-service'

export const KOMARI_INTEGRATIONS_CHANGED_EVENT = 'shellbeam:komari-integrations-changed'

export type ServerQuickAuthMode = 'authorize' | 'key' | 'initialize'

export interface ConnectShellbeamServerInput {
  id?: string
  vaultId: string
  name?: string
  endpoint: string
  authMode: ServerQuickAuthMode
  apiKey?: string
  username?: string
  password?: string
  twoFactor?: string
  installToken?: string
  metricDsn?: string
  saveSecret: (key: string, value: string) => Promise<void>
  loadSecret?: (key: string) => Promise<string | null>
  isCurrent?: () => boolean
}

export interface ConnectShellbeamServerResult {
  integration: KomariIntegration
  nodeCount: number
}

export function notifyServerIntegrationsChanged(vaultId: string, integrationId?: string) {
  invalidateProbeInstallSources(vaultId)
  window.dispatchEvent(new CustomEvent(KOMARI_INTEGRATIONS_CHANGED_EVENT, { detail: { vaultId, integrationId } }))
  window.dispatchEvent(new CustomEvent(KOMARI_MAPPING_CHANGED_EVENT, { detail: { vaultId, integrationId } }))
  window.dispatchEvent(new Event('shellbeam:host-ops-refresh'))
}

/**
 * Connects, authenticates (or initializes), and verifies a ShellBeam Server
 * integration in one step so users can pair a Server inline without leaving
 * host creation, probe installation, or the dashboard.
 */
export async function connectShellbeamServer(input: ConnectShellbeamServerInput): Promise<ConnectShellbeamServerResult> {
  const isCurrent = input.isCurrent ?? (() => true)
  const vaultId = input.vaultId.trim()
  const endpoint = normalizeKomariEndpoint(input.endpoint)
  const defaultName = (() => {
    try { return new URL(endpoint).host || 'ShellBeam Server' } catch { return 'ShellBeam Server' }
  })()
  const name = (input.name ?? '').trim() || defaultName
  const integrationId = input.id?.trim() || crypto.randomUUID()
  const credentialRef = komariCredentialKey(integrationId)
  const createdFresh = !input.id?.trim()

  const saved = await upsertKomariIntegration({
    id: integrationId,
    vaultId,
    name,
    endpoint,
    credentialRef,
    enabled: true,
  })

  try {
    if (!isCurrent()) throw new Error('Vault scope changed')
    let nodeCount = 0

    if (input.authMode === 'key') {
      const token = (input.apiKey ?? '').trim()
      if (!token) throw new Error('API key is required')
      const nodes = await verifyKomariConnection({ endpoint: saved.endpoint, token })
      if (!isCurrent()) throw new Error('Vault scope changed')
      await input.saveSecret(credentialRef, token)
      nodeCount = nodes.length
    } else {
      const username = (input.username ?? '').trim()
      const password = input.password ?? ''
      if (!username || !password) throw new Error('Admin credentials are required')
      const scope = await serviceScope(saved)
      try {
        if (!isCurrent()) throw new Error('Vault scope changed')
        await serviceRequest(scope, input.authMode, {
          username,
          password,
          twoFactor: (input.twoFactor ?? '').trim(),
          metricDsn: (input.metricDsn ?? '').trim() || './data/metrics.db',
          ...(input.authMode === 'initialize' && input.installToken?.trim() ? { installToken: input.installToken.trim() } : {}),
          confirmed: input.authMode === 'initialize',
        })
      } finally {
        await closeServiceScope(scope).catch(() => {})
      }
      if (!isCurrent()) throw new Error('Vault scope changed')
      if (input.loadSecret) {
        const token = await input.loadSecret(credentialRef).catch(() => null)
        if (token?.trim() && isCurrent()) {
          const nodes = await verifyKomariConnection({ endpoint: saved.endpoint, token }).catch(() => [])
          nodeCount = nodes.length
        }
      }
    }

    notifyServerIntegrationsChanged(vaultId, saved.id)
    return { integration: saved, nodeCount }
  } catch (cause) {
    if (createdFresh) {
      await deleteKomariIntegration(saved.id, vaultId).catch(() => {})
    }
    throw cause
  }
}

export function formatServerConnectError(cause: unknown, locale: 'zh-CN' | 'en'): string {
  if (cause instanceof KomariApiError) {
    if (locale === 'zh-CN') {
      if (cause.code === 'permission') return 'API 密钥无权限或已失效，请核对后重试。'
      if (cause.code === 'timeout') return '连接超时，请检查 Server 地址与端口是否可达。'
      return '无法连接该 ShellBeam Server，请检查地址与服务运行状态。'
    }
    if (cause.code === 'permission') return 'API key was rejected or lacks permission.'
    if (cause.code === 'timeout') return 'Connection timed out. Check the Server URL and network.'
    return 'Could not reach ShellBeam Server at this URL.'
  }
  const code = serviceErrorCode(cause)
  if (code !== 'MONITORING_REQUEST_FAILED') {
    if (locale === 'zh-CN') {
      if (code === 'MONITORING_SHELLBEAM_REQUIRED') return '目标地址不是受支持的 ShellBeam Server 服务。'
      if (code.includes('PERMISSION') || code.includes('AUTH')) return '账号、密码、两步验证码或安装令牌不正确。'
      if (code.includes('INVALID')) return '填写的参数格式无效，请检查地址和凭据。'
      return `连接监控服务失败（${code}），请检查地址和凭据。`
    }
    if (code === 'MONITORING_SHELLBEAM_REQUIRED') return 'Target endpoint is not a supported ShellBeam Server.'
    if (code.includes('PERMISSION') || code.includes('AUTH')) return 'Invalid username, password, 2FA code, or setup token.'
    return `Failed to connect to monitoring server (${code}).`
  }
  return cause instanceof Error ? cause.message : String(cause)
}
