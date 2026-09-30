import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const syncRuntimeDirectory = join(tmpdir(), 'kiroku-e2e-sync')

export default defineConfig({
  testDir: './tests/e2e',
  // Windows WebKit can corrupt trace artifacts when multiple contexts in the
  // same file close concurrently. Keep each browser's user journey serial.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'iphone-webkit',
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: [
    {
      command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run server:start',
      url: 'http://127.0.0.1:4174/api/health',
      env: { ...process.env, KIROKU_RUNTIME_DIRECTORY: syncRuntimeDirectory },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
