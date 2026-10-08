import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    maxWorkers: process.platform === 'win32' ? 4 : undefined,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/drift-check.test.mjs'],
    passWithNoTests: true,
  },
})
