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

## Populated history, touch, and complete keyboard coverage

The branch is rebased onto merged #235 and #234 (`a0f9e5f`). Its first independent
spec review found two evidence gaps: mouse clicks did not establish touch input,
and empty history did not demonstrate a change in daily statistics. The public
regression now loads the sample deck, answers one card, and ends the session.
It checks that the reviewed day has one answer and one studied-card link while an
empty day has zero. It traverses all 84 dates using Tab and activates the last
with Enter at both actual widths. Target centers must be unobstructed.

The first touch attempt passed Chromium but timed out in Windows WebKit:
`heatmap-populated-touch-green.log` (failed evidence despite the provisional file
name), `runtime/239-populated-touch-green`. A plain HTML scroller reproduced the
interception without the application, including after instant scrolling. This
alone did not establish a smooth-scroll defect.

A separate plain HTML `touchstart` probe isolated input coordinates. At the
calibrated Windows WebKit canvas, injected (300,300) arrived at (240,240), while
injected (375,375) arrived at (300,300). Chromium received its injected coordinates
unchanged. Evidence: `runtime/239-tap-coordinate-probe.mjs` and
`tap-coordinate-probe.log`. The test compensates native touchscreen input by the
same measured host scale used for viewport calibration. It centers the visible
target first, sends a native touch, checks target hit-testing/activation, and
checks the resulting statistics. No application scrolling code was changed.

The expanded test passes both engines: **2 passed, 35.0 seconds**,
`heatmap-populated-final-green.log`, `runtime/239-populated-final-green`.
A controlled rollback of only the mobile grid minimum to zero fails both
engines at the width assertion: **40.84375px** in Chromium and approximately
**41.00px** in WebKit, against 43.99px. Evidence:
`heatmap-populated-width-red.log`, `runtime/239-populated-width-red`.
The accepted stylesheet was restored before the final green run; its tracked
contents match the accepted sizing fix.

Populated WebKit heatmap/lower-panel screenshots were inspected. They exposed a
separate raw template identifier in the studied-card link, now tracked in
[#246](https://github.com/butahlecoq/anki/issues/246). Visible date labels remain
#240. The final full software gate and final-head review remain required before
acceptance or merge.
