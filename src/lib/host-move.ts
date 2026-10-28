import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

/** Moving hosts between Vaults: a plan to show first, then the move itself. */
export interface HostMoveRequest {
  sourceVaultId: string
  targetVaultId: string
  /** Hosts the user picked; jump hosts they depend on are added by the plan. */
  hostIds: string[]
}

export interface HostMoveHostRef {
  id: string
  name: string
}

export interface HostMovePlan {
  /** Every host that will move: the picked ones plus required jump hosts. */
  hosts: HostMoveHostRef[]
  /** Jump hosts added because a moving host connects through them. */
  addedJumpHosts: Array<HostMoveHostRef & { requiredBy: string[] }>
  /** Hosts staying behind that connect through a moving host. Non-empty blocks the move. */
  blockingDependents: Array<HostMoveHostRef & { dependsOn: string[] }>
  /** Hosts that cannot move, e.g. the target already has a host with the same id. Non-empty blocks the move. */
  conflicts: Array<HostMoveHostRef & { reason: string }>
  secrets: {
    /** Credentials only these hosts use: removed from the source after copying. */
    moved: number
    /** Credentials other source hosts still use: copied, the source keeps them. */
    copied: number
    /** Key names already taken in the target with a different value; the moved hosts use the new name. */
    renamed: Array<{ from: string; to: string }>
  }
  records: {
    portForwards: number
    knownHosts: number
    commandHistory: number
    activity: number
    /** Rows in the app databases (monitoring, assets, alerts, jobs, agents...) that follow the hosts. */
    databaseRows: number
  }
  /** MCP clients of the source Vault that lose their grants for the moving hosts. */
  mcpClientsAffected: HostMoveHostRef[]
  sourceUnlocked: boolean
  targetUnlocked: boolean
  /** The target Vault has no master password yet and must be set up first. */
  targetUninitialized: boolean
}

export interface HostMoveResult {
  movedHostIds: string[]
  /** Steps that could not finish; running the same move again completes them. */
  warnings: string[]
}

export async function planHostMove(request: HostMoveRequest) {
  try {
    return await invoke<HostMovePlan>('plan_host_move', { request })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function moveHostsToVault(request: HostMoveRequest) {
  try {
    return await invoke<HostMoveResult>('move_hosts_to_vault', { request })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

/** The move is blocked until these are resolved. */
export function hostMoveBlocked(plan: HostMovePlan) {
  return plan.blockingDependents.length > 0 || plan.conflicts.length > 0 || !plan.sourceUnlocked || !plan.targetUnlocked || plan.targetUninitialized
}
