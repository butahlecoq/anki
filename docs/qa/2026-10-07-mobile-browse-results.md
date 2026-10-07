# Mobile Browse results without horizontal scrolling

Issue #247 isolates the Browse-table screenshot added to #93. Its result region
had a 900px minimum-width table; document-overflow assertions missed the nested
horizontal scroll. At an actual 320px WebKit viewport the region's client width
was 282px and its scroll width was 900px. The new public regression failed at
that exact assertion before the product change.

On screens up to 680px, the existing table presents vertically stacked rows with
labelled metadata and wrapped sort controls. Every column remains available.
Explicit table/rowgroup/row/cell roles preserve table semantics when display
styles change. Mobile selection checkboxes have 44px targets. Desktop table
layout and storage/selection/editing handlers are unchanged.

## Verification

Environment: Windows, Node 22.18.0, npm 11.16.0, Playwright 1.63.0. Production
build and actual PC service, synthetic Japanese sample, no private collection.
Windows WebKit host display scaling is measured independently before configuring
actual 320/390px canvases; touch and iPhone user agent remain enabled.

Commands from the issue worktree:

```powershell
$env:KIROKU_WEB_PORT='4220'
$env:KIROKU_SYNC_PORT='4221'
$env:KIROKU_RUNTIME_DIRECTORY=Join-Path $env:TEMP 'anki-247-green-final-4221'
npx playwright test tests/e2e/mobile-browse-results.spec.ts --workers=1 --output=runtime/247-green-final --reporter=list
npx vitest run src/CollectionBrowser.test.tsx
npx eslint src/CollectionBrowser.tsx tests/e2e/mobile-browse-results.spec.ts
git diff --check
```

- Original regression: WebKit fails, 900px content against a 282px result region.
- Final focused browser journey: 2 passed in 36.2s, Chromium and WebKit. Both
  card/note views at measured 320/390px, long Japanese expression, long Deck name,
  saved long tags, every cell's bounds, nested/document overflow, sort state,
  stable selection, bulk tags/move, keyboard selection and note editing.
- Browse unit suite: 5 passed. Focused ESLint and diff checks pass.
- Intermediate expanded browser run: 2 failed on test setup trying to click
  disabled Clear selection in a Notes view with zero selection. Its overflow
  checks already passed; the setup was corrected before the final passing run.
- Independent source review: no blocking Standards or Spec finding. Follow-up
  assertions cover its optional long-tag, long-deck and sorting suggestions.
- Full repository gate will be recorded on the PR at its exact commit; focused
  verification above does not claim the complete gate has finished.
- The first whole gate exposed Windows EBUSY while removing the generated Anki
  fixture in both current-session account projects after the UI journey. Added
  bounded filesystem retries to fixture cleanup; application/storage code is
  unchanged. Final account and whole-gate verification must include this correction.

Before artifacts: `runtime/247-red`. Final generated-fixture screenshots:
`runtime/247-green-final/*/browse-cards-320.png`, `browse-cards-390.png`,
`browse-notes-320.png`, `browse-notes-390.png`. WebKit card320 and note390
captures were visually inspected. Artifacts remain local and ignored.

This verifies browser layout and interaction, not installed physical Safari.
Deployment is separate from source integration.

## Integration verification on current main

The completed PR handoff was integrated onto main `80c485c` after the hostname
fix. Historical before/after evidence and the original tracker state were saved
in the primary checkout at `runtime/247-pre-integration-652de65` before rebasing.
The browser regression now reuses the shared `phoneCanvasTest` introduced by
#238. It asserts both actual width and height (320/390 by 844), waits for the
requested search value and editor closure, attaches JSON geometry, and takes
viewport captures to avoid Windows WebKit's known full-page capture cropping.

Fresh focused verification, isolated ports 4222/4223, one worker, zero retries:
`npx playwright test tests/e2e/mobile-browse-results.spec.ts --workers=1 --retries=0 --output=runtime/247-integration-focused`
passed both projects in 34.9s. `npx vitest run src/CollectionBrowser.test.tsx`
passed all five tests; focused ESLint and `git diff --check` passed. New WebKit
card320 and note390 captures were visually inspected; metadata and long deck/tag
content wrap inside the result region. Geometry is attached to the HTML report.
Logs: `mobile-browse-integration-focused.log`, `mobile-browse-integration-unit.log`.

Complete gate and fresh independent whole-branch reviews will be recorded on
#247 and PR #248 at the final committed head; this focused checkpoint does not
claim those steps have finished or that the owner deployment was changed.
