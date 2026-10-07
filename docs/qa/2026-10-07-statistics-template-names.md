# Readable studied-card template names — #246

The owner authorizes autonomous mobile UI improvements and accepts iPhone-sized
Playwright/WebKit layout evidence. This bounded change resolves a studied card's
template name from its note type, retaining the same card ID for selection.
Unavailable metadata uses `Card`. Statistics reads note types in its existing
live snapshot so template renaming updates the link without a reload.

## Unit regression and checks

The original Statistics baseline passes three tests. The changed expectation
for the built-in Basic template and two new cases then fail on the original raw
template ID presentation: three failures in `statistics-template-unit-red.log`.
The implementation passes all five in `statistics-template-unit-green.log`.

The new tests use public collection writes and rendered Statistics, covering:

- Two templates with separate card IDs and distinct Good/Easy review histories.
- Selecting each named link opens that card's history, not the other template's.
- Renaming a template updates the link through the live snapshot.
- A deliberate missing-type fixture through the existing IndexedDB corruption
  helper shows a readable fallback while preserving the card's history.

The missing metadata case is an explicit unit recovery fixture, not a hidden
setup in the public browser journey. No application API is mocked.

`statistics-template-push-check.log` records the complete non-browser gate:
typecheck and lint pass; 695 unit tests pass, 3 skip; 22 tracker tests and 45
server tests pass. These are development checks before the final commit and
do not establish a passing whole software gate.

## Public browser evidence pending

`tests/e2e/statistics-template-names.spec.ts` imports a generated, non-sensitive
Anki package with one Japanese note and two named templates. It studies both
through visible review controls, saves different ratings, checks both template
links and their separate histories, and opens them by keyboard. Long Japanese
text and long template names exercise wrapping at measured 320/390 widths in
both themes, with target size and document overflow checks and viewport images.

The original Statistics component from base
`94bf378cb02532f312b12a190c9325957c1aee67` was compiled into
`runtime/246-before-build` by `runtime/246-build-before.mjs`. Working bytes were
restored in a finally block. This preserves the original label presentation
for deliberate before screenshots without changing the final source.

At the initial checkpoint, browser execution was queued behind another session's
#247 suite on the shared Windows host. No physical iOS result or owner deployment
is claimed.

## Before/after public regression

After that suite and its diagnostic recheck finished, the original-layout run
failed in both engines because the Recognition link was absent. The complete
study journey and 320/390 layout checks ran first, so the four original viewport
captures per engine are preserved in `runtime/246-browser-red/test-results`.
The inspected WebKit390dark capture shows raw `ANKI-TEMPLATE` identities.

The fixed-layout run passes both engines: **2 passed, 30.7 seconds**, log
`statistics-template-browser-green.log`; artifacts `runtime/246-browser-green`.
The inspected WebKit320light after capture shows named templates wrapped within
the viewport. Both individual card histories retain their distinct ratings.

Another session restarted the #247 whole suite during this short green run.
These passing assertions establish focused functional evidence, but do not
establish serial full-gate validation. A subsequent final-head complete check
must run with the Windows browser slot exclusively available. Independent review
and acceptance completion remain pending. Explicit geometry attachments were
added for the next run; their execution is not claimed from the earlier green.

## Integration after compact mobile headers

Rebased onto merged main `f22588493a171d01aa9902b37a15abe64f2a46dd`.
The browser regression now reuses the shared phone-canvas calibration rather
than adding another Windows WebKit probe. It asserts actual height844 as well
as actual widths320/390. Public native-package import, two visibly rated cards,
long Japanese/template labels, both themes and each card's distinct history
remain covered; no application API is mocked or database state injected.

Serial focused browser command:
`npx playwright test tests/e2e/statistics-template-names.spec.ts --workers=1 --output=runtime/246-integrated-focused`
passed2/2 in32.3s. Ports4226/4227 were checked unused before launch; isolated
service directory `runtime/246-integrated-service`. Explicit geometry
attachments executed in both engines. Fresh320light screenshots were inspected:
readable Recognition/Recall names wrap within the canvas and retained targets
meet44px; the two links open their correct separate Good/Easy histories.
Log: `statistics-template-integrated-focused.log`.

`npx vitest run src/Statistics.test.tsx` passed5/5 in4.10s, including rendered
public collection queries, metadata rename and readable fallback checks.
Log: `statistics-template-integrated-unit.log`.
These focused results do not replace the next complete gate or independent
whole-branch Standards/Spec review; all four criteria remain unchecked until
those final checks finish. No owner deployment or physical-iOS result is claimed.
