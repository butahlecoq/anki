import { expect, test } from 'vitest'
import { APPEARANCE_FALLBACK_COLORS } from './appearance'
import { indexHtml, rule, source, stylesheet } from './stylesheet-under-test'

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
  // The colour keywords are included because `background: white` is what
  // .template-preview iframe carried for as long as this rule existed: a hex or
  // rgb() scan reads it as compliant, and it painted the card white under the
  // dark theme. A list of colour names was tried first and rejected: it is a
  // standing invitation to add the next one, and `gold`, `rebeccapurple` and
  // `1px solid whitesmoke` all passed it.
  //
  // What is flagged instead is a *bare word* in a colour-bearing property that is
  // not a structural keyword. Every CSS named colour is a bare word, and the
  // structural keywords - widths, line styles, gradients, var() - are either not
  // bare words or are in a list that is fixed by the CSS specification rather
  // than by the palette. So this needs no maintenance as colours are added.
  const structural = /^(?:inherit|initial|unset|revert(?:-layer)?|none|auto|hidden|transparent|currentcolor|solid|dashed|dotted|double|groove|ridge|inset|outset|collapse|separate|medium|thick|thin|butt|bevel|miter|italic|normal|lighter|darker|oblique|small-caps|underline|overline|line-through|wavy|solid|space-around|space-between|space-evenly|start|end|center|left|right|top|bottom|both|repeat|no-repeat|cover|contain|border-box|padding-box|content-box|screen|print|all|local|scroll|clip|ellipsis|pre|pre-wrap|pre-line|break-word|anywhere|ltr|rtl|uppercase|lowercase|capitalize|nowrap|min-content|max-content|fit-content|min|max|clamp|calc|env|attr|counter|counters|url|local)$/i
  const paint = /\b(color|background|background-color|border|border-color|border-top|border-right|border-bottom|border-left|border-top-color|border-right-color|border-bottom-color|border-left-color|outline|outline-color|fill|stroke|caret-color|accent-color|text-decoration|text-decoration-color|text-shadow|box-shadow)\s*:\s*([^;}]+)/gi
  const offenders = [...body.matchAll(paint)]
    // A value containing a function is built rather than named: gradients,
    // color-mix() and var() are all legitimate, and their interior words
    // (`radial-gradient`, `at`, `srgb`) are not colours.
    .filter(([, , value]) => !value.includes('('))
    .flatMap(([, property, value]) =>
      value
        .split(/[\s,/]+/)
        .filter((token) => /^[a-z]+$/i.test(token) && !structural.test(token))
        .map((token) => `${property}: ${token}`))
  expect(offenders).toEqual([])
})

/*
 * Card surface contract.
 *
 * The card renders in a separate document, so its colours cannot come from the
 * tokens above and are declared in the srcDoc string instead. They are held to
 * the same WCAG AA rule here, because a themed card that nobody can read is a
 * worse defect than the white card this replaced.
 */
const cardDocument = source('src/TemplatePreview.tsx')

/**
 * The srcDoc template literal on its own.
 *
 * Scoping to it matters: the comment above it names `${rendering.css}` to
 * explain the ordering, so a search over the whole file finds the explanation
 * before the declaration and reports the stylesheet backwards.
 */
const cardSrcDoc = /const srcDoc = `([\s\S]*?)<\/html>`/.exec(cardDocument)?.[1]
  ?? (() => { throw new Error('src/TemplatePreview.tsx no longer builds a srcDoc literal') })()

function cardTokens(block: RegExp): Palette {
  const found: Palette = {}
  // The last declaration in each block is closed by the block's brace rather
  // than a semicolon, so both are accepted as terminators.
  for (const [, name, value] of block.exec(cardSrcDoc)?.[0].matchAll(/(--kiroku-card-[a-z-]+)\s*:\s*([^;}]+)[;}]/g) ?? []) found[name] = value.trim()
  return found
}

test('the card document themes its own surface and ink in both themes', () => {
  const darkCard = cardTokens(/:root\{[^}]*\}/)
  const lightCard = cardTokens(/:root\[data-theme='light'\]\{[^}]*\}/)
  expect(Object.keys(darkCard).sort()).toEqual(['--kiroku-card-ink', '--kiroku-card-link', '--kiroku-card-surface'])
  expect(Object.keys(lightCard).sort()).toEqual(Object.keys(darkCard).sort())

  // The body must consume the properties rather than name a colour, and the deck
  // CSS must still be appended after them so an import can override the default.
  expect(cardSrcDoc).toContain('color:var(--kiroku-card-ink);background:var(--kiroku-card-surface)')
  expect(cardSrcDoc).toContain('a[data-kiroku-href]{color:var(--kiroku-card-link)')
  expect(cardSrcDoc.indexOf('${rendering.css}')).toBeGreaterThan(cardSrcDoc.indexOf('--kiroku-card-surface:#101317'))
  // An absent data-theme means dark, which is the convention applyAppearance uses.
  expect(cardSrcDoc).toContain(':root{--kiroku-card-surface:#101317;')
  expect(cardSrcDoc).toContain(":root[data-theme='light']{--kiroku-card-surface:#ffffff;")
  // `color-scheme` would repaint scrollbars and form controls inside an imported
  // deck. Story 13 asks that imported cards keep their intended presentation.
  expect(cardSrcDoc).not.toContain('color-scheme')
})

test('the card palette is pinned to the tokens it stands in for', () => {
  // The card is a separate document, so it cannot read the host's custom
  // properties and has to carry literal values. That makes these a second home
  // for the same colours, which is the "same fact in several homes" shape ADR
  // 0002 is about. This is the guard that keeps them one fact, exactly as
  // APPEARANCE_FALLBACK_COLORS is pinned to --surface-page above.
  const darkCard = cardTokens(/:root\{[^}]*\}/)
  const lightCard = cardTokens(/:root\[data-theme='light'\]\{[^}]*\}/)
  expect(darkCard['--kiroku-card-surface']).toBe(dark['--surface-panel'])
  expect(darkCard['--kiroku-card-ink']).toBe(dark['--text-primary'])
  expect(lightCard['--kiroku-card-surface']).toBe(light['--surface-panel'])
  expect(lightCard['--kiroku-card-ink']).toBe(light['--text-primary'])
})

test('a deck that overrides only one half of the themed pair is a known, visible hazard', () => {
  // There is no CSS-only fix. Colouring the surface without colouring the ink
  // leaves dark ink on a dark card; colouring both means a deck that overrides
  // only its background keeps the themed ink, and in the dark theme
  // #e9ede3 on #ffffff is 1.19:1. Real Anki has the same behaviour. It is pinned
  // here so the trade-off is a decision rather than an accident, and so a future
  // change that alters either value has to confront it.
  const darkCard = cardTokens(/:root\{[^}]*\}/)
  const halfSpecified = contrast(darkCard['--kiroku-card-ink'], '#ffffff')
  expect(halfSpecified).toBeLessThan(4.5)
  expect(
    contrast(darkCard['--kiroku-card-ink'], darkCard['--kiroku-card-surface']),
  ).toBeGreaterThanOrEqual(4.5)
})

test('card ink and links clear WCAG AA against the card surface in both themes', () => {
  const darkCard = cardTokens(/:root\{[^}]*\}/)
  const lightCard = cardTokens(/:root\[data-theme='light'\]\{[^}]*\}/)
  for (const [name, tokens] of [['dark', darkCard], ['light', lightCard]] as const) {
    const surface = tokens['--kiroku-card-surface']
    for (const ink of ['--kiroku-card-ink', '--kiroku-card-link'] as const) {
      const ratio = contrast(tokens[ink], surface)
      expect(ratio, `${name}: ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  }
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
