# Cloze and Japanese Rendering Implementation Plan

**Goal:** Support cloze notes, Japanese readings, typed answers, and a documented safe subset of Anki-style template filters without weakening offline or sync safety.

**Spec:** GitHub issue #7, `https://github.com/butahlecoq/anki/issues/7`

## Compatibility decisions

- A note type is `standard` or `cloze`. Existing and Basic types are standard.
- Cloze syntax supports `{{cN::answer}}` and `{{cN::answer::hint}}`, with positive integer ordinals. Repeated ordinals create one card; non-contiguous ordinals do not create phantom cards.
- A cloze card has deterministic identity `${noteId}:${templateId}:c${ordinal}`. Removing an ordinal suspends its existing card; restoring it reuses its schedule.
- Support `text:`, `furigana:`, `kana:`, `kanji:`, `cloze:`, `type:`, and `type:cloze:`. Reject other filters and malformed syntax with actionable errors.
- Typed answers are local review state. They show a grapheme-aware comparison before the learner rates a card and never sync.

## Tasks

### Task 1: Parser, filters, and cloze card model

- [x] Add parser and renderer fixtures for cloze masking, hints, ordinals, furigana, typed metadata, filters, and malformed input.
- [x] Add Dexie v7 model migration for note-type kind and cloze card ordinal; retain existing Basic IDs and schedules.
- [x] Generate/reconcile deterministic cloze cards atomically and validate inbound sync operations against live ordinals.
- [x] Run focused unit and collection/sync tests.

### Task 2: Editor, preview, and reviewer

- [x] Add cloze type/editor support and ordinal-aware generation preview.
- [x] Render cloze cards in the sandboxed reviewer frame, including FrontSide and malformed-card containment.
- [x] Add typed input and accessible differences outside the sandbox.
- [x] Add browser tests for cloze, furigana, typed answers, and an offline cold restart.

### Task 3: Documentation and final verification

- [x] Document accepted grammar, filters, unsupported filter errors, typed answers, and compatibility boundaries.
- [x] Run `npm run check` and review the PR before merge.
