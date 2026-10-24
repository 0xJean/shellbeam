import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Explicitly selected by scripts/run-ops-live.mjs. No retries: a remote
// mutation whose outcome is unknown must never be replayed by the test runner.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['src/lib/ops-live.test.ts'],
    environment: 'jsdom',
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
})
