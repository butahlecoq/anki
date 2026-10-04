import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const syncRuntimeDirectory = process.env.KIROKU_RUNTIME_DIRECTORY ?? join(tmpdir(), `kiroku-e2e-sync-${process.pid}`)
const webPort = process.env.KIROKU_WEB_PORT ?? '4173'
const webURL = `http://127.0.0.1:${webPort}`
const syncPort = process.env.KIROKU_SYNC_PORT ?? '4174'
const syncURL = `http://127.0.0.1:${syncPort}`

export default defineConfig({
  testDir: './tests/e2e',
  // Test workers do not inherit mutations made while this config is evaluated.
  // Metadata is serialized into every worker's TestInfo, so helpers can use the
  // same generated directory as the sync web server on every platform.
  metadata: { syncRuntimeDirectory },
  // Windows WebKit can corrupt trace artifacts when multiple contexts in the
  // same file close concurrently. Keep each browser's user journey serial.
  fullyParallel: false,
  // Windows WebKit becomes intermittently starved when six browser workers
  // compete for the host. Keep the local gate deterministic; CI may choose
  // its own worker count.
  workers: process.env.CI ? undefined : 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: webURL,
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
      command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${webPort}`,
      url: webURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run server:start',
      url: `${syncURL}/api/health`,
      env: { ...process.env, PORT: syncPort, KIROKU_RUNTIME_DIRECTORY: syncRuntimeDirectory, KIROKU_ALLOWED_ORIGIN: webURL },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
