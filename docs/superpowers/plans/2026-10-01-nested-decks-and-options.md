# Nested Decks and Deck Options Implementation Plan

**Goal:** Let learners organize decks in a hierarchy and reuse durable scheduling options without losing card or review history.

**Spec:** GitHub issue #9, `https://github.com/butahlecoq/anki/issues/9`

## Decisions

- Deck hierarchy uses `parentId`; names are unique among siblings and cycles are rejected.
- A protected Default option group is created during migration and assigned to all existing decks.
- Moving notes updates their generated cards in one transaction while preserving note/card IDs, FSRS state, and review entries.
- Deletion requires an explicit relocate or subtree-delete mode. Relocation reparents direct children; subtree delete tombstones every deleted entity.
- Parent study aggregates descendants. Each deck applies its own option group's daily limits; group reuse shares configuration, not a pooled quota.
- Option edits affect future scheduling only and never rewrite historical review entries.

## Tasks

### Task 1: Model, migration, hierarchy, and sync

- [x] Add parent/group schema, Default group migration, validation, and option-group APIs.
- [x] Add nested deck, move note, relocation, and explicit subtree-delete operations that retain or tombstone identities correctly.
- [x] Sync hierarchy/group operations with reference, cycle, and stale-operation validation.
- [x] Add migration, collection, and multi-client sync coverage.

### Task 2: Scheduling options

- [x] Resolve FSRS settings from the current deck option group for preview and answer.
- [x] Enforce deterministic daily New/Review limits, hierarchy study, and supported ordering.
- [x] Test group reuse, affected decks, future-only scheduling changes, limits, and ordering.

### Task 3: Organization UI, documentation, and review

- [ ] Build accessible nested deck, move/delete, and shared-options flows for desktop and phone sizes.
- [ ] Verify the workflow from settings through persisted scheduling behavior in browser tests.
- [ ] Document hierarchy/options semantics, run full verification, obtain review, and open a PR.
