# Development handoff — 2026-10-02

This is the current portable starting point for continuing work on the parent goal
#1. The parent remains incomplete. Draft pull requests are not acceptance or merge
requests. Fetch before relying on any listed CI state.

## Start here

1. Run `git fetch origin` and inspect `git worktree list` plus `git status` in each
   active checkout. Preserve uncommitted user changes.
2. Check exact-head CI and review artifacts for the three current runs:
   - #17 / PR #72, `feat/17-text-csv`, head `698eaea`:
     https://github.com/butahlecoq/anki/actions/runs/37002877296
   - #18 / PR #73, `feat/18-safe-concurrency`, head `b4344e7`:
     https://github.com/butahlecoq/anki/actions/runs/37002859826
   - #23 / PR #74, `feat/23-jetbrains-omarchy-ux`, head `934c104`:
     https://github.com/butahlecoq/anki/actions/runs/37003231948
   These were all in progress at this handoff. Earlier full runs for #17/#18
   were cancelled at the 15-minute job timeout; the workflow limit is now 30
   minutes. Do not treat cancelled runs as product failures or acceptance.
3. For #70 / issue #67, inspect the *local* prepare-only package preview on the
   machine that has the private Japanese examples. Its GitHub CI completed
   successfully at head `06682d0`:
   https://github.com/butahlecoq/anki/actions/runs/36972904946
   The private aggregate preview was still pending in the last handoff. The
   recorded PID/session belonged to another machine and is not portable; check
   whether its expected ignored output
   `runtime/local-package-preview-summary.json` exists and matches the completed
   process before deciding whether to rerun. Never commit packages, credentials,
   note text, or per-note diagnostics; this harness is prepare-only and must not
   mutate a real collection.
4. Continue account synchronization in #56 only after reviewing its acceptance
   and architecture notes. The native protocol engine is on main, but the account
   feature itself has no implementation yet. The user requires their existing
   AnkiWeb account to sync to iPhone with the PC off. Do not substitute Kiroku
   sync or `.apkg` exchange, and never use real-account writes as development
   evidence.

## Current branches and evidence

- **#17 / PR #72** — text/CSV import and export, README workflow, expanded visible
  update/duplicate journey. Current head `698eaea`; worktree clean and mergeable.
  Locally: 10 focused tests, full client suite (271), typecheck, lint and build
  passed. Lint has the existing `ImageOcclusion.tsx` refresh warning. Windows
  Playwright cannot launch (`spawn UNKNOWN`); exact-head Linux CI and artifact
  review are pending. Details: `docs/text-csv-handoff.md` on that branch.
- **#18 / PR #73** — causal offline revisions, durable conflict decisions, undo
  correction, domain races, keyboard-accessible conflict dialog, malformed
  revision checks, and a real two-context browser journey. Current head
  `b4344e7`; worktree clean and mergeable. Locally: 275 client and 30 server
  tests, typecheck, lint and build passed. Earlier full CI hit the old 15-minute
  timeout while running browser tests; exact-head CI with the 30-minute limit is
  pending. Read PR #73 comments for remaining review/acceptance gaps; a green
  workflow alone does not establish every manual scheduling/deletion/media race
  or user-visible browser journey.
- **#23 / PR #74** — tokenized light/dark appearance, accessible contrast,
  typography and mobile sizing. Current head `934c104`; worktree clean and
  mergeable. Local typecheck, lint, 293 unit + 19 server tests and production
  build passed. No local browser or physical-iPhone result is claimed. Exact-head
  CI and visual artifact review are pending.
- **#56 / `feat/56-ankiweb-account`** — no account integration code yet. The
  checkout is clean at main `4839581`, while the remote checkpoint branch still
  points at `76fa434`; main now includes the native engine. There is no reason to
  keep a separate worktree until implementation starts. Read issue #56 comments,
  `docs/ankiweb-account-sync.md`, and `docs/native-anki-engine.md`. The essential
  next design step is safe projection of native schema-11 SQLite and opaque media
  into the editable app model, preserving native identities, unsupported data,
  per-card deck bindings, and recoverable base mappings.
- **#70 / #67** — draft PR remains open at `06682d0`; exact-head CI is successful.
  Private package aggregate previews are not yet recorded as complete. Keep any
  private examples and output local and ignored.

The main branch is `4839581` and its exact-head CI passed. No PR was merged during
the overnight continuation. All four current local worktrees (#17, #18, #23,
#56) were clean when checked. The #56 branch has no feature delta on main; do not
push its rebased checkpoint as a code change.

## Worktree map

| Path | Branch | State |
|---|---|---|
| `C:/work/anki` | `main` | clean |
| `C:/work/anki-17` | `feat/17-text-csv` | clean; PR #72 |
| `C:/work/anki-18` | `feat/18-safe-concurrency` | clean; PR #73 |
| `C:/work/anki-23` | `feat/23-jetbrains-omarchy-ux` | clean; PR #74 |
| `C:/work/anki-56` | `feat/56-ankiweb-account` | clean; no feature delta |

Use the repo's `docs/agents/worktrees.md` when creating/removing worktrees. Do not
remove a live feature checkout or force-remove a dirty tree. The separate
worktree for #56 can be deferred; its local branch is only a rebased copy of
main.

## Home-machine checklist

- [ ] Fetch and confirm latest heads and the three CI runs above; inspect browser
  screenshots/artifacts before updating any PR's acceptance claims.
- [ ] Check whether the existing #67 private preview process finished on the
  machine holding the local packages. Read only its aggregate summary. If it did
  not finish, resume/recreate the prepare-only preview from issue #67's recipe;
  do not duplicate a still-running process.
- [ ] Review #18's actual browser journey and remaining domain race coverage, and
  #17's semantic clean re-import plus stable-ID/history behavior. Keep both drafts
  open until exact-head checks and review support readiness.
- [ ] Review #74 screenshots at desktop and iPhone widths; automated tests do not
  replace installed-iPhone acceptance.
- [ ] Start #56's projection/integration work in one worktree after choosing how
  native per-card deck IDs, base snapshots, stable review-log IDs and crash
  recovery map to the app collection. Test with the isolated official engine.
- [ ] Continue #19–#26, deployment and physical iPhone checks under their issues.
  The parent goal is not done until the existing AnkiWeb account works from the
  installed iPhone while the PC is off, and offline study/recovery is verified.

Follow `CONTRIBUTING.md`, `AGENTS.md`, and the issue/label/domain guidance in
`docs/agents/`. Do not claim real-account, physical-device, private-package, or
browser acceptance without the corresponding evidence.
