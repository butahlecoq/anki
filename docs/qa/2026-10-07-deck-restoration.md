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
