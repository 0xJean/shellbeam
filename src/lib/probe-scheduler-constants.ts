import { COLLECTION_LIMITS } from './collection-limits'

export const DEFAULT_PROBE_RECOVERY_MAX_RETRIES = COLLECTION_LIMITS.scheduler.defaultRetries
export const DEFAULT_PROBE_RECOVERY_RETRY_DELAY_MS = COLLECTION_LIMITS.scheduler.retryDelayMs
export const MAX_PROBE_RECOVERY_RETRY_DELAY_MS = COLLECTION_LIMITS.scheduler.maxRetryDelayMs
