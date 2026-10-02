# Development handoff — 2026-10-02, overnight continuation

The parent goal #1 remains active and incomplete. The required end state is safe two-way sync with the user's existing AnkiWeb account on the installed iPhone while the Windows PC is off, including durable offline recovery. Draft PRs and green CI are not completion. Do not use real-account writes as evidence.

## Git and worktrees

Fetch before relying on checks. Run `git status --short --branch` in each path. Current task work is kept in the issue-specific worktrees already required by `docs/agents/worktrees.md`; they share the Git repository object store and do not duplicate the repository history. Continue in these paths and avoid creating more clones/worktrees unless another issue is actively being worked.

| Path | Branch | Head | State |
|---|---|---|---|
| `C:/work/anki` | `main` | current | clean; this file records the latest handoff; docs CI `37018413446` passed on its prior refresh |
| `C:/work/anki-17` | `feat/17-text-csv` | `7c00ccb` | clean; draft PR #72; exact-head CI `37010267515` passed |
| `C:/work/anki-18` | `feat/18-safe-concurrency` | `01a65c4` | clean; draft PR #73; exact-head CI `37019083852` passed |
| `C:/work/anki-23` | `feat/23-jetbrains-omarchy-ux` | `b4a6415` | clean; PR #74 marked ready; exact-head CI `37017542638` passed |
| `C:/work/anki-56` | `feat/56-ankiweb-account` | `6af43c2` | clean; draft PR #75; exact-head CI queued as `37021898193` |

Do not merge the draft PRs. No worktree has been removed.

## Exact-head CI and review findings

- #17 / PR #72: exact-head CI `37010267515` passed at `7c00ccb`. The semantic CSV metadata assertion fixed an earlier quoting-assumption failure. PR remains draft pending final review and issue acceptance.
- #18 / PR #73: `37016885671` failed at the statistics history button. Its failure snapshot shows that the Card progress dialog had already opened and contained both Good and Easy reviews; Playwright kept trying to click the button after the dialog covered it. `01a65c4` uses the button's keyboard activation path; exact-head CI `37019083852` passed. Local typecheck/lint passed (existing `ImageOcclusion.tsx` warning). Windows Playwright launch still fails with `spawn UNKNOWN`.
- #23 / PR #74: #23 includes inherited text colors, mobile contrast fixes, a WebKit theme-paint audit, and hides the keyboard shortcut legend on coarse-pointer phones. `b4a6415` corrects the test comment after CI showed that iPhone WebKit reports a coarse pointer, and asserts visibility on fine pointers. Exact-head CI `37017542638` passed; the PR is now marked ready. This is not physical iPhone evidence; dialog keyboard behavior and visual regression are tracked in #76/#77.
- #56 / PR #75: `91f2c5c` adds a durable native projection manifest tied to the exact SQLite snapshot and checkpoint revision, including native note/card/review/deck/model/template IDs and original per-card deck bindings. `d14f610` rejects ambiguous card/field ordinal mappings and empty GUIDs. `6af43c2` builds a checked native-to-app identity crosswalk for notes, cards, reviews, decks, note types, fields and templates, and lists unsupported source records as unmapped. Typecheck and lint passed; focused projection test passed (5). Exact-head CI `37021898193` is queued. Account login, native writeback/merge/recovery, gateway deployment, and installed-iPhone sync with PC off remain incomplete.
- Main documentation CI `37015081542` failed on `ad9a483` in iPhone WebKit: the offline hint journey timed out, and the child-deck study-limit journey timed out waiting for an Easy rating button (then passed on retry). Typecheck, lint, unit/server tests, and build passed before the browser stage. `47f2d99` documentation CI `37018413446` passed. Investigate the hint failure and rating state before making a main-green claim. Do not treat documentation CI as feature acceptance.
- #67's private aggregate package preview remains machine-local. Check only `runtime/local-package-preview-summary.json` on the machine that owns private Japanese examples. Never commit packages, credentials, note text, or per-note diagnostics.

## #56 account work and next steps

PR #75 now includes:

1. `e16febb`: namespaced IndexedDB stores for native collection checkpoints and media, derived from normalized username without persisting credentials. This is namespacing, not encryption.
2. `f9ebd29`: a schema-11 SQLite reader that validates the snapshot and builds an in-memory `CollectionData` projection input; importer logic can consume that data without wrapping the whole native account in an `.apkg` archive. Its focused fixture checks native note/card/review identities, siblings in separate decks, Japanese data, source snapshot immutability, and unsupported schema rejection.
3. `91f2c5c`: a persisted base manifest tied to the exact native snapshot and checkpoint revision, with native IDs, note type ordinals, and original per-card deck bindings. Replacing the checkpoint invalidates the manifest. This map is not yet wired to app edits or native writeback.
4. `d14f610`: validation prevents duplicate native card/field ordinals and empty note GUIDs from creating an ambiguous future writeback mapping.
5. `6af43c2`: a deterministic crosswalk resolves app IDs from native identities, checks card/review parent relationships and required fields/templates, and reports app-unsupported records as unmapped.

Validation on `91f2c5c`: typecheck, 268 client tests, lint (existing `ImageOcclusion.tsx` warning), production build, and exact-head CI `37016646020` passed. On `d14f610`, typecheck, lint, 9 focused projection/state tests, and exact-head CI `37018717852` passed. On `6af43c2`, typecheck, lint, and 5 focused projection tests passed; exact-head CI `37021898193` is queued. No real account credentials or writes were used.

This is only a projection input and storage boundary. It is not wired to visible account UI or sync. Key remaining design/implementation work:

- Compare the mapped app entities against the native base projection, preserving unsupported native rows/configuration/media and original per-card deck IDs even though the app model binds sibling cards through a note deck.
- Map supported field/card/review edits, deletions, and media back into the original native snapshot. Give newly created review IDs stable across interruption/reopen.
- Integrate #18 causal revisions after its review/merge; resolve concurrent account/app edits without silently overwriting.
- Add visible login/status/manual sync/logout, runtime gateway configuration, cancellation, clear full-sync direction previews, and durable backup/recovery controls. Credentials stay in memory.
- Test round trips and interruption recovery with the isolated official Anki engine and synthetic accounts. Do not use the live account.
- Complete installed-iPhone/Safari sync with PC off, cold offline reopen and recovery; track deployment and device evidence under #25/#26.

Known projection limits to audit before expanding it: currently it accepts only schema 11, constructs app-facing note/card/review/deck/template input, and copies media into memory. Keep the native snapshot authoritative. Add bounded total-media handling before connecting this to accounts with large collections, and verify actual schema-11 SQLite variants from the official fixture. `prepareAnkiDataImport()` still commits through the app importer/outbox; do not wire it into sync before the base mapping, transactional writeback, and recovery rules exist.

## At-home start

1. Continue in these existing paths; no additional worktrees were created. `git fetch origin`, check each listed branch/status, and inspect PR review state. #17's `7c00ccb`, #18's `01a65c4`, #23's `b4a6415`, and #56's `d14f610` CI are green; inspect #56 `6af43c2` run `37021898193`.
2. Start in `C:/work/anki-56`; read issue #56 comments, `docs/ankiweb-account-sync.md`, `docs/native-anki-engine.md`, and this handoff.
3. The two-client journey and statistics history passed at #18 `37019083852`; proceed to the remaining deletion/media race review and independent PR review.
4. Review #23 `37017542638` and its attached rendered contrast screenshots. Physical iPhone acceptance is still separate.
5. Continue #56 from the identity crosswalk into native-base comparison and recoverable writeback; leave PR #75 draft until the full account journey is implemented and reviewed.
6. Check #67's private local preview only on the machine that owns those inputs.

The authoritative issue/PR process and five triage labels are in `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`. Use one issue worktree per active feature, and remove it only in the same step as merging that issue's PR.
