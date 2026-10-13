import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { App } from './App'
import { mediaBlock, rule, stylesheet } from './stylesheet-under-test'

/*
 * iPhone layout contract for issues #23 and #348.
 *
 * jsdom does not lay out or paint, so pixel overflow is not assertable here;
 * those journeys run in CI under Playwright. This suite instead pins the
 * structural rules the stylesheet must keep, and the visible reachability of
 * every workspace destination, so a regression is caught before it ships.
 */

const phone = mediaBlock('max-width: 680px')

afterEach(cleanup)

describe('iPhone chrome', () => {
  test('the phone breakpoint keeps the bottom navigation clear of the home indicator', () => {
    expect(stylesheet).toContain('--safe-bottom: env(safe-area-inset-bottom, 0px)')
    expect(phone).toContain('--mobile-nav-height: calc(66px + var(--safe-bottom))')
    expect(phone).toMatch(/\.mobile-nav\s*\{[^}]*padding:[^;]*var\(--safe-bottom\)/)
    expect(phone).toMatch(/\.mobile-nav\s*\{[^}]*position:\s*fixed/)
  })

  test('the phone header stays pinned below the status bar the phone draws over the page', () => {
    // An installed iPhone paints its clock and battery across the top of the
    // page. A header that scrolls away with the content leaves that band over
    // whatever is being read, so the header stays put and content passes under
    // it.
    expect(phone).toMatch(/\.topbar\s*\{[^}]*position:\s*sticky[^}]*\btop:\s*0\b/)
    // It has to be opaque, not tinted: the header's job is to hide what passes
    // under it, and a translucent surface lets the content ghost through.
    expect(phone).toMatch(/\.topbar\s*\{[^}]*background:\s*var\(--surface-page\)/)
    // The status-bar band has to come from the one inset token, so that an
    // injected token and a real device inset reserve the same space. --safe-top
    // is itself env(safe-area-inset-top, 0px); this is about the phone block
    // reading the token rather than reaching past it for the environment.
    expect(phone).toMatch(/\.topbar\s*\{[^}]*height:\s*calc\(76px \+ var\(--safe-top\)\)/)
    expect(phone).toContain('padding-top: max(var(--safe-top), 20px)')
    expect(phone).toContain('box-sizing: border-box; height: calc(60px + max(var(--safe-top), 20px))')
    expect(phone).not.toContain('env(safe-area-inset-top')
    // A more specific review rule that re-declared `position` would silently
    // outrank the pin above. Review does not scroll the page, so it needs the
    // sticky header too rather than a competing one.
    expect(phone).not.toMatch(/\.is-reviewing \.topbar\s*\{[^}]*position:\s*relative/)
  })

  test('the phone breakpoint leaves room for the fixed bottom navigation', () => {
    // Content must not hide behind the fixed navigation bar.
    expect(phone).toMatch(/\.main\s*\{[^}]*padding:\s*0 18px calc\(148px \+ var\(--mobile-nav-height\)\)/)
    expect(phone).toContain('.tile-action { scroll-margin-bottom: 92px; }')
  })

  test('the widest table scrolls inside its own box instead of the page', () => {
    // The browser table is 900px wide; only its wrapper may scroll, so the
    // shell itself never scrolls sideways on a phone.
    expect(stylesheet).toMatch(/\.browser-table-scroll\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/)
    expect(stylesheet).toMatch(/\.browser-table\s*\{[^}]*min-width:\s*900px/)
  })

  test('form controls keep a 16px font on phones so iOS does not zoom on focus', () => {
    // iOS Safari zooms any focused field under 16px, which breaks phone layout.
    const fontSizes = [...phone.matchAll(/font-size:\s*16px/g)]
    expect(fontSizes.length).toBeGreaterThanOrEqual(2)
    expect(phone).toMatch(/\.browser-search input/)
    expect(phone).toMatch(/\.custom-study-create input/)
  })
})

describe('touch targets', () => {
  test('coarse pointers get a 44px minimum on interactive controls', () => {
    const coarse = mediaBlock('pointer: coarse')
    expect(coarse).toContain('min-height: 44px')
    for (const selector of ['.text-button', '.nav-item', '.mobile-nav a', '.primary-action', '.rating']) {
      expect(coarse, `${selector} missing a touch-target rule`).toContain(selector)
    }
  })

  test('the keyboard shortcut legend does not occupy a phone reviewer', () => {
    // It is discoverability for a keyboard. At 390px it wrapped to four lines
    // and pushed the card most of a screen down before any Japanese appeared.
    expect(mediaBlock('pointer: coarse')).toContain('.review-shortcuts')
    // The legend still has to exist for the desktop, or the bindings it names
    // become undiscoverable rather than merely compact.
    expect(rule('.review-shortcuts')).toContain('--text-faint')
  })
})

describe('reduced motion', () => {
  test('animation and transition are neutralised on request', () => {
    const reduced = mediaBlock('prefers-reduced-motion: reduce')
    expect(reduced).toContain('animation-duration')
    expect(reduced).toContain('transition-duration')
    expect(reduced).toContain('scroll-behavior: auto')
  })

  test('the ambient connection pulse is not the only animation', () => {
    // The pulse is decorative; it is disabled by the reduced-motion block.
    expect(stylesheet).toContain('@keyframes pulse')
  })
})

describe('issue #348 phone layouts', () => {
  test('the review keeps four answer buttons in a constrained row with distinct answer colors', () => {
    expect(rule('.review-answer-controls .rating-grid')).toContain('repeat(4, minmax(0, 1fr))')
    expect(rule('.rating-grid > .rating')).toContain('min-width: 0')
    for (const [selector, token] of [
      ['.rating-again', '--status-danger'],
      ['.rating-hard', '--status-warn'],
      ['.rating-good', '--accent-strong'],
      ['.rating-easy', '#69a9e8'],
    ]) expect(rule(selector)).toContain(token)
  })

  test('the 30-day heatmap keeps full-size dates inside its scroll region', () => {
    expect(rule('.statistics-controls input, .statistics-controls select')).toContain('box-sizing: border-box')
    expect(rule('.review-heatmap')).toContain('repeat(12, minmax(44px, 1fr))')
    expect(rule('.heatmap-scroll')).toContain('overflow-x: auto')
    expect(phone).toMatch(/\.review-heatmap\s*\{[^}]*grid-template-columns:\s*repeat\(7, minmax\(44px, 1fr\)\)/)
    expect(phone).toMatch(/\.statistics-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/)
  })

  test('account Deck paths have separators and the import summary is compact with surrounding space', () => {
    expect(rule('.ankiweb-deck-list li')).toContain('border-bottom: 1px solid var(--border-subtle)')
    expect(rule('.import-review-toggle')).toContain('font-size: 13px')
    expect(rule('.import-review-toggle')).toContain('margin: 14px 0 18px')
  })

  test('completion fireworks use the reduced-motion preference', () => {
    expect(stylesheet).toContain('@keyframes completion-firework')
    expect(mediaBlock('prefers-reduced-motion: reduce')).toContain('.completion-fireworks i { animation: none; }')
  })
})

describe('visible destinations', () => {
  test('both navigations expose every workspace destination', () => {
    render(<App />)
    const names = ['Decks', 'Note types', 'Study', 'Browse', 'Statistics']
    for (const navigation of [
      screen.getByRole('navigation', { name: 'Primary navigation' }),
      screen.getByRole('navigation', { name: 'Mobile navigation' }),
    ]) {
      for (const name of names) expect(within(navigation).getByRole('link', { name })).toBeVisible()
    }
  })

  test('the appearance control is reachable and named', () => {
    render(<App />)
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toBeVisible()
  })
})
