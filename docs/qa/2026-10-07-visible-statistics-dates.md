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
