# Export dialog completion

[Issue #338](https://github.com/butahlecoq/anki/issues/338) preserves hosted run 38100642031 at `5dc5c0ca0f616d6c22d0142c098e3030fdd3fbb7`: the first native release journey failed after 28.9s, waiting for the Japanese Deck heading at `openJapanese` line175/caller251 after online warm-up export. The original assertion timeout is 5000ms, inside the unchanged 240000ms complete journey. Retry1 passed the entire journey in 53.5s. GitHub reports zero uploaded artifacts; the first screenshot/video/trace is unavailable. This boundary preceded offline service shutdown. Its historical cause remains unknown.

## Reproduced operation contract

The original export helper clicked Close export and immediately returned the downloaded bytes, without checking that the dialog disappeared. `closeExportDialog` initially reproduced that exact closing operation. A standalone real-DOM fixture retains the dialog after its ordinary close click and requires the actual operation to reject false completion; both engines instead resolved. The red invocation passed its two ordinary-removal positive controls and failed both retained-dialog controls in 18.7s. It does not mock an application response or event, and proves the operation's missing completion observation rather than the historical heading failure.

Ranked explanations are: unobserved export-close completion; native Deck activation during focus/scroll restoration; host contention. Only the first operation-contract gap has a reproduced control. The unchanged complete current-main journey is compared before changing its source; successful repetitions bound recurrence without excluding either other explanation. Another qualification browser worker was active on this host, so contention is not excluded.

## Supported control

The correction keeps the original ordinary Close export click and observes zero matching dialogs before returning. It does not force or retry activation, change product code, raise deadlines, or accept a missing destination. The original release journey retains its Japanese heading assertion and all review, scheduling, sync, package bytes/media equality, offline reopening, restored convergence and context/lifecycle checks. Only the export helper's closing operation gains a public completion postcondition.

The unchanged complete current-main journey passed six comparisons in 6.4m: three per engine, one worker, zero retries, original 240000ms journey and 5000ms heading deadlines. This bounds recurrence; no historical cause is attributed. Original source, head/command, first red fixture source and complete result/report trees remain in `runtime/338-original*`, `runtime/338-main*` and `runtime/338-export-completion-red*`.

Corrected controls and the entire retained journey passed 18 cases in 7.0m: three repetitions per engine of both controls and the original whole journey, one worker, zero retries. The retained-dialog control also requires exactly one delivered ordinary click, so rejection cannot pass through a missing Close export button. Complete result/report trees and logs remain in `runtime/338-export-completion-green*`.

Final whole local/hosted gates and fresh independent Standards/Spec reviews must still pass after qualification against current main. Neither the control nor successful repetitions prove the unavailable historical cause. Physical iPhone behavior remains unobserved.
