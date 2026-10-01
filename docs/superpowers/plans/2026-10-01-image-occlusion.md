# Image Occlusion Implementation Plan

**Goal:** Let learners create, edit, synchronize, and study media-backed rectangular image occlusion notes offline.

**Spec:** GitHub issue #8, `https://github.com/butahlecoq/anki/issues/8`

## Decisions

- Store normalized rectangular masks on the note with stable UUIDs and never-reused ordinals.
- Generate a deterministic card per mask as `${noteId}:${templateId}:m${maskId}`. Geometry edits preserve card and review history; removal suspends the matching card.
- Reuse verified `noteMedia` and `mediaBlobs` for one source image; no separate image format is introduced.
- The built-in Image Occlusion type provides Header and Back Extra; tags are stored with the note.
- This issue defines versioned import/export fixture semantics only. Package import/export belongs to #15 and #16.

## Tasks

### Task 1: Model, migration, and synchronization

- [x] Add image-occlusion note metadata, tags, card identity, built-in type, validation, and Dexie migration.
- [x] Atomically create/update source-media references and mask cards, preserving unaffected FSRS/review history.
- [x] Reconcile remote operations against live masks and reject stale card/review updates.
- [x] Add collection, sync, migration, and native-representation fixture tests.

### Task 2: Editor and review

- [x] Build accessible image upload and SVG mask editor with pointer, touch, keyboard list controls, and mobile layout.
- [x] Support Header, Back Extra, tags, deck, mask add/move/resize/delete, and save errors.
- [x] Render active-mask question and revealed answer over verified local image in review.
- [x] Add desktop and phone browser tests, including history-preserving mask edits.

### Task 3: Offline verification and documentation

- [x] Verify image metadata/blob sync and cold offline reload in supported browser profiles.
- [x] Document representation, constraints, and import/export fixture boundary.
- [ ] Run `npm run check`, obtain review, and open a PR.
