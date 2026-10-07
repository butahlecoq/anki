# Mobile Statistics touch targets — #239

The owner accepts iPhone sized Playwright/WebKit evidence for layout changes.
The date grid now has a 44px minimum column width. At narrow widths its named
`Study dates` region scrolls horizontally; the page itself does not overflow.
The selection outline has padding inside that region.

## Focused evidence

`tests/e2e/mobile-statistics.spec.ts` uses the visible Statistics page from a
clean profile. It checks all 84 date buttons at measured widths 390 and 320,
requires width and height of at least 43.99px (subpixel tolerance), selects the
first and last dates, checks the daily filter and selected state, and uses
Tab/Enter on the second date. Screenshots cover the heatmap and lower panels.

```powershell
$env:KIROKU_WEB_PORT = '4186'
$env:KIROKU_SYNC_PORT = '4187'
npx playwright test tests/e2e/mobile-statistics.spec.ts --output=runtime/239-green
```

The original layout failed in both engines: widths 41.70px in Chromium and
41.86px in WebKit were below the minimum. The focused run after the fix passed
both projects: **2 passed, 23.4 seconds** (`heatmap-green.log`). The full software
gate and independent review remain required before completion.

On Windows the fixture measures WebKit's host display scaling before configuring
the canvas. It retains touch and Safari user agent, uses desktop viewport
interpretation, and asserts the actual `innerWidth` at each size. This verifies
phone layout; it does not establish physical iOS behavior.

Artifacts are ignored local files beneath `runtime/239-green`. The date buttons
still rely on accessible labels/title for their date identity. Visible date
labels are tracked separately in [#240](https://github.com/butahlecoq/anki/issues/240).
