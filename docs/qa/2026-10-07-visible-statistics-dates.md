# Visible Statistics dates — #240

The owner authorizes autonomous mobile design improvements and accepts iPhone
sized Playwright/WebKit layout checks. Each date button now contains a short
month and day number. A panel-coloured backing keeps the text separate from the
activity-coloured border. Full date/answer accessible names, pressed state and
daily selection are retained.

## Verified regression

`tests/e2e/statistics-date-labels.spec.ts` uses the visible Statistics page with
a fixed local date of 2026-10-07. It checks zero-answer September 30 and October
1 before selection, in both appearances at measured widths 320 and 390, then
checks the selected date, daily period and pressed state.

The original component fails because the September label is absent. Chromium
reproduced that failure in `date-labels-red.log`; WebKit reproduced it on the
allowed port in `date-labels-webkit-red-allowed-port.log`. After restoring the
implementation, both projects passed: **2 passed, 20.3 seconds**.

```powershell
$env:KIROKU_WEB_PORT = '4188'
$env:KIROKU_SYNC_PORT = '4189'
npx playwright test tests/e2e/statistics-date-labels.spec.ts
```

Earlier WebKit attempts on port 4190 never reached the app. The trace reports
`Not allowed to use restricted network port 4190` and contains no requests.
Those attempts provide no product failure evidence.

## Screenshots and remaining evidence

Green artifacts are preserved in `runtime/240-date-labels-green-allowed-port`.
The Chromium 320px light screenshot was inspected and shows legible month/day
labels through the September/October transition. Windows WebKit's locator
screenshots include an incorrect crop/offset and surrounding page content; they
are not accepted as complete visual evidence. Its DOM visibility and selection
assertions passed with measured viewport calibration, which does not establish
physical iOS behaviour.

This is a draft checkpoint. Integrate the minimum-width/date-scroll region from
#239 before asserting 44 × 44 targets or absence of page overflow. Add checks for
nonzero activity, both-theme text contrast, and reliable before/after screenshots.
The full gate, independent review and acceptance evidence remain outstanding.

## Populated activity and reliable viewport captures

The regression now records one answer through the visible sample-deck review
journey before opening Statistics. It checks October 7's nonzero activity colour
against an empty date and measures date-text contrast of at least 4.5:1 in both
themes at measured widths 320 and 390. Native deck filtering and daily selection
remain covered. Ordinary viewport screenshots replace the incorrect WebKit
locator crops. The new WebKit 320px light October 1 and dark active-date captures
were inspected and show legible dates with navigation visible.

The strengthened width assertion exposed a separate populated Statistics filter
overflow: Chromium reported an inner width of 331px at a requested 320px width.
The deck select's intrinsic grid column was 313px inside a 284px label. The
dedicated red run is `populated-statistics-width-red.log` with artifacts in
`runtime/240-populated-width-red`. Constraining the label's grid track and giving
native inputs/selects a shrinkable full width resolves it. This shared control
fix belongs to #235's page-overflow criterion and is also being verified there;
the identical changes will be reconciled when this branch integrates that fix.

The populated-date run passes in both engines: **2 passed, 32.0 seconds**.
Log: `populated-date-labels-green.log`; artifacts:
`runtime/240-populated-dates-green`. It verifies actual viewport width, no page
overflow, filtering, active/empty dates, contrast and selection. The earlier
pending activity/contrast and reliable after-capture checks are now evidenced.
Minimum 44px date widths still depend on #239; complete before/after evidence,
the final full gate and independent review remain required before acceptance.

## Integration after #239 merge

Rebased onto e272c96d5e59915e9d9d51fe15e516e1f7c0dbbd. The Statistics merge preserves the local Study dates scroller and mobile grid minimum of 44px, and adds the visible month/day time element inside every date. Shared filter shrink constraints are already on main from #235.

The date-label regression now measures all 84 target widths/heights (43.99px subpixel tolerance) and verifies the local horizontal scroller at actual 320/390 widths. Screenshot positioning is instant, matching the earlier audit helper correction. Build passed. Combined populated-label/heatmap tests pass in both engines: 4 passed, 1.0 minute, visible-dates-rebased-focus.log; artifacts runtime/240-integrated-focus. These cover both-theme contrast, pre-selection labels, daily/deck filters, active/empty dates, native touch/full keyboard traversal from #239 and absence of page overflow. Full final-head gate and independent reviews remain pending.


## Complete before-image comparison and full-check result

The separate baseline build uses `src/Statistics.tsx` and `src/styles.css`
from merged base `e272c96d5e59915e9d9d51fe15e516e1f7c0dbbd`; original
working bytes were restored before browser execution. The capture script
`runtime/240-capture-before.mjs` follows the visible sample-deck study flow,
records one answer, opens Statistics and uses the public appearance selector.
It captures September30, October1 and October7 at actual320/390 widths,
in both themes and engines:24 viewport images. The assertion that all
heatmap `time` elements are absent confirms the before state.

Baseline artifacts: `runtime/240-before-captures/evidence.json` and
`{chromium,webkit}-{320,390}-{light,dark}-2026-{09-30,10-01,10-07}.png`.
The WebKit320lightOctober1 and Chromium390darkOctober7 images were inspected:
individual dates are blank before selection, including the active day.
Corresponding final-code viewport captures and measured contrast/target-size
checks are in `runtime/240-integrated-focus/test-results` and cover both
engines, themes, widths and zero/nonzero activity.

Full check on `39e0c028` failed:153 browser tests passed,12 skipped, and one
WebKit offline-media test stayed on deck detail after Study now. It passed
three uninstrumented and twelve instrumented isolated reruns. The native
mouse probe also hit its intended controls. No product fix or passing full
check is claimed from those diagnostic reruns. Failed artifacts remain in
`runtime/240-full-failed-39e0c02`; diagnostic artifacts remain in
`runtime/240-offline-click-diagnostic`. The full gate must be rerun at the
final commit, with any remaining failure diagnosed before merging.
