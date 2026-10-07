# Mobile design audit — 2026-10-07

Related issues: [#235](https://github.com/butahlecoq/anki/issues/235),
[#238](https://github.com/butahlecoq/anki/issues/238), and
[#239](https://github.com/butahlecoq/anki/issues/239).

The owner authorized autonomous visual improvements and accepted iPhone sized
Playwright/WebKit as the design review environment. Physical device approval is
not required for these layout changes.

## Scope and decisions

All eight original screenshots in `.packages` were inspected. The changes for
#235 give review a fixed card area and answer bar, put secondary review actions
in a keyboard accessible menu, and allow long card content to scroll inside the
card. Matching has its own scrollable session. Deck count spacing is independent
of title length. Dialog action pairs share a baseline. The package picker has a
styled button and an ellipsized filename. Safe area insets apply to the header,
navigation, and dialog bounds.

The learner can choose app colors or the original deck colors during review.
This preference changes the rendered body without rewriting imported templates
or media. Ordinary note type previews preserve authored presentation.

## Browser evidence

`tests/e2e/mobile-design-audit.spec.ts` drives the visible app from a clean
profile, without database setup or mocked app APIs. It captures all primary
routes and their main dialogs: empty Collection, package selection, PC pairing,
populated Collection, new deck, export, text transfer, Note types, Study, Browse,
Statistics, new note type, deck detail, new/edit note, child/move/rename/remove
deck, scheduling options, card management, activity selection, matching setup
and active matching, review front/back/actions/card info, completion, custom
study, and AnkiWeb connection. Additional overlapping viewport captures cover
lower page content. Each capture records actual and configured viewport sizes
and visible control geometry in `mobile-design-observations.json`.

Run with isolated ports:

```powershell
$env:KIROKU_WEB_PORT = '4182'
$env:KIROKU_SYNC_PORT = '4183'
npx playwright test tests/e2e/mobile-design-audit.spec.ts --output=runtime/mobile-design-audit
```

Artifacts are local, ignored runtime files. The original images are private
user supplied references; they are not copied into the public repository.

The Windows WebKit embedder applies Windows display scaling even to a minimal
blank page. The audit measures this scaling and compensates its configured
viewport. On this host the configured canvas is 488 × 1055 with DPR 2.4; the
measured canvas is 390 × 844 with DPR 3. Safari user agent and touch remain
enabled; desktop viewport interpretation is used on Windows to obtain the
measured width. Ordinary iPhone emulation remains covered by the other browser
journeys. WebKit's full page screenshot also crops the right side on this host,
so the audit uses overlapping ordinary viewport screenshots instead.

## Regression coverage

- `review-layout.spec.ts`: fixed geometry through reveal and next sample card;
  review menu keyboard access and focus return; package picker initial focus,
  file chooser, long filename and action alignment; deck separator spacing;
  simulated 47px top/34px bottom insets and a short viewport.
- `card-layout.spec.ts`: oversized imported HTML, authored colors, late media,
  resizing, and fixed review geometry through reveal.
- `collection.spec.ts`: fixed geometry for typed answers and image occlusion,
  plus existing edit, flag, suspend, delete, undo, media, and sync journeys.
- `matching-activity.spec.ts`: matching overflow remains scrollable on touch
  screens; matching honors the same reversible color choice as review.
- `button-alignment.spec.ts`: consistent action dimensions and a page overflow
  check proven to detect a deliberately oversized element.
- `appearance.spec.ts`: selected app themes and explicit original deck colors.
- `dialog-keyboard.spec.ts`: export after review, open the package picker with
  Enter, choose the exported file, and import it into a clean collection. The
  redesigned dialog focuses `Choose package`; the old assertion against its
  hidden file input was updated to exercise the visible control and real chooser.

## Findings tracked separately

- #238: Persistent global utility controls and tall heroes push Browse search
  and Study's form below the first screen. The non-review header truncates its
  offline status. WebKit also records a 440px document scroll width against a
  390.4px root in Study and its Custom Study Session preview. Compact mobile
  composition and this overflow are tracked in that issue's own worktree.
- #239: Statistics date buttons measured approximately 41.86 × 44px at actual
  width 390. A separate regression covers widths 320 and 390, date selection,
  keyboard access, page overflow, and lower Statistics panels.
- #240: Empty heatmap cells do not show their date before selection on touch
  screens. Visible date labels are tracked independently of target sizing.

## Earlier verification checkpoints

The full `npm run check` reached **135 browser tests passed, 14 skipped, 1
failed** (`ui-full-check.log`). Type, lint, 686 unit tests, 22 tracker/status tests,
45 server tests, and build passed. The failed WebKit CSV journey exceeded its
240-second timeout; its browser log contains repeated internal WebKit load
errors. The trace stopped during a checkbox click after the engine reported the
element visible, enabled, stable, and scrolled into view. The unchanged journey
passed alone: `npx playwright test tests/e2e/text-csv.spec.ts
--project=iphone-webkit --output=runtime/235-csv-probe`, **1 passed in 42 seconds**.
This is evidence for an engine stall, not a completed diagnosis or a passing
full gate.

A subsequent whole-gate run also had 135 browser passes, 14 skips, and one
failure. This time the review-layout journey exceeded its 30-second test budget.
Its trace records the reveal and next-card geometry assertions completing before
the final page-scroll read timed out. That multi-step test now has a 60-second
execution budget; its one-pixel geometry limits and page-scroll assertion are
unchanged. See #235 for whole-gate results and review status. These earlier
failed runs are retained as diagnostic evidence.

Both all-page audits completed 32 captures. Their measured canvases were
390 × 844 with DPR 3. Artifacts from the failed full run are retained in
`runtime/235-full-check-artifacts` and `runtime/235-full-retry-artifacts` before
subsequent tests replace `test-results`.

## Platform limits

This is layout and browser interaction evidence. It does not establish physical
iOS installation, cold offline launch, or audible playback. Existing unsupported
WebKit service worker journeys retain their documented skips. The account dialog
is audited without submitting owner credentials. No successful owner AnkiWeb
exchange is claimed by this audit.
