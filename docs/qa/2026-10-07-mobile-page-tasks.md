# Mobile page composition — #238

The owner authorized mobile layout improvements using Playwright/WebKit.
Collection utilities now live inside a native `Collection tools` disclosure on
small screens. Desktop keeps them open. Sync status and actionable messages
remain visible outside the disclosure; pairing/account dialogs remain mounted
outside it. Retained incoming dependency warnings remain visible above the disclosure. Browse search and the Custom Study Session form have shorter lead-in
content. The offline status uses a separate header row.

## Public regression

`tests/e2e/mobile-page-tasks.spec.ts` measures actual canvases 390 × 844 and
320 × 568, navigates to Browse and Study, and checks the first textbox ends above
mobile navigation while the page is at scroll position zero. Browse's complete
Search button must also stay above navigation with a 44px minimum target. It checks horizontal
page overflow separately. A second journey uses Enter to open the disclosure,
opens pairing/export/text dialogs, closes them with Escape, checks focus return
and 44px control dimensions, and closes the disclosure with Escape.

The original page fails the first-task test in Chromium at width 320: the task
bottom was 699px, below the navigation top at 502px. WebKit additionally exposes
horizontal overflow in Study. After compacting the header and section spacing,
Chromium's Study task bottom is approximately 496px, above the 502px navigation.
The utility keyboard journeys pass in both engines.

WebKit's remaining overflow probe at actual width 390 showed a 440px document
scroll width and 421px content inside a 354px form/label, despite every visible
element rectangle fitting. An explicit `minmax(0, 1fr)` label grid and overflow
constraints on the select did not change that measurement. Containing the native
select's paint overflow resolved it. That focused run was **4 passed in
17.6 seconds** (`page-tasks-green.log`, `runtime/238-select-containment`). Both
scheduling choices still update their explanatory text and preserve page width
at both phone sizes; the native option wording and values are unchanged.

Screenshot review then found the Search button partially behind navigation at
width 320. The new complete-action assertion failed in both engines before the
spacing change (`search-action-red.log`). Reducing the mobile search form's top
margin and gap and removing its primary-button top margin brought the whole
action above navigation. The expanded focused run passed **4 tests in 18.5
seconds** (`page-tasks-green.log`, `runtime/238-search-action-green`).

```powershell
$env:KIROKU_WEB_PORT = '4184'
$env:KIROKU_SYNC_PORT = '4185'
npx playwright test tests/e2e/mobile-page-tasks.spec.ts --output=runtime/238-page-tasks
```

Existing pairing, sync, export, text, and storage browser journeys open the
visible disclosure through `tests/e2e/collection-tools.ts`. This does not expose
hidden controls through application internals. Integration now includes #235,
#239, #240 and #236 (base `be834dc`). The final complete gate and independent
review remain pending; the focused results below do not replace them.

The Windows fixture measures host WebKit display scaling and asserts actual
`innerWidth`/`innerHeight`. It keeps Safari user agent and touch with desktop
viewport interpretation. This is layout evidence, without a physical iOS claim.

## Integration with merged mobile design changes

Rebased onto e272c96d5e59915e9d9d51fe15e516e1f7c0dbbd, preserving the review More actions menu and the Statistics date scroller. Typecheck and full lint pass. The first unit run exposed an ambiguous global Export query in the review-dialog shortcut test: both collection utilities and review actions legitimately provide export. Scoping that test to the opened review menu passes all 44 App tests (`mobile-pages-shortcut-scope-green.log`); no shortcut behavior was weakened. The complete gate at the resulting head remains required.

## Integration with explicit deck restoration

The public restoration journey now opens Collection tools before pairing, Sync
now and package export. A fresh receiver exposed a helper race: `isVisible()`
ran before the workspace mounted and returned false, leaving the pairing button
in a closed disclosure. The retained trace records that sequence in both engines.
The initial integration run failed both restoration cases and passed the other
eight cases in4.9m (`page-tasks-restoration-red.log`,
`runtime/238-restoration-focused`).

The helper now waits for the disclosure to be attached before deciding whether
the mobile trigger is visible. It uses the visible menu normally; no hidden
application or database setup is introduced. The unchanged complete integration
set then passed **10/10 in1.7m**, including restoration, keyboard dialogs and
mobile page tasks, in both Chromium and WebKit. WebKit restoration took58.1s.
Evidence: `page-tasks-restoration-green.log`,
`runtime/238-restoration-green`; command:

```powershell
npx playwright test tests/e2e/mobile-page-tasks.spec.ts tests/e2e/deck-restoration.spec.ts tests/e2e/dialog-keyboard.spec.ts --output=runtime/238-restoration-green
```

Ports4184/4185, one worker, no retries or concurrent browser suite; both official
Anki fixtures configured. Phone task geometry checks actual390x844 and320x568.
Both320-pixel Study screenshots were visually inspected; the session-name input
fits above navigation and offline-shell status remains readable. The rebased
keyboard export/import retains the explicit clean-context cleanup from #236.

## Offline-storage touch target

Before final review, acceptance inspection found that the offline-storage help
disclosure had no minimum touch size. A public measurement reproduced42px in
Chromium and43.2px in WebKit, below the44px requirement. Both engines failed
the exact target assertion (`page-tasks-storage-target-red.log`,
`runtime/238-storage-target-red`). The complete `db6b112` gate was deliberately
interrupted after44 Chromium browser passes to correct this gap; it is not
reported as a complete passing gate. Its artifacts are retained under
`runtime/238-interrupted-db6b112`.

Mobile offline-storage help now has a44px minimum and block padding, preserving
the native disclosure marker. The keyboard journey measures both actual390x844
and320x568, opens/closes storage help with Enter, verifies inventory is visible,
checks dialog focus return and closes Collection tools with Escape. Native-marker
focused verification passed **4/4 in24.4s**
(`page-tasks-storage-native-marker.log`, `runtime/238-storage-native-marker`).
The final gate also captures the expanded Collection tools at both widths.
Full final-head gate and independent reviews still remain before acceptance.

## Final integration diagnostics and calibrated canvas

The complete `b361553` run finished with728 unit passes/3 skips,22 tracker
passes,64 server passes, typecheck/lint/build passes, and157 browser passes,
12 declared skips and3 browser failures in18.6m. The failures were the safe-area
case in both engines and WebKit's export case. Full artifacts are retained under
`runtime/238-failed-full-b361553`; this is not a passing final gate.

A focused unchanged reproduction of the two cases confirmed3 failures/1 pass
in1.8m (`page-tasks-safearea-export-red.log`,
`runtime/238-safearea-export-red`). The safe-area test clicked Connect a PC
without opening the new visible menu. The WebKit trace recorded configured
390x664 but actual312x531 and a checkbox outside the viewport.

`tests/e2e/phone-canvas.ts` now shares the existing host-scale calibration
between mobile page tasks, export and review layout. Export retains its intended
390x664 size and verifies actual dimensions in both the exporting profile and
the clean receiving profile. The checkbox must be in the viewport; dialog
horizontal bounds and existing offline package/media re-import assertions stay
checked. The safe-area case opens Collection tools normally and checks actual
390x844 and390x400 canvases, including bounds against the real viewport. Safari
user agent and touch remain enabled; Windows WebKit uses desktop viewport
interpretation to avoid its known native visual-viewport scaling bug. This is
automated layout evidence, not a physical-iPhone result.

The complete focused export/review-layout/mobile-tasks set passed16/16 in1.1m
(`page-tasks-safearea-export-green.log`, `runtime/238-safearea-export-green`).
Windows WebKit full-page export images still appeared cropped despite passing
geometry, so export evidence now captures the visible viewport. Additional
explicit horizontal dialog assertions passed in both engines:2/2 in29.4s
(`page-tasks-export-viewport.log`, `runtime/238-export-viewport`). The resulting
WebKit export-options viewport screenshot was visually inspected and fits.

## Paired menu acceptance journey

`node runtime/238-paired-utilities-journey.mjs` passed4/4 on production UI build
`b361553cbf04` before the next final gate. It uses isolated real temporary PC
services and public sample-deck, pairing, sync and backup flows. In Chromium
and WebKit at actual390x844 and320x568 it checks all paired utility button
targets, keyboard Sync now, verified backup download and preview, account and
pairing Escape/focus return, Collection tools Escape, no page overflow and no
page errors. No AnkiWeb credentials or private collection data are used.
Evidence: `page-tasks-paired-utilities.log`,
`runtime/238-paired-utilities/evidence.json` and paired-menu screenshots.
The new final-head complete gate and independent reviews remain required.
