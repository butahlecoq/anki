# Reusable Note Types and Card Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let learners safely create reusable note types with fields and multiple independently styled card templates.

**Architecture:** Store versioned note types separately from notes, and have notes reference the type and a field-value map. Generate cards from templates locally with a small deterministic renderer that escapes field values and supports field replacement, conditionals, and front-side inclusion. Keep rendered template CSS inside a sandboxed preview frame so it cannot affect application chrome.

**Tech Stack:** React 19, TypeScript, Dexie, Vitest, Playwright.

**Spec:** GitHub issue #6, `https://github.com/butahlecoq/anki/issues/6`

## Global Constraints

- Preserve existing Basic notes and their review history during schema migration.
- Continue to work offline and emit collection sync operations for note-type changes.
- Escape note fields before rendering template HTML; do not execute template JavaScript.
- Keep the existing PNG/JPEG/WebP and MP3/Ogg/WAV media workflow available to Basic notes.

## Review Focus

- Removing a populated field must require an explicit disposition and preserve the chosen data path.
- A template that renders no visible field content must create no study card and report why.
- Field values containing HTML must display as text, while template HTML and CSS remain functional.
- Deleting a note type used by notes must require a replacement type and an explicit field mapping, then preserve unmapped values as retired data.
- Syncing an older Basic note into a collection with the default type must remain idempotent.

---

### Task 1: Note-type schema and deterministic card generation

**Files:**
- Modify: `src/collection.ts`
- Modify: `src/collection.test.ts`
- Create: `src/template-renderer.ts`
- Create: `src/template-renderer.test.ts`

**Interfaces:**
- Produces `NoteType`, `NoteTypeField`, `CardTemplate`, `renderTemplate(template, fields, front)` and collection CRUD methods for later UI tasks.
- Consumes existing `Note`, `CardRecord`, and sync outbox conventions.

- [x] **Step 1: Write failing renderer tests** for escaped field replacement, `{{#Field}}…{{/Field}}`, `{{^Field}}…{{/Field}}`, `{{FrontSide}}`, and empty-card detection.
- [x] **Step 2: Run `npm run test -- src/template-renderer.test.ts`** and confirm the module is missing.
- [x] **Step 3: Implement `renderTemplate(template: string, fields: Record<string, string>, front?: string): RenderedTemplate`** with no script execution and an `isEmpty` result derived from rendered text content.
- [x] **Step 4: Write failing collection tests** for default Basic migration, multiple templates producing cards, and empty templates producing no cards.
- [x] **Step 5: Implement Dexie schema version, default Basic `NoteType`, note-type CRUD, and card regeneration inside collection transactions.** Preserve existing card scheduling records when a template remains associated with its card.
- [x] **Step 6: Run `npm run test -- src/template-renderer.test.ts src/collection.test.ts`** and commit `Add note type data model`.

### Task 2: Safe field and template mutations

**Files:**
- Modify: `src/collection.ts`
- Modify: `src/collection.test.ts`

**Interfaces:**
- Consumes `NoteType` and generated-card APIs from Task 1.
- Produces `updateNoteType`, `cloneNoteType`, `deleteNoteType`, and explicit field-removal modes.

- [x] **Step 1: Write failing tests** for rename, clone, replacement-type migration, reorder, and remove-field modes (`discard` and `keep-as-extra`).
- [x] **Step 2: Run `npm run test -- src/collection.test.ts`** and confirm the mutation coverage fails.
- [x] **Step 3: Implement mutation methods** that update affected notes and regenerate cards atomically; require a replacement type and field mapping before deleting a populated type, and reject destructive changes without an explicit mode.
- [x] **Step 4: Add sync operation tests** showing note-type changes are idempotent on a second client.
- [x] **Step 5: Run `npm run test -- src/collection.test.ts`** and commit `Safely mutate note types`.

### Task 3: Note-type manager, note editor, and preview

**Files:**
- Modify: `src/CollectionWorkspace.tsx`
- Modify: `src/styles.css`
- Create: `src/TemplatePreview.tsx`
- Modify: `src/App.test.tsx`
- Modify: `tests/e2e/collection.spec.ts`

**Interfaces:**
- Consumes collection note-type methods and `renderTemplate`.
- Produces accessible dialogs for type management and note creation from the selected type.

- [x] **Step 1: Write failing component and browser assertions** for creating a type, adding/reordering fields, adding a second template, previewing it, and receiving an empty-card warning.
- [x] **Step 2: Run the focused Vitest and Playwright tests** and confirm the controls are absent.
- [x] **Step 3: Implement the manager and field-aware note dialog.** Require a field-removal choice before save and guide the learner through replacement-type and field-mapping choices before a populated type is deleted.
- [x] **Step 4: Implement `TemplatePreview` with a sandboxed iframe** using `srcDoc`, rendered template markup, and the template CSS; prevent access to the parent application.
- [x] **Step 5: Run focused tests** and commit `Add note type editor and preview`.

### Task 4: Review rendering and final verification

**Files:**
- Modify: `src/CollectionWorkspace.tsx`
- Modify: `tests/e2e/collection.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes generated cards and the renderer from Tasks 1–3.

- [x] **Step 1: Write failing reviewer tests** for a second generated card, styled front/back rendering, and a card skipped when its template is empty.
- [x] **Step 2: Implement template-based review rendering** while preserving the existing media renderer for the Basic type.
- [x] **Step 3: Document supported template syntax and field-deletion behavior in `README.md`.**
- [x] **Step 4: Run `npm run check`** and commit `Complete reusable note types`.

## Self-review

- Task 1 covers type storage, multiple cards, the rendering syntax, empty detection, and Basic compatibility.
- Task 2 covers rename, clone, deletion, field change handling, and sync behavior.
- Task 3 covers editable fields, templates, preview, and style isolation.
- Task 4 covers actual reviewer output and documentation.
- The five risky input classes in Review Focus each have a test in Tasks 1–3.
