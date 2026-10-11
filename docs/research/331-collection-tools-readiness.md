# Collection utility readiness

[Issue #331](https://github.com/butahlecoq/anki/issues/331) preserves hosted run 38093374326 at `94a59e1b736c2e3dc8bf6b11925d3703ab68e7ab`: the native keyboard export/import journey reached its original 90000ms deadline while `locator.press('Enter')` waited for Export Anki package after ending review and opening Collection tools. Retry 1 passed in 5.3s. The workflow did not upload the first trace. Its exact disclosure state and historical cause remain unknown.

The unchanged complete journey on current main `bbab1a58c3ab9c36419aac61e89227e6537059b4` passed three Linux native repetitions (23.3s). A Windows comparison with read-only main-document keyboard/focus/disclosure observers passed ten repetitions per engine, one worker, zero retries (20 cases, 2.3m). These runs bound recurrence; successful repetitions do not establish the missing historical cause. Windows comparison ran alongside another qualification browser worker, so host contention was not excluded. Observer source, logs and entire result/report trees are retained under `runtime/331-main-instrumented*`; instrumentation was removed before the correction.

## Supported operation contract

`openCollectionTools` previously returned immediately whenever the attached summary was hidden. That inferred an open desktop disclosure from summary visibility, without observing whether the utilities were actually open. The real-DOM control uses a closed details element with its summary hidden, calls the actual helper, and requires rejection of that unsupported state. Both engines instead returned success: two failures and four positive-control passes in 19.2s. Hidden summary with open desktop utilities and visible summary with closed mobile utilities are the positive controls.

The correction preserves the ordinary mobile summary click and verifies the disclosure's public `open` attribute on both layouts before returning. A closed hidden disclosure is rejected at the existing assertion deadline. It does not force activation, alter application state, extend deadlines, or claim to repair an underlying disclosure defect. It prevents the helper from claiming that closed utilities are ready. This is a deterministic public-operation control, not an attribution of the unavailable hosted timeout.

The original keyboard journey is byte-for-byte unchanged: keyboard activation, focus restoration, review completion, scheduling choice, package download, independent clean-client import, Japanese content, context cleanup and original 90000ms deadline remain. No application response or event is mocked. Only standalone real-DOM controls use `page.setContent`.

## Verification

Before: `npx playwright test tests/e2e/collection-tools-readiness.spec.ts --workers=1 --retries=0 --trace=on` reproduced the false helper completion on both engines. Source, first logs, traces, screenshots and videos remain in `runtime/331-disclosure-red*`.

After: `npx playwright test tests/e2e/collection-tools-readiness.spec.ts tests/e2e/dialog-keyboard.spec.ts --grep 'keyboard ends review|collection summary|desktop summary|mobile summary' --repeat-each=3 --workers=1 --retries=0 --trace=on` passed all 24 cases in 1.4m: three repetitions per engine of the entire original journey and each of the three controls. Logs and complete result trees are retained under `runtime/331-disclosure-green*`.

Final literal local/hosted gates and fresh independent Standards/Spec reviews must still be recorded before acceptance and merge. Physical phone behavior has not been observed by these synthetic tests.
