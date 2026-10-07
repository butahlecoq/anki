# Deleted-deck restoration design — #236

Status: written design approved by the owner on 2026-10-07. Implementation plan review is next; product implementation has not started.

## Intent

Deleting a deck and importing the same Anki package again must work without changing its stable deck, note, or card identities. Restoration must synchronize to another collection. Ordinary stale operations from an offline device must never resurrect deleted content or overwrite the restored collection.

The existing duplicate policy, supported scheduling/history import, media handling, and atomic import boundary remain in force. A package is a deliberate restoration action only for the identities it actually contains; it does not restore unrelated deleted material.

## Current evidence

The public Collection/import regression on this branch imports a generated package, deletes its deck subtree, closes and reopens the collection, then imports again. It fails with `ImportedPackageRejected` and `Note anki-note:stable-vocabulary-guid has the identity of a deleted note`.

The receiving-collection extension first receives the original operations and deletion, verifies removal, and then expects restoration and retries to converge. Its post-restoration assertions remain unreachable while local re-import is rejected.

There are three distinct guards:

1. Import validation rejects stable identities in `deletedEntities`.
2. Receiving operations checks both an entity's tombstone and the tombstones of its related deck/note/card/type/option group.
3. `mergeRevisions` considers any retained delete revision permanently deleting the entity.

Deck deletion is represented by deck operations. Child tombstones are also derived on a receiving collection. Tombstones currently record entity identity and time, without the deletion operation identity. Ordinary revision parents belong to one entity; a note cannot name a deck deletion as an ordinary revision parent. The server persists explicit operation columns, so new restoration metadata must be supported by storage and transport too.

## Chosen approach: explicit causal restoration

Extend the sync protocol with an explicit restoration operation and provenance for the deletion it acknowledges. Keep ordinary revision parents scoped to their existing entity. Represent a cascading deletion reference separately, with its source entity and deletion operation identity.

Treat restoration as the start of a new entity lifetime. Ordinary edits, reviews, and deletions carry sufficient causal lifetime information for the receiver to distinguish current work from operations created before restoration. Related-entity references must identify the lifetime they used too: an offline device must not create an old-generation child under a restored parent merely because the parent's stable ID matches.

Lifetime identity is determined from the acknowledged causal deletion barriers, not wall-clock timestamps or a randomly selected winning device. Concurrent restoration of the same known deletion starts the same logical lifetime. Conflicting imported field values in that lifetime use the existing retained-conflict behavior; no duplicate identities or arbitrary loss of one device's version is allowed.

An operation with incomplete restoration provenance is retained safely until its dependencies are available, or rejected with an actionable error. It must never be silently acknowledged and lost. Replays are idempotent.

## Import behavior

The existing preview identifies the identities to restore and presents their counts. Committing that import is the deliberate restoration confirmation; no extra confirmation dialog is needed.

The import transaction restores the required parent hierarchy and supported note types, then notes, cards, supported review history, and media references. It updates lifetime state and emits the restoration operations in the same durable transaction. A failed import leaves deletion barriers and local changes intact.

Existing live identities continue to use the current create/update/keep-local/unchanged duplicate policy. Restoration does not import all historical fields indiscriminately or restore unrelated rows absent from the package.

## Deletion and merge rules

- A deletion wins over ordinary work in the lifetime it deletes.
- A valid explicit restoration acknowledges that deletion and begins a new lifetime.
- Delayed updates, child creations, reviews, and deletions targeting an earlier lifetime cannot change the restored one.
- A deletion targeting the current lifetime still works, including another delete/re-import cycle.
- Concurrent restorations acknowledging the same causal barrier converge to one logical lifetime; concurrent differing field values remain retained for resolution.
- Previously unseen deletion causes are handled by their causal lifetime, without comparing device clocks.

## Compatibility and migration

Add a shared schema/protocol ladder step after version 21. Clients that cannot represent restoration must receive an explicit update-required response before they can acknowledge or destructively apply restored collection operations. The browser and PC service must agree on the new protocol.

Migration preserves existing identities and revision history. Recover deletion provenance from retained delete operations, including ancestor-deck cascades. Do not invent provenance from `occurredAt`, clear all tombstones, reset a collection, or rename stable IDs to bypass deletion guards. If a genuinely unrecoverable legacy tombstone exists, preserve it and report it explicitly; it is a migration case to solve, not permission to acknowledge an unsafe restore.

Server storage, backup/restore, wire validation, outbox serialization, and receive persistence must preserve the lifetime and restoration metadata. Malformed references, cycles, reused operation identities with different content, and unrelated deletion references remain rejected.

## Validation at approved public seams

Use the public Anki import/Collection boundary and real paired HTTP synchronization. The existing failing regression is the first tracer test. Add one behavior at a time:

1. Import → delete subtree → close/reopen → re-import restores the original identities and supported content.
2. A second collection receives deletion and then restoration; retries and reopen do not duplicate content or reviews.
3. A device kept offline before deletion later sends old updates, new child notes, reviews, and deletes; the restored collection is unchanged.
4. A nested hierarchy restores dependencies that arrive on different receive pages, including interruption/retry.
5. A second deletion and re-import cycle behaves correctly; concurrent same-barrier restores converge with retained field conflicts.
6. The version-21 migration, mixed-version rejection, malformed-provenance rejection, and PC backup/restore retain the intended safety guarantees.

The implementation plan will name the exact protocol shapes, storage migration, files, and tests after this written design is reviewed. This document does not claim that the regression is fixed.
