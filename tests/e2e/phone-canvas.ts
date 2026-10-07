import { test as base } from '@playwright/test'

/** Calibrate the actual phone canvas while retaining touch and Safari's user agent. */
export function phoneCanvasTest(viewport: { width: number; height: number }) {
  return base.extend<{ hostScale: number }>({
    hasTouch: true,
    hostScale: async ({ browser, browserName }, provide) => {
      if (browserName !== 'webkit' || process.platform !== 'win32') return provide(1)
      const probe = await browser.newContext({ viewport: { width: 1000, height: 1000 }, isMobile: false, deviceScaleFactor: 1 })
      let scale = 1
      try { scale = await (await probe.newPage()).evaluate(() => 1000 / innerWidth) }
      finally { await probe.close() }
      await provide(scale)
    },
    viewport: async ({ hostScale }, provide) => provide({ width: Math.round(viewport.width * hostScale), height: Math.round(viewport.height * hostScale) }),
    isMobile: async ({ browserName }, provide) => provide(!(browserName === 'webkit' && process.platform === 'win32')),
    deviceScaleFactor: async ({ hostScale }, provide) => provide(3 / hostScale),
  })
}
