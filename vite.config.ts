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
    host: '0.0.0.0', // listen on IPv4 so iOS device can reach dev server via LAN IP
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
})
