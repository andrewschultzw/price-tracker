import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
  preview: {
    host: true,
    allowedHosts: ['preview.schultzsolutions.tech'],
    proxy: {
      '/api': 'http://192.168.1.166:3100',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
  },
})
