# Anki-style Scheduling Policies Implementation Plan

**Goal:** Complete everyday queue policies while retaining card identities, review history, reusable deck options, and sync safety.

**Spec:** GitHub issue #10, `https://github.com/butahlecoq/anki/issues/10`

## Decisions

- Additive v11 card fields distinguish `manualSuspended`, `templateSuspended`, and `buriedUntil`. Existing `suspended` data migrates to `templateSuspended` so content reconciliation cannot clear a manual or leech suspension.
- Queue eligibility is a pure calculation from those fields and the supplied time. Burial stores the next device-local study-boundary instant as an ISO timestamp, so it survives reload and sync without a midnight write.
- Reuse option groups for sibling-bury and leech policies. Defaults preserve current behavior: no sibling burying, threshold eight, and a normalized `leech` tag with suspension.
- Continue using the established device-local boundary rule; existing Moscow coverage proves a non-UTC day. Collection-wide timezone policy is deferred because it requires a new synced collection setting and is not part of the current schema.
- `answer()` writes the scheduled card, review log, sibling burial, and leech tag/action in one transaction and queues every changed record for sync.
- Manual suspend, resume, bury, unbury, and reschedule are explicit card APIs. Reschedule retains FSRS history and only updates an allowed due time/state.

## Tasks

### Task 1: Model, migration, queue policy, and sync

- [ ] Add v11 migration and validated reusable policy settings.
- [ ] Make queue eligibility and ordering handle manual/template suspension, burial, and interday learning.
- [ ] Add manual card actions, sibling burying, leech tag/action, and durable sync operations.
- [ ] Test all ratings, local boundaries, queue lifecycle, migration, reload, and two-client convergence.

### Task 2: Reviewer and options UI

- [ ] Add accessible policy controls to shared deck options and show their persisted values.
- [ ] Add reviewer card actions and a card-management route for resume, unbury, and reschedule.
- [ ] Refresh the active session safely after an action alters its queue.

### Task 3: Browser verification and review

- [ ] Exercise settings, sibling bury, leech handling, manual lifecycle, reschedule/reload, and sync in desktop and phone browser tests.
- [ ] Document policy semantics, run the full gate, obtain independent review, and publish a PR.
