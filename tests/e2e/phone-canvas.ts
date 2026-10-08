import { test as base } from '@playwright/test'

/** Correct Windows WebKit's host scaling while retaining each project's canvas. */
export function nativeCanvasTest(phoneViewport?: { width: number; height: number }) {
  return base.extend<{ hostScale: number }>({
    hostScale: async ({ browser, browserName }, provide) => {
      if (browserName !== 'webkit' || process.platform !== 'win32') return provide(1)
      const probe = await browser.newContext({ viewport: { width: 1000, height: 1000 }, isMobile: false, deviceScaleFactor: 1 })
      let scale = 1
      try { scale = await (await probe.newPage()).evaluate(() => 1000 / innerWidth) }
      finally { await probe.close() }
      await provide(scale)
    },
    viewport: async ({ viewport, hostScale }, provide) => {
      const canvas = phoneViewport ?? viewport
      await provide(canvas && { width: Math.round(canvas.width * hostScale), height: Math.round(canvas.height * hostScale) })
    },
    isMobile: async ({ isMobile, browserName }, provide) => provide(browserName === 'webkit' && process.platform === 'win32' ? false : phoneViewport ? true : isMobile),
    deviceScaleFactor: async ({ deviceScaleFactor, hostScale }, provide) => provide((phoneViewport ? 3 : deviceScaleFactor ?? 1) / hostScale),
  })
}

/** Calibrate the actual phone canvas while retaining touch and Safari's user agent. */
export function phoneCanvasTest(viewport: { width: number; height: number }) {
  return nativeCanvasTest(viewport).extend({ hasTouch: true })
}
