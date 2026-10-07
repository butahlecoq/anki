# Deleted deck restoration — #236

The owner approved the written causal restoration design. Schema 22 retains
actual deletion provenance and creation-time entity/owner lifetimes. Import
Plan commit explicitly authorizes restoration with stable identities; stale
ordinary work cannot restore or change the new lifetime. Transport remains 2.

## Public evidence

- `src/anki-import.test.ts`: nested package import, deletion, reopen, original
  identities/media restoration, repeated import and stale-plan atomic refusal.
- `src/restoration-sync.test.ts`: real paired HTTP collections cover three-device
  stale work, current edits/reviews, a second restore cycle, concurrent retained
  field conflicts, backup/generation fencing, and receiver rollback.
- `server/restoration-safety.test.ts`: schema 21 cannot read or acknowledge
  restored history; verified backup preserves metadata; malformed/cyclic
  provenance or missing owner references refuses the entire batch.
- A later-dated prior-lifetime reschedule command reproduced schedule corruption
  after a current review. Replay now filters retained commands by current lifetime.
  `restoration-schedule-lifetime-red.log` records failure;
  `restoration-schedule-lifetime-green.log` records 21 passing focused tests.

Latest unit suite: **712 passed, 3 skipped** (`restoration-schedule-full-unit.log`).
Latest service suite: **62 passed** (`restoration-task5-server-complete.log`).
These are development checks, not a completed final-commit full gate.

## Visible browser journey

`tests/e2e/deck-restoration.spec.ts` generates a non-sensitive nested package
with Japanese fields, image and WAV. Visible controls import, pair, sync, delete,
reload, show explicit restoration counts, restore, sync a clean second device,
study, record a review, export, re-import and export again. It collects page errors
and compares supported native identities, fields, templates, scheduling, review
history and media hashes from the downloaded packages.

Comparison excludes export timestamps and ankipack's generated default deck-option
protobuf bytes; deck identity and hierarchy names remain exact. An unscheduled
native new card stores queue position rather than a calendar instant, so its
synthetic immediate-readiness timestamp is normalized. Scheduled-card dates remain
exact. Attachment metadata order is normalized while every attachment value,
side, template and playback setting remains compared.

`restoration-task6-browser-inventory-green.log`: **2 passed, 1.4 minutes**,
Chromium and Windows iPhone-sized WebKit at measured 390px. Earlier geometry
run asserts no horizontal page overflow and dialog bounds within the viewport.
Viewport images replace Windows WebKit full-page captures with incorrect crops.

The browser mutation disables note restoration authorization without changing
the visible plan. `restoration-task6-browser-mutation-red.log` fails because the
plan remains open after Import package. Original source bytes were restored.
The next full gate must verify this final assertion and the later schedule fix.

Artifacts include `restore-import-plan.png`,
`restored-second-device-front.png` and `restore-plan-geometry` in Playwright
test-results. First functional artifacts are archived at
`runtime/236-browser-first-green`; they are not calibrated visual evidence.

## Owner provenance and platform limits

Read-only owner PC history audit (`runtime/236-owner-pc-provenance-audit.json`)
found 5,222 operations and no uploaded deletion operations. It cannot inspect
phone-local unsynchronized tombstones. No owner-local migration success or
unrecoverable-provenance refusal is claimed from this PC audit. Migration fixtures
preserve ambiguous barriers and report an actionable refusal; no timestamps,
identity renaming or collection reset supplies missing evidence.

Chromium validates WAV metadata decode. Windows WebKit confirms the retained
audio data source; this is not evidence of audible playback on physical iOS.
Physical-phone visual approval was waived by the owner.

## Pending integration

The final-commit full check, independent standards/spec review, acceptance update,
push/PR/premerge/merge and owner-service deployment remain pending. No intermediate
restoration implementation has replaced the owner service.


## Additional creation and movement coverage

The real HTTP fixture now covers adding a new note to a restored child, moving
that child, deleting its new root and restoring the exported collection. It also
covers generating a conditional card on an existing note, moving the note twice
before synchronization, deleting the destination and restoring the export, both
with and without a preceding restoration. Stable note/card identities and
receiver convergence are asserted.

`npx vitest run src/restoration-sync.test.ts` in
`restoration-card-move-green.log`: **10 passed**, 4.31 seconds. Before the receive
fix, `restoration-card-move-red.log` records both movement cases failing with
`Synced card deck does not match its note deck` on the receiving client. Notes
were materialized before the historical card creation in the same batch.
The receiver now retains that intermediate revision only when a causal card
successor in the same batch resolves its deck reference. Unrelated successors
still fail and roll back the entire transaction; the negative fixture checks
that the receiver snapshot remains unchanged.

The first SQL template-extension probe also encountered incompatible package
metadata; it was replaced by normal `updateNote` conditional-card generation.
No restoration ancestry-validation defect was established by that probe, and
that validator was not changed. These targeted results do not replace the
pending final whole software gate or independent review.


The first post-commit push hook caught a second ordering case and refused the
push. The retained queue's identifier order can put a note move ahead of its
restoration, leaving the card validated against the preceding note deck. The
fixture now pins descending UUIDs to reproduce this deterministically, rather
than relying on random operation identities. The receive order keeps structural
sorting and visits same-entity causal parents before descendants. The new
`restoration-card-move-descending-red.log` records the failure and
`restoration-card-move-descending-green.log` records **10 passed** in 4.10 seconds.
Temporary `[DEBUG-card-move]` instrumentation is removed. Final full verification
and independent review remain pending.


## Ancestor lifetimes, stale moves and honest retained progress

The `74bb522` full check passed its non-browser stages but hit the WebKit large
Browse journey's 30-second test budget. It was intentionally stopped after that
failure and discovery of a separate restoration-evidence defect. This is not a
passing full gate. Completed artifacts and its original log are retained in
`runtime/236-interrupted-check-74bb522`.

A minimized real HTTP regression in `server/restoration-safety.test.ts` shows
an old media record incorrectly accepted with a deletion from a later lifetime
of its note: `restoration-ancestor-http-red.log` reports HTTP 200 instead of the
required atomic HTTP 400. The valid new-media counterpart passes. Evidence
validation now follows each historical related reference's own lifetime and
checks it against the actual source deletion's lifetime. Server evidence loading
also decodes retained related-lifetime and restoration metadata. The entire
safety file passes: 16 tests in `restoration-ancestor-http-green.log`.

A second real three-device regression uploads an offline note move after deck
deletion but before re-import. `restoration-stale-move-provenance-red.log` rejects
the valid import as unrelated because the latest retained head points elsewhere.
The original deletion barrier is explicitly checked in the fixture. Historical
membership in the deleted lifetime is now retained as evidence; a stale move
cannot erase it. Each ancestor lifetime remains exact, so the wrong-note-lifetime
HTTP refusal still passes. All 11 restoration tests passed at this stage in
`restoration-stale-move-provenance-green.log`.

The withheld-parent HTTP fixture then exposed a reporting defect:
`restoration-pending-progress-red.log` reports complete while one restored note
is durably queued. Sync progress/results now include retained incoming counts.
Completion requires those counts to reach zero. End-of-history waiting directs
the learner to sync the sending device, while more server pages give normal
continue guidance. Reopening preserves the queued change and cursor; retry after
the missing parent restoration converges. Initial UI status reads the retained
count after reopening. Message rules remain in `sync-messages.ts`.
`restoration-pending-progress-green.log`: 61 tests pass across the real HTTP,
sync-client and message files. Ordinary initial dependencies remain #233.

The failed Browse trace shows 24.6 seconds waiting for its 72-note import dialog
to close. Enqueueing now reuses the already-read own history when deriving its
lifetime, avoiding one IndexedDB read per write. The subsequent focused production
browser command runs the large Browse and complete restoration journeys in both
engines: `restoration-ancestor-browser-focus.log`, **4 passed in 1.7 minutes**;
WebKit Browse 28.4s and restoration 51.8s. To leave budget for the editing assertions
in the final suite, that heavy WebKit test now has 90 seconds and explicitly waits
for the import dialog to close within 45 seconds. Its assertions are unchanged.
The updated test budget awaits execution in the final full gate.

`restoration-ancestor-progress-check-push.log`: typecheck/lint pass, **719 unit
passes/3 skips, 22 tracker passes, 64 server passes** with both official fixtures.
The same complete prepush gate passes at `8a713c5` in
`restoration-ancestor-progress-push.log`. The final full gate, independent
whole-branch review and acceptance completion remain pending. Owner data and
deployment remain unchanged.


## Cancellation safety and browser context isolation

The full gate at `1005eb9` exited 1: 719 unit passes/3 skips, 22 tracker
passes, 64 server passes, 155 browser passes/12 skips/1 failure (16.8 minutes).
The failure was the WebKit completion-actions test waiting for the sample deck.
Both production restoration journeys passed. This is a failed full gate.
Artifacts are retained in `runtime/236-failed-full-1005eb9`.

Its trace records a completed sample-deck click but no attachment fetch, and its
failure screenshots include the earlier Keyboard export page. The keyboard
export/import test omitted closing its explicitly created second browser context.
A new retained-context assertion reproduces that leak in Chromium:
`restoration-context-leak-red.log`. The context now closes in `finally`, and the
assertion protects isolation. The keyboard export/import and completion-actions
tests pass in both engines: **4 passed in 31.8 seconds**,
`restoration-context-leak-green.log`. This is focused evidence; a new full gate
and independent review are still required.

The separate production-browser cancellation command
`node runtime/236-cancelled-restoration-journey.mjs` passes in both engines.
At measured 390 × 844, it creates unrelated local work, imports/deletes a nested
generated package, previews restoration of 2 decks/1 note/1 card, cancels, and
reloads. Visible inventory and pending-change counts remain identical; a second
preview still requests the same restoration, and the unrelated front/back fields
remain studyable. No application API or database is mocked. Screenshots and
browser versions/configured/measured viewports are recorded in
`runtime/236-cancelled-restoration/evidence.json`; command output is
`restoration-cancelled-browser.log`. This command does not claim physical iOS
behavior or owner deployment.


## Whole-branch review corrections

The full `npm run check` at `7f7797d2b4845f39a099030ea0feb720cca23ce0`
exited 0: 719 unit passes/3 skips, 22 tracker passes, 64 server passes and
156 browser passes/12 skips in 16.2 minutes. Node22.18.0/npm11.16.0/
Playwright1.63.0; both official fixtures enabled, isolated4196/4197, one worker,
no retries or concurrent suites. `test-results/.last-run.json` reports passed;
the manifest identifies `7f7797d2b484`. Log: `restoration-full-check-7f7797d.log`.

Independent whole-branch Matt reviews against `94bf378` found:

- Standards: one documented module-ownership breach and two heuristic findings.
  Causal ordering/successor rules belonged outside the persistent adapter;
  preview/commit repeated the import-identity projection; lifetime context carried
  an unused causes field.
- Spec: two receive-boundary defects. Deduplication could hide changed envelopes,
  and retained replay checks omitted entityType/entityId/reviewId. Deferred card
  processing also counted each retry as progress, even when its successor was
  still causally unavailable. No additional scope or evidence gap was reported.

Five public Collection identity regressions fail before correction in
`restoration-receive-envelope-red.log`. They cover same-batch conflicting content,
received replay changing only entityType/entityId/reviewId, and pending replay
changing identity. Complete metadata is checked before deduplication; envelope
comparison now includes these identity fields before the received shortcut.
The five regressions then pass in `restoration-receive-envelope-green.log`.
Legacy omitted parents still support previously inferred retained history, while
conflicting wire parents cannot disappear through deduplication.

The public deferred-card tracer records `receive made no bounded durable progress`
after two seconds in `restoration-deferred-card-progress-red.log`. Its matching
same-lifetime successor references a not-yet-received note lifetime. Progress now
requires newly retained history or completed classification/materialization.
The tracer passes in 74ms, retains both pending operations and cursor through
reopening, and keeps existing export inventory unchanged:
`restoration-deferred-card-progress-green.log`.

Pure causal rules now live in `src/sync-operation-rules.ts`; the persistent adapter
owns transactions and queue replay. Import preview/commit use `importedEntityRefs`
from their shared contract; each commit still independently checks barriers and
authorization. The unused context field is removed. Three pure rule tests cover
ordering, successor ancestry/identity/lifetime, and inferred-versus-wire parents.
The expanded focused run passes 9 tests in `restoration-review-rules-green.log`.
The broader Collection/import/HTTP-sync/client/revision run passes 177 tests,
1 skip (`restoration-review-focused-green.log`). These corrections require a
new committed-head complete gate and independent reviews before acceptance/merge.
