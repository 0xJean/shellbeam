import { afterEach, describe, expect, it } from 'vitest'
import { clearWorkspaceInventoryCache, parseWorkspaceInventory } from './workspace-inventory'
import {
  createReadyWorkspaceInventoryStates,
  clearWorkspaceInventoryStates,
  getWorkspaceInventoryDisplayStatus,
  mergeWorkspaceInventoryStates,
} from './workspace-inventory-state'

describe('workspace inventory shared state', () => {
  afterEach(() => {
    clearWorkspaceInventoryCache()
    clearWorkspaceInventoryStates()
  })

  it('maps shared scan states to host display statuses', () => {
    const readyInventory = parseWorkspaceInventory('__SB_HOSTNAME=ready-vps')
    mergeWorkspaceInventoryStates({
      ready: { status: 'ready', inventory: readyInventory, updatedAt: Date.now() },
      scanning: { status: 'scanning' },
      error: { status: 'error', error: 'offline' },
    })

    expect(getWorkspaceInventoryDisplayStatus({ status: 'ready', inventory: readyInventory })).toBe('online')
    expect(getWorkspaceInventoryDisplayStatus({ status: 'scanning' })).toBe('checking')
    expect(getWorkspaceInventoryDisplayStatus({ status: 'error' })).toBe('offline')
  })

  it('does not let cached ready snapshots overwrite active scans', () => {
    const cachedInventory = parseWorkspaceInventory('__SB_HOSTNAME=cached-vps')
    const current = {
      'host-1': { status: 'scanning' as const },
    }

    const readyStates = createReadyWorkspaceInventoryStates({
      'host-1': { inventory: cachedInventory, updatedAt: 100 },
    }, current)

    expect(readyStates['host-1']).toMatchObject({ status: 'scanning', inventory: cachedInventory, updatedAt: 100 })
  })

  it('keeps newer ready shared state over older cached snapshots', () => {
    const oldInventory = parseWorkspaceInventory('__SB_HOSTNAME=old-vps')
    const freshInventory = parseWorkspaceInventory('__SB_HOSTNAME=fresh-vps')
    const current = {
      'host-1': { status: 'ready' as const, inventory: freshInventory, updatedAt: 200 },
    }

    const readyStates = createReadyWorkspaceInventoryStates({
      'host-1': { inventory: oldInventory, updatedAt: 100 },
    }, current)

    expect(readyStates['host-1']?.inventory?.resource.hostname).toBe('fresh-vps')
  })
})
