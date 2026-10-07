# Browse journey save completion — #251

## Observed failure

The complete gate for #232 at `50823d9cc879a2461e7cb490bebd595a2586290e`
(base `fad25e660c34022e1e3ad1a5ec83669dfd0c9ed7`) failed the Chromium
`bulk move and suspension preserve identities and empty reports open affected notes`
journey. Browse production code and this test were unchanged between that base
and head. The expected empty-card report had zero rows; the visible search still
contained `空` after the test attempted to clear it.

The trace records Save fields ending at 40915.347 ms, search fill starting at
40917.743 ms, and the save dialog still present in the 40920.281 ms snapshot.
The 40926.355 ms snapshot retains `空` in the background search input. The test
interacted with background controls before the asynchronous dialog save finished.
This evidence demonstrates test synchronization failure, not collection loss.

The original trace and error context are copied into ignored
`runtime/251-red-from232/`. The original complete-gate log is retained there too.
That gate also had an unrelated WebKit account relay 502; #251 does not claim to
fix that error.

## Correction and focused evidence

The journey now awaits the edit dialog closing after Save fields. The search
helper asserts its requested visible input value before clicking Search. All
existing stable-identity, bulk-action, one-row empty report, editor-content and
overflow assertions remain.

Command: `npx playwright test tests/e2e/browser.spec.ts --grep 'bulk move and suspension'
--repeat-each=5 --output=runtime/251-focused-results`.

Result: 10 passed, zero failures, zero skips, 1.7 minutes: five Chromium and five
WebKit runs, one worker, zero retries. Ports 4196/4197 and synthetic local
collections were used. Log: `browser-save-focused.log`.

The original failure is timing-dependent; it is retained as observed evidence,
not described as a deterministic deliberately delayed reproduction. No fixed
sleeps, hidden collection writes or application behavior changes were added.

The complete gate and independent Standards/Spec reviews remain pending at this
checkpoint. Final exact-commit results belong in the issue and PR evidence.
