import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'vendor-react'
          }
          if (id.includes('node_modules/@tauri-apps') || id.includes('node_modules/@choochmeque')) {
            return 'vendor-tauri'
          }
          if (id.includes('node_modules/@xterm')) {
            return 'vendor-terminal'
          }
          if (id.includes('node_modules/framer-motion')) {
            return 'vendor-motion'
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons'
          }
          if (id.includes('node_modules/jszip')) {
            return 'vendor-jszip'
          }
        },
      },
    },
  },
  test: {
    // Node's native test runner owns scripts/*.test.mjs and Agent publisher
    // tests. Vitest cannot count their TAP failures or preserve file: URLs.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 1421,
    strictPort: true,
    // Loopback by default. `tauri ios dev --force-ip-prompt` and `tauri android dev`
    // on a physical device set TAURI_DEV_HOST to the LAN IP the device connects to.
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
})
