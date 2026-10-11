# Mobile readiness controls implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify the three original #285 Windows WebKit journeys through supported observation and pointer-readiness controls.

**Architecture:** Keep product behavior and original journeys intact. Batch redundant rendered-geometry reads and add a small public-locator helper that observes real hit testing before the same normal click. Prove observation equivalence and negative cases independently before adopting either control.

**Tech Stack:** TypeScript, Playwright 1.63, native Windows WebKit and Chromium, pinned Node/npm toolchain.

**Spec:** [Issue #285](https://github.com/butahlecoq/anki/issues/285), interpreted against [retained trace research](../../research/285-native-mobile-deterministic-controls.md).

## Global constraints

- Preserve every original mobile/statistics/theme/date/contrast/touch/keyboard/route assertion and unchanged deadlines/retries.
- Keep original enclosing deadlines: populated Statistics 30 seconds, complete route audit 120 seconds, date labels 60 seconds.
- No private collections, application mocks, forced or synthetic activation, broad filtering, omitted observations or accepted wrong destinations.
- Preserve unknown diagnostic files and all original failure artifacts; physical installed-iPhone observations remain separate.
- Rebase onto qualified current main after #327 merges, preserving unknown files; never merge using obsolete full-gate evidence.

## Review focus

- Hidden or zero-size dates must fail measurement rather than disappearing from the returned records.
- Missing or duplicated dates must fail even if the remaining controls meet touch dimensions.
- A fixed navigation element covering the intended click center must fail readiness, never permit a forced click.
- The asynchronously rendered custom-session button must be resolved afresh before pointer observation.
- Audit scroll restoration and every segment screenshot must survive batching.

## Task 1: Prove batched geometry observations

**Files:** Create `tests/e2e/mobile-readiness.ts` and `tests/e2e/mobile-readiness-controls.spec.ts`; modify only the measurement loop in `tests/e2e/statistics-date-labels.spec.ts`.

**Interfaces:** `readDateGeometry(dates: Locator)` returns every matched element's label, ISO date, computed visibility and width/height; it never filters records. A validation function checks the full 84 consecutive unique dates and every original width/height threshold.

- [ ] Archive exact original source and result trees before editing. Save an assertion/capture inventory.
- [ ] Write isolated real-DOM controls comparing original `boundingBox()` with batched records for all 84 dates at 320/390 actual widths. Include hidden, zero-size, 43px, missing-date and duplicated-date cases. Run them before implementing the helper; retain their failures.
- [ ] Implement one `evaluateAll` observation and visibility rejection equivalent to the original visible bounding boxes. Assert 84 records and unique expected dates; retain separate width/height assertions for each record.
- [ ] Run the control on both engines, one worker, zero retries. Require equivalence for every valid cell and rejection of every invalid case.
- [ ] Replace only the original per-button measurement round trips; keep all subsequent date/theme/scroll/touch/contrast assertions and captures.

## Task 2: Prove ordinary click readiness and audit observation preservation

**Files:** Modify `mobile-readiness.ts`, its control spec, and `tests/e2e/mobile-design-audit.spec.ts`.

**Interfaces:** `clickReachable(control: Locator)` waits for visibility, centers the original locator using instant DOM scrolling, polls positive geometry and `document.elementFromPoint` containment, then performs that locator's original unforced `click()`. It uses configured assertion timing within the unchanged enclosing deadline.

- [ ] Write a real-DOM control with a covering fixed navigation element. Require the observation to reject coverage, and a normal click after coverage is removed to reach only the intended control.
- [ ] Implement the helper; record bounds and hit target. Exercise native Chromium/WebKit controls without app mocks or dispatching events.
- [ ] Apply it only at the retained Statistics Open Sample/Study now and audit custom-review boundaries. Assert the expected deck/reviewer destination immediately after the original clicks.
- [ ] Batch duplicate audit root/scroll-width reads and segment setup reads; return settled scrollY from the same existing two-frame scroll operation. Preserve original tolerances, restoration, every screenshot name, frame/font readiness and screenshot deadline.
- [ ] Compare the original assertion/capture inventory with the modified source; retain all 49 original route/segment captures.

## Task 3: Qualify the whole change

**Files:** Original three journeys and private verification artifacts; tracker #285 and its eventual PR.

- [ ] Run ten repeats of each entire original supported native case, one worker, zero retries, unchanged deadlines, isolated fresh ports/runtime. Preserve command/head, terminal result, all captures and native lifecycle evidence.
- [ ] Inspect traces for the two batched 84-element observations and all 336 dimension assertions. Record historical missing-date-tail attribution limits explicitly.
- [ ] Run literal `npm run check` and the hosted complete gate on the final fixed source. Any failure needs its first artifacts retained and concrete diagnosis before changing source.
- [ ] Request fresh parallel Matt Pocock Standards/Spec reviews after the full local gate passes. Resolve findings and requalify changed source.
- [ ] Record named acceptance evidence, archive/hash-verify all source and failure proofs, run `npm run premerge` immediately before protected merge, and remove only the confirmed disposable issue worktree/branch in that same action.

No task is marked completed by this plan. Current unchanged-body passes bound recurrence; they do not prove these proposed controls.
