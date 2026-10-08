import { expect, type Browser, type Page, type TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { basename, dirname, join } from 'node:path'

interface FontFile { filename: string; sha256: string; versions: string[]; versionMetadata: 'reported' | 'unreported' }

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Read SFNT name-table version strings, including faces inside a TTC file. */
function fontVersions(bytes: Buffer): string[] {
  const faces = bytes.toString('ascii', 0, 4) === 'ttcf'
    ? Array.from({ length: Math.min(bytes.readUInt32BE(8), 64) }, (_, index) => bytes.readUInt32BE(12 + index * 4))
    : [0]
  const versions = new Set<string>()
  for (const face of faces) {
    const tables = bytes.readUInt16BE(face + 4)
    for (let table = 0; table < tables; table++) {
      const record = face + 12 + table * 16
      if (bytes.toString('ascii', record, record + 4) !== 'name') continue
      const offset = bytes.readUInt32BE(record + 8)
      const count = bytes.readUInt16BE(offset + 2)
      const strings = offset + bytes.readUInt16BE(offset + 4)
      for (let name = 0; name < count; name++) {
        const entry = offset + 6 + name * 12
        if (bytes.readUInt16BE(entry + 6) !== 5) continue
        const length = bytes.readUInt16BE(entry + 8)
        const start = strings + bytes.readUInt16BE(entry + 10)
        const platform = bytes.readUInt16BE(entry)
        const encoded = Buffer.from(bytes.subarray(start, start + length))
        const text = platform === 0 || platform === 3 ? encoded.swap16().toString('utf16le') : encoded.toString('latin1')
        versions.add(text.replaceAll('\0', '').trim())
      }
    }
  }
  return [...versions].sort()
}

function describeFont(path: string): FontFile {
  try {
    const bytes = readFileSync(path)
    let versions: string[] = []
    try { versions = fontVersions(bytes) } catch { /* Byte identity still records an exact font when metadata is unavailable. */ }
    return { filename: basename(path), sha256: sha256(bytes), versions, versionMetadata: versions.length ? 'reported' : 'unreported' }
  } catch {
    // A native filesystem/Fontconfig exception can contain a private path.
    throw new Error(`Cannot record font ${basename(path)}. Verify the baseline font installation before comparing or regenerating.`)
  }
}

function systemFonts() {
  let paths: string[]
  let resolutions: { request: string; candidateFile: string }[] = []
  if (process.platform === 'win32') {
    const directory = join(process.env.WINDIR ?? 'C:/Windows', 'Fonts')
    // Candidates for the production Japanese/system/deck/monospace stacks.
    // Segoe UI styles use segui* basenames, including seguisb.ttf (Semibold).
    try {
      paths = readdirSync(directory).filter(name => /^(biz|yu|meiryo|segoe|segui|consol|arial).+\.(ttf|ttc|otf)$/i.test(name)).map(name => join(directory, name))
    } catch {
      throw new Error('Cannot discover Windows baseline system fonts. Verify the Windows system font installation before comparing or regenerating.')
    }
  } else {
    try {
      const requests = ['Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'BIZ UDPGothic', 'Noto Sans JP', 'Noto Sans CJK JP', 'Yu Gothic', 'Meiryo', 'sans-serif', 'monospace',
        // Proportional deck-title candidates, including its semibold weight.
        // Fontconfig substitution does not establish the browser's system-ui mapping.
        'Segoe UI', 'Segoe UI:weight=demibold', 'system-ui', 'system-ui:weight=demibold', 'sans-serif:weight=demibold',
        // Family-only substitution can resolve a Latin face that lacks the
        // Japanese glyphs. Record character/language fallbacks as candidates,
        // without pretending Fontconfig proves the browser's actual used face.
        'sans-serif:charset=732b:lang=ja', 'monospace:charset=732b:lang=ja',
        'sans-serif:charset=306d:lang=ja', 'monospace:charset=306d:lang=ja',
        'sans-serif:charset=0416:lang=ru', 'monospace:charset=0416:lang=ru',
      ]
      paths = requests.map(request => execFileSync('fc-match', ['--format=%{file}', request], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim())
      resolutions = requests.map((request, index) => ({ request, candidateFile: basename(paths[index]) }))
    } catch {
      throw new Error('Cannot resolve Linux baseline fonts. Install fontconfig and the documented baseline fonts; no snapshots were accepted.')
    }
  }
  expect(paths.length, 'No baseline system fonts were found; verify the documented font installation.').toBeGreaterThan(0)
  return {
    kind: process.platform === 'win32' ? 'system-stack-candidates' : 'fontconfig-candidate-resolutions',
    resolutions,
    files: [...new Set(paths)].map(describeFont).sort((left, right) => left.filename.localeCompare(right.filename)),
  }
}

function bundledFonts() {
  const directory = 'node_modules/@fontsource-variable/jetbrains-mono'
  const css = readFileSync(join(directory, 'index.css'), 'utf8')
  const files = [...new Set([...css.matchAll(/url\(\.\/files\/([^\s)]+)\)/g)].map(match => match[1]))].sort()
  const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version as string
  return { package: '@fontsource-variable/jetbrains-mono', version, files: files.map(filename => ({ filename, sha256: sha256(readFileSync(join(directory, 'files', filename))) })) }
}

let fontEnvironment: { system: ReturnType<typeof systemFonts>; bundled: ReturnType<typeof bundledFonts> } | undefined

/** Capture rendering inputs only; never emit hostnames, usernames or font paths. */
export async function verifyVisualEnvironment(page: Page, browser: Browser, hostScale: number, info: TestInfo) {
  fontEnvironment ??= { system: systemFonts(), bundled: bundledFonts() }
  const browserName = info.project.use.browserName ?? (info.project.name === 'iphone-webkit' ? 'webkit' : 'chromium')
  const engines = JSON.parse(readFileSync('node_modules/playwright-core/browsers.json', 'utf8')).browsers as { name: string; revision: string; browserVersion?: string }[]
  const engine = engines.find(item => item.name === browserName)
  expect(engine, `Pinned browser ${browserName} is absent from the installed Playwright package.`).toBeDefined()
  const canvas = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
  const signature = {
    platform: process.platform, architecture: process.arch,
    playwright: JSON.parse(readFileSync('node_modules/@playwright/test/package.json', 'utf8')).version as string,
    browser: { name: browserName, version: browser.version(), revision: engine!.revision },
    fonts: fontEnvironment, canvas, locale: 'en-US', timezone: 'UTC',
    fixedTime: '2026-10-07T12:00:00.000Z', reviewElapsedMs: 0,
    comparison: { threshold: 0, maxDiffPixels: 0, masks: [] },
    capturePreparation: browserName === 'chromium' ? 'full-page capture before viewport/panel comparison' : 'native calibrated viewport',
    fontStacks: await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      return {
        ui: root.getPropertyValue('--font-ui').trim(),
        japanese: root.getPropertyValue('--font-jp').trim(),
        deck: root.getPropertyValue('--font-deck').trim(),
      }
    }),
  }
  // OS/kernel and source provenance remain evidence, rather than treating a
  // WSL kernel as an identical GitHub-hosted kernel. Fonts/browser/pixels must
  // still agree. Do not emit os.hostname(), home directories or native paths.
  const evidence = {
    signature,
    observed: {
      osRelease: release(), node: process.version,
      osDistribution: process.platform === 'linux'
        ? readFileSync('/etc/os-release', 'utf8').split('\n').filter(line => /^(NAME|VERSION_ID|VERSION)=/.test(line)) : ['Windows'],
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim(),
      lockfileSha256: sha256(readFileSync('package-lock.json')),
      configuredViewport: page.viewportSize(), hostScale,
    },
  }
  await info.attach('visual-environment', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  const manifest = info.snapshotPath('environment.json')
  if (info.config.updateSnapshots === 'all') {
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(manifest, `${JSON.stringify(evidence, null, 2)}\n`)
  } else {
    expect(existsSync(manifest), 'Missing visual environment manifest. Capture and review this verified platform using the documented --update-snapshots=all command; a normal comparison never creates baselines.').toBe(true)
    const baseline = JSON.parse(readFileSync(manifest, 'utf8')) as { signature: typeof signature }
    expect(signature, 'Visual rendering environment differs from its baseline. Restore the recorded browser/fonts/canvas, or deliberately review and regenerate platform baselines; never widen pixel tolerance.').toEqual(baseline.signature)
  }
}
