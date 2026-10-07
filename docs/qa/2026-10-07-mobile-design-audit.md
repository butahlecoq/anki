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
  390.4px root in Study and its Custom Study Session preview. Review identified
  that deferring this overflow left #235 AC-02 incomplete. The select's native
  painting is now contained and its label uses a shrinkable grid column here;
  #238 retains the independent page composition work. Focused and whole-gate
  verification of this correction is recorded below.
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

The committed-head gate at `8b35939` again finished with 135 browser passes,
14 skips, and one CSV timeout. All five review-layout journeys passed in both
engines. Unlike the earlier CSV trace, this trace records 95 completed browser
calls, none longer than approximately 5.2 seconds. The whole 240-second deadline
expired while checking the final export-options section, before its remaining
assertions. The `browserContext.close` error is subsequent cleanup, not proof
that the journey had finished. This long multi-client CSV journey now has a
360-second total budget; assertions and individual expectation timeouts are
unchanged. This change requires focused verification and another full gate.
Artifacts are retained in `runtime/235-committed-head-artifacts`.

The next full gate, at `a6d3f41`, passed CSV and all review-layout tests, but
finished with 135 browser passes, 14 skips, and one Chromium Browse failure.
After clicking the asynchronous delete confirmation, the test immediately
cleared the background search input. The trace records the fill at 19391ms
and the old `tag:jlpt::*` value still present at 19396ms; the applied-delete
status appears at 19400ms. The final filtered view therefore hides the remaining
note. The public journey now waits for the deletion dialog to close and its
completion status before editing the search, and explicitly asserts the empty
input value. No product behavior or assertion timeout changed. This completion
barrier requires focused verification and a fresh full gate. Failure artifacts
are retained in `runtime/235-csv-budget-full-artifacts`.

This is layout and browser interaction evidence. It does not establish physical
iOS installation, cold offline launch, or audible playback. Existing unsupported
WebKit service worker journeys retain their documented skips. The account dialog
is audited without submitting owner credentials. No successful owner AnkiWeb
exchange is claimed by this audit.

## Independent review and follow-up

At `1549f1c`, the full gate passed: type/lint/build, 686 unit passes (4 skips),
22 tracker/status passes, 45 server passes, and 136 browser passes (14 skips).
The skips include external official-Anki/account fixtures without a configured
interpreter and platform-specific WebKit limitations. Artifacts are retained in
`runtime/235-final-green`; log: `ui-dialog-completion-full-check.log`.

The separate Matt Pocock standards review found no documented standard
violations, with a minor duplicate geometry-helper observation. The sample-card
journey now reuses `reviewGeometry` and `expectFixedReview`, including the
unchanged one-pixel tolerance and a stronger reveal-time answer-area check.

The spec review found Study overflow and desktop 42px dialog/hero actions below
AC-01's 44px minimum. Stronger public browser assertions reproduced both:
`review-findings-red.log` reports three failures and three passes, with Chromium
measuring 42px actions and actual-width-320 WebKit measuring 440px document
overflow. Actions now have a 44px minimum on desktop too. Study's scheduling
options and preview are checked at actual widths 320 and 390, and every all-page
audit capture now asserts no document overflow. The follow-up passed in both
engines: **18 passed in 2.1 minutes**, covering button alignment, Study at actual
widths 320/390, every route/main-dialog audit, and all five review-layout
journeys. Command: `npx playwright test tests/e2e/button-alignment.spec.ts
tests/e2e/mobile-design-audit.spec.ts tests/e2e/review-layout.spec.ts
--output=runtime/235-review-findings-green`. Ports were isolated at 4182/4183.
Log: `review-findings-green.log`; screenshots and observations are retained in
that output directory. The actual-width-390 WebKit Study image was inspected:
the page fits the screen, the native choice remains selectable, and the full
explanatory text below it remains readable. A fresh whole gate and independent
final-head review are still required; the earlier full gate does not cover
these changes.

The shared action styles also retained 42px primary buttons and 38px text
buttons outside the explicit hero/dialog rule. A public workspace regression
failed at desktop `Connect a PC` height 42px (`shared-actions-red.log`). Shared
primary/text actions now have a 44px minimum, including collection utilities
and deck-opening controls. The action and review-layout suites then passed in
both engines: **16 passed in 44.6 seconds**, command `npx playwright test
tests/e2e/button-alignment.spec.ts tests/e2e/review-layout.spec.ts
--output=runtime/235-shared-actions-green`; log `shared-actions-green.log`.

An official Anki 26.09.3 synthetic package was generated with this repository's
`scripts/generate-anki-compatibility-package.py` and the persistent pinned
interpreter from #234. The generated package is 57,517 bytes, SHA-256
`189826b24067c219eed8a75b88ff6528e73869be14e9c00a8e1cf9582cb78cc0`, retained
locally in `runtime/anki-26.09.3.colpkg`. With `KIROKU_ANKI_COMPAT_PACKAGE`
pointing to it, `npx vitest run src/anki-import.test.ts` passed all **25 tests**,
including the previously skipped official-package compatibility journey
(`official-package-import.log`). This synthetic fixture contains no owner
account material. The next whole gate enables this package and the pinned
account-fixture interpreter; current whole-gate/final-review status is tracked
on #235.

## Whole gate with official fixtures and native media diagnosis

At `9cbaedf`, the official-fixture gate passed type/lint/build, **687 unit
tests** (3 skipped), 22 tracker/status tests, and 45 server tests. Browser result:
**142 passed, 11 skipped, 1 failed**, 20.9 minutes. All action, review-geometry,
safe-area, all-page overflow, and CSV journeys passed. The newly enabled
official-package WebKit journey failed waiting for WAV media metadata. Artifacts
and the log are retained in `runtime/235-official-fixtures-full-9cbaedf`.

The independent plain-document probe `node runtime/235-native-wav-probe.mjs`
isolates this runner's native URL handling. Python's WAV reader validates the
files. Six variants cover PCM8/PCM16, optional RIFF JUNK chunk presence, and
0.1-second/1-second duration. Each is tested through data, blob, and HTTP URLs.
Chromium 153.0.8010.12 loads metadata for all 18 combinations. Windows WebKit
26.6 loads all six HTTP sources but rejects all 12 data/blob sources with
`MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4), even without application code, CSP, or
the card sandbox. Observations: `runtime/235-wav-probe/native-media-observations.json`.
Changing the bytes' format or duration does not resolve this native memory-URL
limitation on this host. This evidence does not establish iOS playback.

The official-package browser coverage now separates import/render/review from
native replay. Both engines still import the real exported package, render all
four reversed-card questions, retain both audio elements, and record four
reviews. Chromium additionally checks media metadata and actual replay through
the visible action. The replay-only WebKit test probes a valid WAV through both
native memory URL types before any app playback. It skips only when both emit
code 4; timeouts and other failures are not accepted as unsupported capability.
The capability result is retained as a test annotation. This skip is explicitly
not playback evidence. No product media handling was changed.

Focused verification: **3 passed, 1 explicit native-media skip in 25.2 seconds**,
`npx playwright test tests/e2e/anki-release-compatibility.spec.ts
--output=runtime/235-official-package-portable`, with the generated package
enabled on ports 4182/4183. Log: `official-package-portable.log`. A fresh whole
gate and final-head independent review remain next; latest results are on #235.

## Completion action follow-up

The independent review of `071534c` reports zero standards findings and one spec
finding: completion's Undo and Back actions have different dimensions. Retained
actual-width-390 WebKit evidence measures Undo at 122.38 × 44px and Back at
112.93 × 54px. Source inspection confirms independently sized grid children and
different shared coarse-pointer minima.

The whole gate on that head was intentionally interrupted after this finding;
it is not a passing or completed gate. Type/lint/build, 687 unit tests (3 skips),
22 tracker tests and 45 server tests had passed. Its partial browser log/artifacts
are preserved in `runtime/235-interrupted-071534c`. The audit test interrupted by
process termination is not attributed to application behaviour.

A new visible completion journey finishes both sample reviews, then compares
Undo/Back geometry and viewport reachability at measured widths 320 and 390.
Before the fix it fails in both engines on the 10px height difference
(`completion-actions-red.log`, `runtime/235-completion-actions-red`). Completion
buttons now share a 240px maximum width and 54px minimum height. Focused completion,
workspace/dialog action, fixed-review geometry, picker, deck-spacing and safe-area
checks pass in both engines: **18 passed, 53.5 seconds**
(`completion-actions-green.log`, `runtime/235-completion-actions-green`). The 320px
WebKit viewport screenshot was inspected: both actions share dimensions and stay
above navigation. A new whole gate and review of this follow-up remain required.

## Audit scrolling correction

The complete `2e5de34` gate finished with **145 browser passes, 12 skips and one
failure** in 13.0 minutes. Type/lint/build, 687 unit tests (3 skips), 22 tracker
tests and 45 server tests passed. The WebKit all-page audit clicked Add note but
did not open its dialog. Full artifacts are preserved in
`runtime/235-full-check-2e5de34-failed`. This is not a green gate.

Its capture helper calls `scrollTo(0, position)` while the app stylesheet uses
smooth scrolling. Two deterministic position checks expose that helper defect:
the first requested capture is **330px** short (`audit-scroll-restoration-red.log`);
changing only capture traversal to instant scrolling leaves restoration **679px**
short (`audit-scroll-restore-only-red.log`). The original trace records unstable
element retries before the unsuccessful click. This supports a scrolling race
in the audit; no product dialog or scrolling behaviour was changed.

Capture traversal and restoration now request instant scrolling and retain
one-pixel position assertions before screenshots and subsequent interactions.
The restored position also waits two animation frames. Repeated complete audits
pass twice in each engine: **4 passed in 2.4 minutes**, including all 32 page/dialog
captures per run. Commands: `npx playwright test tests/e2e/mobile-design-audit.spec.ts
-g 'audit every route' --repeat-each=2 --output=runtime/235-audit-scroll-green` on
isolated ports 4182/4183. Log: `audit-scroll-green.log`. Both WebKit repeats now
open Add note and complete review, custom study and account-dialog captures.
These focused results require a fresh whole gate and review of the committed
helper correction before acceptance or merge.
