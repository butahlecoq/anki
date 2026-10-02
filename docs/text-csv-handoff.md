# Issue 17 checkpoint: text and CSV

Branch: `feat/17-text-csv`. Dedicated worktree: `D:/work/anki-csv-17`.
Base: `d5f9dcca4aba50133aa68514f34911b0acc4aec0`.

The collection workspace now offers **Import / export text**. Import supports
file/paste, UTF-8/BOM, UTF-16 and explicit Shift JIS, delimiter/quoting/header
controls, column mapping, stable identifiers, nested deck paths, HTML conversion,
tag replacement/merge, duplicate policies, representative preview and downloadable
row errors. Importing valid rows while skipping errors requires an explicit check.
Preview is read-only; apply checks the collection snapshot and uses existing
collection APIs in one transaction. Stable-ID updates preserve review history and
card scheduling. Deleted note identifiers cannot be resurrected.

Export supports note/card rows, deck scope, fields and metadata, HTML conversion,
delimiter/header and UTF-8 BOM. Scheduling, review logs, media bytes and note-type
definitions require Anki package export. Card rows contain card metadata but text
import generates cards from existing note types. Limits: 16 MiB, 20,000 rows,
128 columns and one million characters per cell. Missing mapped deck paths are
created only when explicitly enabled. Existing note types are required.

## Verified before checkpoint

- Typecheck passed.
- Lint passed with the existing ImageOcclusion fast-refresh warning.
- All 10 focused `src/text-csv.test.ts` tests passed. They cover Japanese encodings,
  quoting, malformed/oversized rows, explicit partial import, stable updates and
  preserved FSRS/history, duplicate policies, stale previews, tombstones, and clean
  target note/card export round trips.
- `tests/e2e/text-csv.spec.ts` has a visible partial-import/offline-export/independent
  clean-client re-import journey, with actual downloaded bytes compared between
  clients. Its first local browser run was in progress at checkpoint; consult the
  PR/issue handoff for its final result. This is not yet acceptance evidence.

## Resume

1. Fetch and rebase onto current `origin/main`. Root owns issue 18 and changes
   collection sync/conflict handling; reconcile the optional `createNote` stable
   identifier parameter carefully. No schema or remote-change edits are part of 17.
2. Finish and verify the visible E2E journey on Chromium and iPhone WebKit. Add
   visible stable-ID update/intentional-duplicate/history evidence if needed.
3. Review parser/import limits and UI behavior; add user-facing README instructions.
4. Run focused browser tests and the full `npm run check` gate. Record actual
   failures/skips; existing Windows WebKit limits are not physical Safari proof.
5. Obtain independent review and exact-head CI before making the draft ready.
   Issue 17 remains open; no acceptance or completion claim is made.

Do not touch credentials, runtime data or the unknown dirty changes in the original
`D:/work/anki-offline-images` worktree. All issue 17 author work is in this branch.
