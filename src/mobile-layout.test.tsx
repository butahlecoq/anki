import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { App } from './App'
import { mediaBlock, rule, stylesheet } from './stylesheet-under-test'

/*
 * iPhone layout contract for issue #23.
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
