# Deleted-deck restoration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-import a deliberately deleted package with its original identities, synchronize restoration, and prevent older device work from changing restored content.

**Architecture:** One shared causal lifetime module owns restoration eligibility. Collection keeps deletion provenance and uses that policy at the existing import, operation creation, and receive boundaries. The PC persists and validates the same metadata; the existing schema watermark protects older clients.

**Tech stack:** TypeScript, Dexie/IndexedDB, Node SQLite, Vitest, Playwright Chromium/WebKit, the existing Anki package importer and HTTP sync service.

**Spec:** [Approved design](../specs/2026-10-07-deleted-deck-restoration-design.md), published in [#236](https://github.com/butahlecoq/anki/issues/236#issuecomment-6031664783).

## Global constraints

- “Deleting a deck and importing the same Anki package again must work without changing its stable deck, note, or card identities.”
- “Ordinary stale operations from an offline device must never resurrect deleted content or overwrite the restored collection.”
- “The existing duplicate policy, supported scheduling/history import, media handling, and atomic import boundary remain in force.”
- “Committing that import is the deliberate restoration confirmation; no extra confirmation dialog is needed.”
- “Do not invent provenance from `occurredAt`, clear all tombstones, reset a collection, or rename stable IDs to bypass deletion guards.”
- Use schema **22**, after the current schema 21. Retain transport protocol **2**: its existing schema capability/watermark mechanism gates this extension before acknowledgment.
- Keep one worktree for #236. Do not deploy or merge an intermediate stage. Run `npm run check` before whole-branch review and `npm run premerge -- <PR>` before merge.
- Test at the already approved public Collection/import and real paired HTTP boundaries. Internal policy helpers are reached through those boundaries.

## Review focus

1. Cascading deletion without an entity's own delete revision: preserve the actual ancestor deletion identity; Task 1 covers it.
2. A stale child with a new ID under a restored parent: reject its old parent lifetime rather than relying on the child's tombstone; Task 4 covers it.
3. A missing restoration dependency across receive pages or restart: retain it durably before advancing a cursor; Task 3 covers it.
4. Simultaneous restoration with different imported field values: one same-barrier lifetime, retained field conflicts, no duplicate identities; Task 4 covers it.
5. Corrupt or incomplete legacy provenance and backup metadata: preserve data and report an actionable refusal without acknowledging unsafe restoration; Tasks 1 and 5 cover them.

## File boundaries and shared interfaces

Create `entity-lifetimes.ts`, a shared policy module with no database, clock, or browser dependency. It owns these types and functions:

```ts
type EntityRef = { entityType: SyncOperation['entityType']; entityId: string }
type EntityLifetime = readonly string[] // sorted unique deletion operation IDs; [] is initial
type DeletionCause = { source: EntityRef; opId: string; deletedLifetime: EntityLifetime }
type EntityLifetimeReference = EntityRef & { lifetime: EntityLifetime }
type LifetimeContext = {
  current: EntityLifetime
  causes: readonly DeletionCause[]
  related: readonly EntityLifetimeReference[]
  knownDeletions: ReadonlyMap<string, SyncOperation>
}
type LifetimeDecision = { state: 'apply' | 'stale' | 'pending'; missing: string[] }

function restoredLifetime(causes: readonly DeletionCause[]): EntityLifetime
function decideOperationLifetime(operation: SyncOperation, context: LifetimeContext): LifetimeDecision
```

An initial lifetime is `[]`. Restoring a known deletion starts the canonical sorted set of its acknowledged deletion operation IDs. In `DeletionCause`, `source` names the entity whose actual delete operation caused the barrier; `deletedLifetime` identifies the target entity lifetime that was deleted, including when that target is a cascading descendant. Cascade causes stay separate from ordinary same-entity `parents`. Source identity, target lifetime, and structural cascade membership must be validated against retained history. An unknown or ambiguous cause is not evidence of eligibility. Previously unseen deletes targeting a prior lifetime stay in prior history, even if their dates are newer.

Extend `SyncOperation` in `src/collection.ts` with `action: 'restore'`, `lifetime?: EntityLifetime`, `relatedLifetimes?: EntityLifetimeReference[]`, and `restoreOf?: DeletionCause[]`. A restore requires all three metadata fields. Other new operations are stamped when created, including referenced entity lifetimes; never stamp queued old operations from current rows when sending. A legacy operation with absent metadata belongs to the initial lifetime.

Extend `DeletionTombstone` with `causes: DeletionCause[]`. Determine current lifetimes from retained `syncRevisions`, keeping this lookup behind Collection. Add a `pendingRemoteOperations` table keyed by `opId` for operations whose dependencies are unavailable. Avoid a second independently derived merge policy.

Modify `schema-ladder.ts`, `src/collection.ts`, `src/sync-revisions.ts`, `src/import-contract.ts`, `src/anki-import.ts`, `src/ImportDialog.tsx`, `src/sync-client.ts`, `server/sync-service.ts`, `server/sync-http.ts`, and `server/backups.ts` as their tasks require. Preserve ordinary import validation for writes without explicit restoration authorization.

---

### Task 1: Persist deletion provenance and introduce schema 22

**Files:** Create `entity-lifetimes.ts`; modify `schema-ladder.ts`, `src/collection.ts`, and `server/sync-service.ts`; test `src/collection.test.ts`, `src/schema-ladder.test.ts`, and `server/sync-service.test.ts`.

**Interfaces:** Produces the types above, `restoredLifetime`, provenance-bearing tombstones, and durable SQL columns `lifetime`, `related_lifetimes`, and `restore_of`. Existing public `pendingOperations()` and `applyRemoteChanges()` signatures remain unchanged.

- [ ] Write `deletion provenance survives reopen for direct and cascading deletes`: create a nested deck with notes/media, delete it through Collection, reopen, and deliver its public pending operations to a second collection. Assert the persisted delete operation has its original `opId`, initial `lifetime: []`, and creation-time related lifetimes. Task 2's import preview will additionally assert descendant restoration causes refer to that exact source operation.
- [ ] Add migration fixtures for a version-21 own delete, an ancestor deck cascade, and an ambiguous/missing source. Unique retained evidence is recovered; an ambiguous/missing source is preserved and reported. Do not pick a candidate by time or discard a barrier. A fixture that cannot be recovered safely remains an explicit unsupported migration case with an actionable error; resolve any such case found in the owner's collection before claiming #236 complete.
- [ ] Run `npx vitest run src/collection.test.ts src/schema-ladder.test.ts` and `npm run test:server`; observe the new provenance assertions fail before implementing them.
- [ ] Implement schema 22 and provenance creation using the actual delete operation ID generated for the transaction. Keep cascade references separate from revision parents. Backfill only demonstrable retained provenance, and stamp migrated queued operations with their original initial lifetime.
- [ ] Add SQLite columns idempotently; preserve them in insert, select, and duplicate-operation comparison. Derive operation schema requirements from the shared ladder plus operation metadata, so a restore requires 22 even when its payload contains no new fields.
- [ ] Run the same commands to green. Commit `feat: retain causal deletion provenance for restoration`.

### Task 2: Deliberate atomic local restoration through an Import Plan

**Files:** Modify `src/import-contract.ts`, `src/anki-import.ts`, `src/collection.ts`, and `src/ImportDialog.tsx`; test `src/anki-import.test.ts`, `src/import-invariants.test.ts`, and `src/ImportDialog.test.tsx`.

**Interfaces:** Add `restorations: Array<EntityRef & { causes: DeletionCause[] }>` to the import write contract and a corresponding read-only list/counts to `AnkiImportPlan`. Keep `prepareAnkiImport(...).commit()` and `applyImportedPackage(...)` as the write boundary; the prepared contract carries explicit restoration authorization.

- [ ] Split the existing red `restores a deleted package deck after reopening and re-imports it idempotently` into a local tracer and a replica tracer. The local tracer keeps exact original note/card/reference identity arrays and the idempotent repeat assertions. Leave the replica tracer red until Task 3.
- [ ] Add `a stale restoration preview is refused atomically`: change a relevant deletion/lifetime after preview; commit fails and the original barriers, unrelated rows, media, and pending local operations remain intact.
- [ ] Add `ordinary imported writes cannot bypass a deletion barrier`: retain the existing raw import-invariant rejection when the caller has not supplied valid restoration authorization.
- [ ] Run `npx vitest run src/anki-import.test.ts -t 'restores a deleted package deck locally'` and the focused new invariant tests; observe red.
- [ ] Build the restoration list from package identities and validated deletion causes. Fingerprint those causes/lifetimes in the stale-preview check. Show restore counts in the existing preview; committing is the only confirmation.
- [ ] In one Collection transaction, validate all writes and restore dependencies before materializing decks/types/notes/cards/reviews/media references. Remove only the active tombstones explicitly acknowledged; keep retained causal history. Emit `restore` operations with canonical lifetimes and current related references in that same transaction. Live identities continue to use the existing duplicate policy.
- [ ] Run focused tests to green and preserve the unrelated-row assertions. Commit `feat: restore deleted package identities atomically`.

### Task 3: Apply restoration and dependencies through real synchronization

**Files:** Modify `entity-lifetimes.ts`, `src/collection.ts`, `src/sync-revisions.ts`, `src/sync-client.ts`, `server/sync-service.ts`, and `server/sync-http.ts`; test `src/anki-import.test.ts`, `src/sync-client.test.ts`, and `server/sync-service.test.ts`.

**Interfaces:** Produces `decideOperationLifetime`; Collection's public receive API remains `applyRemoteChanges(changes: SyncOperation[], cursor: number)`. Extend the existing merge signature to `mergeRevisions(revisions: Revision[], activeLifetime: EntityLifetime = []): RevisionMerge`; existing legacy callers retain their initial-lifetime behavior. The HTTP operation representation preserves all lifecycle fields.

- [ ] Run the replica tracer from Task 2; observe restoration still fails to converge before this task.
- [ ] Write `restoration dependencies survive a receive-page interruption`: deliver a dependent child before its parent restore, close/reopen, deliver the parent, and retry both pages. Pending content must become available exactly once. A cursor may advance only after every operation is applied, explicitly classified as stale retained history, or durably stored as pending.
- [ ] Write `a changed operation under a reused identity is rejected`: change only lifecycle metadata under the same `opId`; the server rejects it, and the client keeps unsent work.
- [ ] Implement shared lifecycle decisions at receive and merge. A prior-lifetime delete must not permanently poison a valid current restore. Malformed references/cycles/unrelated deletion causes fail actionably; valid missing dependencies remain pending and are re-evaluated on incoming progress.
- [ ] Validate restoration evidence on the PC against stored or same-request delete operations and retained relationship history; do not substitute cross-entity revision parents. Validate before acknowledgment and before updating the schema watermark.
- [ ] Run `npx vitest run src/anki-import.test.ts src/sync-client.test.ts` and `npm run test:server` to green. Commit `feat: synchronize causal restoration without losing pending work`.

### Task 4: Fence stale devices and prove repeated/concurrent restoration

**Files:** Modify lifecycle stamping/merge callers in `src/collection.ts` and `entity-lifetimes.ts`; test `src/sync-client.test.ts`, `src/anki-import.test.ts`, and `tests/e2e/concurrency.spec.ts`.

**Interfaces:** All Collection write routes emit their creation-time own and related lifetimes through the existing `enqueueOperation`/`enqueueOperations` boundary. Snapshot current related lifetimes from retained revisions inside the write transaction.

- [ ] Write `offline work cannot change a restored lifetime` using three real collections and the HTTP service: keep one client offline before deletion; queue field edits, a newly created child, a review, and a delete; restore elsewhere; reconnect the stale client. Exact restored identity/value/history/media snapshots remain unchanged after delivery and replay.
- [ ] Write `current-lifetime work and a second delete restore cycle still succeed`: edit/review after restore, synchronize, delete again, and re-import. The new lifetime is causally different from the previous one and all supported content converges.
- [ ] Write `same-barrier concurrent restores retain different field versions`: two collections acknowledge the same deletion causes and commit packages with different field values. Their restoration lifetime arrays must be equal; IDs remain unique; both conflicting values remain available for explicit resolution after reopen and retry.
- [ ] Run focused tests to red, then implement any remaining write-route stamping and stale related-entity checks. Include deck ancestry, option groups, note types, cards, reviews, and media references. A new child ID is not a way around a stale parent lifetime.
- [ ] Run focused tests to green. Commit `fix: keep stale offline operations out of restored lifetimes`.

### Task 5: Protect compatibility, backups, and recovery

**Files:** Modify `schema-ladder.ts`, `src/sync-client.ts`, `server/sync-service.ts`, and `server/backups.ts`; test `server/sync-service.test.ts` and `src/sync-client.test.ts`.

**Interfaces:** Existing `client-upgrade-required` / `server-upgrade-required` responses carry the required schema. Backup restore preserves lifecycle columns, retained revisions, and the collection schema watermark, while keeping existing collection-generation safety.

- [ ] Write `schema 21 cannot acknowledge a schema 22 restored collection`: attempt old-client receive and send against a restored collection. Both fail before acknowledgment/materialization; pending local work remains. A new client against an old PC receives the existing PC update message.
- [ ] Write `verified backup restoration preserves deletion and lifetime barriers`: back up a restored collection, reopen/restore through the public service, then replay stale and current operations. Old work remains fenced and current work still converges.
- [ ] Add malformed metadata and unrecoverable-provenance cases to the real HTTP tests. Assert actionable failure, unchanged durable state, and no successful partial acknowledgment.
- [ ] Run `npm run test:server` and focused sync-client tests to red; implement compatibility and complete all explicit backup select/insert paths. Do not lower a restored collection's required schema watermark by ignoring unknown fields.
- [ ] Run to green. Commit `fix: preserve restoration barriers across upgrades and backups`.

### Task 6: Complete the user journey and whole-branch evidence

**Files:** Add `tests/e2e/deck-restoration.spec.ts`; update issue #236 acceptance evidence and `docs/qa/2026-10-07-deck-restoration.md`.

**Interfaces:** Visible package import, deletion, reopen, PC pairing/sync, import preview, study, and export. No hidden database setup or mocked application APIs after fixture creation.

- [ ] Write `a deleted deck can be imported again and studied on a second device`: import a generated non-sensitive nested package with image/audio, delete, reload, preview explicit restore counts, commit, sync a clean paired collection, study, export/re-import, and compare supported identities/content. Check both browsers; retain documented WebKit offline/audio limits separately.
- [ ] Run with isolated ports, for example `$env:KIROKU_WEB_PORT='4190'; $env:KIROKU_SYNC_PORT='4191'; npx playwright test tests/e2e/deck-restoration.spec.ts`; observe red before completing missing UI integration.
- [ ] Complete the journey to green, then run `npm run check` from the #236 worktree. Record exact head, commands/results, schema versions, screenshot paths, and any actual migration limitations. No known-owner migration refusal may be hidden behind a passing synthetic fixture.
- [ ] Commit the journey/evidence, run the Matt Pocock standards/spec review against the fixed branch base, fix findings, and rerun affected/full verification. Push a PR with `Closes #236` only when all criteria are evidenced.
- [ ] Run `npm run premerge -- <PR>` immediately before the authorized merge; remove the disposable worktree/branch in the same step and regenerate repository status.

## Self-review and execution handoff

All approved design sections map to the six tasks. Missing dependencies, cascades, stale related identities, current-lifetime deletion, concurrent conflicts, migration, transport, backups, compatibility, and atomic rollback have named public tests. Task boundaries are sequential because each consumes the preceding task's lifecycle interface; intermediate commits are reviewable development checkpoints, not releases.

Recommended execution: **Native** in this session, followed by the required independent whole-branch standards/spec review. The tasks share the protocol and import transaction, so keeping one implementer's context avoids repeated handoffs while the final review still checks the complete safety contract. Implementation waits for the owner's review of this plan and execution choice.
