import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, type UserConfig } from 'vite'
import { VitePWA, type ManifestOptions } from 'vite-plugin-pwa'

const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version
const previewAllowedHost = process.env.KIROKU_PREVIEW_ALLOWED_HOST
let commit = 'unknown'
try { commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* source archives may not include .git */ }

export default defineConfig(({ command }) => ({
  define: {
    'import.meta.env.VITE_KIROKU_BUILD_VERSION': JSON.stringify(version),
    'import.meta.env.VITE_KIROKU_BUILD_COMMIT': JSON.stringify(commit),
    'import.meta.env.PROD': JSON.stringify(command === 'build'),
  },
  ...(previewAllowedHost ? { preview: { allowedHosts: [previewAllowedHost] } } : {}),
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: ({
        name: 'Kiroku — Japanese Study',
        short_name: 'Kiroku',
        description: 'An offline-first Japanese flashcard workspace.',
        theme_color: '#0b0d10',
        background_color: '#0b0d10',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        orientation: 'any',
        categories: ['education', 'productivity'],
        kiroku: { version, commit },
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      } as Partial<ManifestOptions> & { kiroku: { version: string; commit: string } }),
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,wav,woff2,wasm}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
} as UserConfig))
