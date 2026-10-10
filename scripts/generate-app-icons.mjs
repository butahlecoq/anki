import { readFile, writeFile } from 'node:fs/promises'
import { generateMaskableAsset } from '@vite-pwa/assets-generator/api'

// Keep the existing raster logo so the 記 glyph is independent of installed fonts.
const source = await readFile(new URL('../public/pwa-512x512.png', import.meta.url))
for (const [name, size] of [['apple-touch-icon-180x180.png', 180], ['maskable-icon-512x512.png', 512]]) {
  const image = await generateMaskableAsset('png', source, size, {
    padding: 0,
    resizeOptions: { background: '#0b0d10' },
    outputOptions: { compressionLevel: 9 },
  })
  await writeFile(new URL(`../public/${name}`, import.meta.url), await image.toBuffer())
}
