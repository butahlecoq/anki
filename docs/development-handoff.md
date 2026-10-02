# Development handoff — 2026-10-02, evening checkpoint

The parent goal #1 remains active and incomplete. The required end state is safe two-way sync with the user's existing AnkiWeb account on the installed iPhone while the Windows PC is off, including durable offline recovery. Draft PRs and green CI are not completion. Do not use real-account writes as evidence.

## Git and worktrees

Fetch before relying on checks. Run `git status --short --branch` in each path. Current task work is kept in the issue-specific worktrees already required by `docs/agents/worktrees.md`; they share the Git repository object store and do not duplicate the repository history. Continue in these paths and avoid creating more clones/worktrees unless another issue is actively being worked.

| Path | Branch | Head | State |
|---|---|---|---|
| `C:/work/anki` | `main` | `64af4a5` | clean before this handoff update |
| `C:/work/anki-17` | `feat/17-text-csv` | `b423520` | pushed; draft PR #72; exact-head CI running |
| `C:/work/anki-18` | `feat/18-safe-concurrency` | `bfe1042` | pushed; draft PR #73; exact-head CI running |
| `C:/work/anki-23` | `feat/23-jetbrains-omarchy-ux` | `f46e07e` | pushed; draft PR #74; exact-head CI passed |
| `C:/work/anki-56` | `feat/56-ankiweb-account` | `f9ebd29` | pushed; draft PR #75; exact-head CI running |

Do not merge the draft PRs. No worktree has been removed.

## Exact-head CI and review findings

- #17 / PR #72: old run `37006282653` failed because its browser test queried every `role=status` after import; the preview summary and “Working…” indicator made that locator ambiguous. The test now waits for the exact “Import complete: …” message at `b423520`; new run `37007876080` is running. Inspect its exact-head result and artifacts before making any readiness claim.
- #18 / PR #73: `bfe1042` isolates the concurrency browser test's sync server and runtime directory after stale conflicts from other tests contaminated the fixture. Run `37006286987` was still running at this checkpoint. The PR comments contain earlier server compatibility, undo/race, and conflict UI handoffs. Check this run and preserve remaining manual scheduling/deletion/media-race and visible journey acceptance gaps.
- #23 / PR #74: exact-head CI `37006365277` passed on `f46e07e` (full check). Its earlier draft comment records 73 browser passes and 9 skips on a prior head. Review latest artifacts/screenshots and keep physical iPhone acceptance separate; the CI phone-sized WebKit project is not a device.
- #56 / PR #75: exact-head CI `37007779740` is running on `f9ebd29`. Prior storage-only head `e16febb` passed CI run `37006347943`.
- Main CI `37004063690` failed at an existing offline hint test on iPhone WebKit after timing out at 30 seconds; 72 passed, 9 skipped. Failure artifact points to `tests/e2e/hint.spec.ts` around the offline answer/review flow. Investigate as a separate main reliability issue; do not attribute it to the #17 or #56 work.
- #70 / issue #67: previous exact-head CI at `06682d0` passed (`36972904946`), but the private aggregate package preview remains a separate machine-local check. On the machine with private Japanese examples, inspect only `runtime/local-package-preview-summary.json` and confirm no process is still running before deciding to rerun. Never commit packages, credentials, note text, or per-note diagnostics.

## #56 account work and next steps

PR #75 now includes:

1. `e16febb`: namespaced IndexedDB stores for native collection checkpoints and media, derived from normalized username without persisting credentials. This is namespacing, not encryption.
2. `f9ebd29`: a schema-11 SQLite reader that validates the snapshot and builds an in-memory `CollectionData` projection input; importer logic can consume that data without wrapping the whole native account in an `.apkg` archive. Its focused fixture checks native note/card/review identities, siblings in separate decks, Japanese data, source snapshot immutability, and unsupported schema rejection.

Validation on `f9ebd29`: typecheck passed; 266 client tests passed; lint passed with the existing `ImageOcclusion.tsx` warning; production build passed. Full browser CI is pending. No real account credentials or writes were used.

This is only a projection input and storage boundary. It is not wired to visible account UI or sync. Key remaining design/implementation work:

- Persist a recoverable base manifest; preserve unsupported native rows/configuration/media and original per-card deck IDs even though the app model binds sibling cards through a note deck.
- Map supported field/card/review edits, deletions, and media back into the original native snapshot. Give newly created review IDs stable across interruption/reopen.
- Integrate #18 causal revisions after its review/merge; resolve concurrent account/app edits without silently overwriting.
- Add visible login/status/manual sync/logout, runtime gateway configuration, cancellation, clear full-sync direction previews, and durable backup/recovery controls. Credentials stay in memory.
- Test round trips and interruption recovery with the isolated official Anki engine and synthetic accounts. Do not use the live account.
- Complete installed-iPhone/Safari sync with PC off, cold offline reopen and recovery; track deployment and device evidence under #25/#26.

Known projection limits to audit before expanding it: currently it accepts only schema 11, constructs app-facing note/card/review/deck/template input, and copies media into memory. Keep the native snapshot authoritative. Add bounded total-media handling before connecting this to accounts with large collections, and verify actual schema-11 SQLite variants from the official fixture. `prepareAnkiDataImport()` still commits through the app importer/outbox; do not wire it into sync before the base mapping, transactional writeback, and recovery rules exist.

## At-home start

1. `git fetch origin`, check each listed worktree's branch/status, and inspect current exact-head CI for #17/#18/#56.
2. Start in `C:/work/anki-56`; read issue #56 comments, `docs/ankiweb-account-sync.md`, `docs/native-anki-engine.md`, and this handoff.
3. Update PR #75's description/checkpoint after its new CI finishes. The GitHub issue comment from this evening has a concise task list.
4. Continue only the bounded projection/base-manifest design; leave all PRs draft until their issue-specific evidence is complete.
5. Check #67's private local preview only on the machine that owns those inputs.

The authoritative issue/PR process and five triage labels are in `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`. Use one issue worktree per active feature, and remove it only in the same step as merging that issue's PR.
