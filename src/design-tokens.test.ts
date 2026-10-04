import { expect, test } from 'vitest'
import { APPEARANCE_FALLBACK_COLORS } from './appearance'
import { indexHtml, rule, stylesheet } from './stylesheet-under-test'

/*
 * Design-token contract for issue #23.
 *
 * The stylesheet is the only place application chrome colors are defined, so
 * these checks read the real file rather than a copy. They fail when a token
 * pairing falls below WCAG AA, when a theme stops overriding a token, or when a
 * raw color literal reappears in the component body.
 */

type Palette = Record<string, string>

function tokens(source: string): Palette {
  const found: Palette = {}
  for (const [, name, value] of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) found[name] = value.trim()
  return found
}

const dark = tokens(rule(':root'))
const light = tokens(rule(":root[data-theme='light']"))

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255) as [number, number, number]
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 relative-contrast ratio, rounded to two decimals. */
export function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const [high, low] = a > b ? [a, b] : [b, a]
  return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100
}

const textTokens = [
  '--text-primary',
  '--text-strong',
  '--text-secondary',
  '--text-muted',
  '--text-faint',
  '--text-tile',
  '--text-note',
  '--text-answer',
  '--text-profile',
  '--accent',
  '--accent-strong',
  '--accent-ink',
  '--status-warn',
  '--status-danger',
  '--diff-good',
  '--diff-bad',
  '--diff-missed',
]

const surfaceTokens = [
  '--surface-page',
  '--surface-panel',
  '--surface-sunken',
  '--surface-hover',
  '--surface-tile-from',
  '--surface-tile-to',
  '--surface-canvas',
]

for (const [name, palette] of [['dark', dark], ['light', light]] as const) {
  test(`${name} theme text meets WCAG AA against every surface it can sit on`, () => {
    const failures: string[] = []
    for (const text of textTokens) {
      const value = palette[text]
      expect(value, `${name} theme is missing ${text}`).toBeDefined()
      for (const surface of surfaceTokens) {
        const background = palette[surface]
        expect(background, `${name} theme is missing ${surface}`).toBeDefined()
        const ratio = contrast(value, background)
        if (ratio < 4.5) failures.push(`${text} (${value}) on ${surface} (${background}) = ${ratio}:1`)
      }
    }
    expect(failures).toEqual([])
  })

  test(`${name} theme text on accent stays readable`, () => {
    expect(contrast(palette['--text-on-accent'], palette['--accent'])).toBeGreaterThanOrEqual(4.5)
  })

  test(`${name} theme keeps the ink/accent pairing used by filled actions`, () => {
    // .primary-action renders --accent-ink on --accent-wash, and the rating
    // buttons render --text-primary on --surface-hover.
    expect(contrast(palette['--accent-ink'], palette['--surface-panel'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(palette['--text-primary'], palette['--surface-hover'])).toBeGreaterThanOrEqual(4.5)
  })
}

test('light theme overrides every color token the dark theme defines', () => {
  const colorTokens = Object.keys(dark).filter((name) => {
    const value = dark[name]
    return /^#[0-9a-f]{3,8}$/i.test(value) || value.startsWith('rgba')
  })
  const missing = colorTokens.filter((name) => light[name] === undefined)
  expect(missing).toEqual([])
})

test('component styles reference tokens instead of raw color literals', () => {
  const lightEnd = stylesheet.indexOf("--shadow-dialog: 0 28px 90px rgba(24, 28, 20, .22);\n}")
  expect(lightEnd).toBeGreaterThanOrEqual(0)
  const body = stylesheet.slice(stylesheet.indexOf('}', lightEnd) + 1)
  const literals = [...body.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map((match) => match[0])
  expect(literals).toEqual([])
})

test('every referenced token is defined by a theme block', () => {
  // --deck-depth and --activity are supplied per element from TypeScript.
  // Layout variables are structural rather than theme tokens, but still need a
  // stylesheet declaration so their fallbacks and breakpoint overrides are
  // visible to every browser.
  const inline = new Set(['--deck-depth', '--activity'])
  const used = new Set([...stylesheet.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))
  const defined = new Set([...Object.keys(dark), ...Object.keys(light)])
  expect([...used].filter((name) => !defined.has(name) && !inline.has(name))).toEqual([])
})

test('the installed app is described consistently by the shell and both themes', () => {
  // src/appearance.ts reads --surface-page at runtime, so these constants are
  // only a fallback for a document whose stylesheet has not resolved yet. They
  // still have to name the same colours, or a first paint would disagree with
  // the page that follows it.
  expect(APPEARANCE_FALLBACK_COLORS.dark).toBe(dark['--surface-page'])
  expect(APPEARANCE_FALLBACK_COLORS.light).toBe(light['--surface-page'])

  // The first-paint theme-color is the dark default, and both schemes are
  // declared so the user agent does not assume the app is dark-only.
  expect(indexHtml).toContain(`<meta name="theme-color" content="${APPEARANCE_FALLBACK_COLORS.dark}" />`)
  expect(indexHtml).toContain('<meta name="color-scheme" content="dark light" />')
  expect(indexHtml).toContain('viewport-fit=cover')
})

test('chrome text colour is inherited from a token, not from the user agent', () => {
  // The dark theme relies on :root { color-scheme: dark } for the default text
  // colour, which Chromium resolves to canvastext but WebKit does not. Run
  // 37008036020 measured .panel-heading h2 at rgb(255, 255, 255) on
  // rgb(255, 255, 255) in the light theme on iphone-webkit - a ratio of 1, on an
  // iPhone-shaped viewport, where the heading was simply invisible. Body has to
  // name the colour it inherits so both engines agree.
  expect(rule('body')).toContain('color: var(--text-primary)')
})

test('Japanese study text uses the readable stack and interface text stays monospace', () => {
  expect(dark['--font-jp']).toContain('Hiragino Kaku Gothic ProN')
  expect(dark['--font-jp']).toContain('Noto Sans JP')
  expect(dark['--font-ui']).toContain('JetBrains Mono')
  // The stack is declared once per theme instead of repeated on every rule.
  const inline = [...stylesheet.matchAll(/font-family:\s*([^;]+);/g)].map((match) => match[1].trim())
  expect(inline.filter((value) => !value.startsWith('var(') && value !== 'inherit')).toEqual([])
})
