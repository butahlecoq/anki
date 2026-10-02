# Development handoff — 2026-10-02, overnight continuation

The parent goal #1 remains active and incomplete. The required end state is safe two-way sync with the user's existing AnkiWeb account on the installed iPhone while the Windows PC is off, including durable offline recovery. Draft PRs and green CI are not completion. Do not use real-account writes as evidence.

## Git and worktrees

Fetch before relying on checks. Run `git status --short --branch` in each path. Current task work is kept in the issue-specific worktrees already required by `docs/agents/worktrees.md`; they share the Git repository object store and do not duplicate the repository history. Continue in these paths and avoid creating more clones/worktrees unless another issue is actively being worked.

| Path | Branch | Head | State |
|---|---|---|---|
| `C:/work/anki` | `main` | `ad9a483` | this handoff refresh pending; preceding documentation CI `37015081542` failed |
| `C:/work/anki-17` | `feat/17-text-csv` | `7c00ccb` | clean; draft PR #72; exact-head CI `37010267515` passed |
| `C:/work/anki-18` | `feat/18-safe-concurrency` | `c1fa803` | clean; draft PR #73; exact-head CI `37016885671` running |
| `C:/work/anki-23` | `feat/23-jetbrains-omarchy-ux` | `b4a6415` | clean; draft PR #74; exact-head CI `37017542638` running |
| `C:/work/anki-56` | `feat/56-ankiweb-account` | `91f2c5c` | clean; draft PR #75; exact-head CI `37016646020` passed |

Do not merge the draft PRs. No worktree has been removed.

## Exact-head CI and review findings

- #17 / PR #72: exact-head CI `37010267515` passed at `7c00ccb`. The semantic CSV metadata assertion fixed an earlier quoting-assumption failure. PR remains draft pending final review and issue acceptance.
- #18 / PR #73: `37014980937` failed when the two-client journey still hung while clicking the studied-card button; iPhone empty-template/hint tests also timed out or flaked. `c1fa803` explicitly scrolls that control into view before clicking. Exact-head CI `37016885671` is running. Typecheck/lint passed locally (existing `ImageOcclusion.tsx` warning); Windows Playwright launch still fails with `spawn UNKNOWN`.
- #23 / PR #74: #23 includes inherited text colors, mobile contrast fixes, a WebKit theme-paint audit, and hides the keyboard shortcut legend on coarse-pointer phones. `37015641465` failed because the test counted a hidden DOM node; `d6a8189` checks visibility instead. `b4a6415` corrects the test comment after CI showed that iPhone WebKit reports a coarse pointer, and asserts visibility on fine pointers. Exact-head CI `37017542638` is running; the prior `d6a8189` run `37017074261` is also still running. This is not physical iPhone evidence.
- #56 / PR #75: `91f2c5c` adds a durable native projection manifest tied to the exact SQLite snapshot and checkpoint revision, including native note/card/review/deck/model/template IDs and original per-card deck bindings. It rejects stale saves and invalidates the map after checkpoint replacement. Focused tests, 268 client tests, typecheck, lint, build, and exact-head CI `37016646020` passed. Account login, native writeback/merge/recovery, gateway deployment, and installed-iPhone sync with PC off remain incomplete.
- Main documentation CI `37015081542` failed on `ad9a483` in iPhone WebKit: the offline hint journey timed out, and the child-deck study-limit journey timed out waiting for an Easy rating button (then passed on retry). Typecheck, lint, unit/server tests, and build passed before the browser stage. Investigate the hint failure and rating state before making a main-green claim. Do not treat documentation CI as feature acceptance.
- #67's private aggregate package preview remains machine-local. Check only `runtime/local-package-preview-summary.json` on the machine that owns private Japanese examples. Never commit packages, credentials, note text, or per-note diagnostics.

## #56 account work and next steps

PR #75 now includes:

1. `e16febb`: namespaced IndexedDB stores for native collection checkpoints and media, derived from normalized username without persisting credentials. This is namespacing, not encryption.
2. `f9ebd29`: a schema-11 SQLite reader that validates the snapshot and builds an in-memory `CollectionData` projection input; importer logic can consume that data without wrapping the whole native account in an `.apkg` archive. Its focused fixture checks native note/card/review identities, siblings in separate decks, Japanese data, source snapshot immutability, and unsupported schema rejection.
3. `91f2c5c`: a persisted base manifest tied to the exact native snapshot and checkpoint revision, with native IDs, note type ordinals, and original per-card deck bindings. Replacing the checkpoint invalidates the manifest. This map is not yet wired to app edits or native writeback.

Validation on the latest manifest head: typecheck, 268 client tests, lint (existing `ImageOcclusion.tsx` warning), production build, and exact-head CI `37016646020` passed. No real account credentials or writes were used.

This is only a projection input and storage boundary. It is not wired to visible account UI or sync. Key remaining design/implementation work:

- Integrate the persisted base manifest with supported app entities while preserving unsupported native rows/configuration/media and original per-card deck IDs even though the app model binds sibling cards through a note deck.
- Map supported field/card/review edits, deletions, and media back into the original native snapshot. Give newly created review IDs stable across interruption/reopen.
- Integrate #18 causal revisions after its review/merge; resolve concurrent account/app edits without silently overwriting.
- Add visible login/status/manual sync/logout, runtime gateway configuration, cancellation, clear full-sync direction previews, and durable backup/recovery controls. Credentials stay in memory.
- Test round trips and interruption recovery with the isolated official Anki engine and synthetic accounts. Do not use the live account.
- Complete installed-iPhone/Safari sync with PC off, cold offline reopen and recovery; track deployment and device evidence under #25/#26.

Known projection limits to audit before expanding it: currently it accepts only schema 11, constructs app-facing note/card/review/deck/template input, and copies media into memory. Keep the native snapshot authoritative. Add bounded total-media handling before connecting this to accounts with large collections, and verify actual schema-11 SQLite variants from the official fixture. `prepareAnkiDataImport()` still commits through the app importer/outbox; do not wire it into sync before the base mapping, transactional writeback, and recovery rules exist.

## At-home start

1. Continue in these existing paths; no additional worktrees were created. `git fetch origin`, check each listed branch/status, and inspect current exact-head CI for #18/#23. #17's `7c00ccb` and #56's `91f2c5c` CI are green.
2. Start in `C:/work/anki-56`; read issue #56 comments, `docs/ankiweb-account-sync.md`, `docs/native-anki-engine.md`, and this handoff.
3. Inspect #18 `37016885671`, including the two-client journey artifacts if it fails or flakes.
4. Inspect #23 `37017542638` and its attached rendered contrast screenshots. Physical iPhone acceptance is still separate.
5. Continue #56 from the persisted manifest into deterministic app-entity identity mapping and recoverable native writeback; leave all PRs draft until their issue-specific evidence is complete.
6. Check #67's private local preview only on the machine that owns those inputs.

The authoritative issue/PR process and five triage labels are in `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`. Use one issue worktree per active feature, and remove it only in the same step as merging that issue's PR.
