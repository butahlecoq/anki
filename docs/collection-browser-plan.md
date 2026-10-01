# Collection browser implementation plan

Issue: https://github.com/butahlecoq/anki/issues/12

The browser will use the existing local collection and mutation APIs. Cards remain identified by card IDs and notes by note IDs; sorting, paging, search changes, synchronization, and reload must never turn a saved selection into different records.

## Search and results

- Add a pure search parser with source positions, quoted values, AND/OR grouping, and negation. Document the supported Anki-like subset rather than silently interpreting unknown operators as text.
- Evaluate text, deck subtrees, tags, card state, due dates, note types, flags, templates, and representative review-history predicates against joined local records.
- Preserve the last successfully evaluated results while an invalid draft query displays its error and position.
- Card results match individual cards. Note results deduplicate matching cards by note ID. Explain that note-level actions affect all generated cards.
- Provide sortable columns and bounded pages so large collections do not render thousands of rows at once. Save view, query, sort, and selected IDs on this device; prune selections only when their records disappear.

## Maintenance

- Reuse existing note/card mutations inside one collection transaction for bulk tag, move, suspension, flag, deletion, and field edits. Validate IDs and destinations before writing; failures must roll back collection and outbox changes together.
- Require a concrete preview and confirmation for destructive changes, including note deletion and field replacement. Distinguish selected cards from the notes containing them.
- Find/replace provides literal and regular-expression modes, field selection, before/after values, and a reviewable affected-note count. Bound expensive previews and prevent unbounded regex execution on the UI thread.
- Duplicate-note and empty-card reports use the same result/selection surface and link to affected records.

## Evidence

- Parser and domain tests cover search errors, grouping/negation, Japanese text, every documented predicate, note/card semantics, stable identity, transactional rollback, and replacement preview/application.
- Browser journeys exercise search, selection, sorting, bulk changes, reload persistence, reports, and invalid searches through visible controls in Chromium and iPhone WebKit.
- A large fixture verifies bounded DOM rows and navigation. Capture desktop/mobile screenshots and check horizontal overflow. Keep physical iPhone checks separate from automated WebKit evidence.
- Run `npm run check` in CI before review and merge, record acceptance evidence on #12, and close only after merge.
