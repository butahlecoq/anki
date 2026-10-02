# Office handoff — 2026-10-02

## Home continuation update — 2026-10-02

This section supersedes stale head IDs and progress statements below where they
conflict. Current `main` is `483958129c58f0f28aaa53f571176ce112f0115f`.
The clean active worktree is `C:/work/anki-18`, branch
The office branch is being rebased onto current `origin/main` in a separate
worktree. The original `feat/18-safe-concurrency` branch and draft PR #73 are
preserved until the rebased work passes validation and is pushed.

The #18 branch now includes schema-watermark and durable metadata-inference
regressions, a visible two-context offline conflict/choice/convergence journey,
deletion-undo revision cleanup, both-order deck-deletion/review and manual
rescheduling/review races, contextual conflict UI with stale-choice rejection,
and server rejection of cyclic, dangling, and cross-entity revision parents.
The conflict dialog now moves focus into the choice, traps Tab/Shift+Tab,
supports Escape, restores focus after dismissal, and reports a saved choice
accessibly. Its focused component test passes. The known load-sensitive nested
midnight test now has a 20-second timeout for its child Vitest process; its
assertions are unchanged. The full client suite passes all 275 tests. The
30-test server suite, typecheck, lint, and production build pass; lint has the
existing ImageOcclusion fast-refresh warning. The Windows full gate still
terminates with Playwright `spawn UNKNOWN`, so it provides no browser
acceptance.

Check the newest exact-head Linux CI run on PR #73 and inspect its browser
artifact before claiming acceptance. Older runs target prior heads and are not
authoritative. Do not merge or close #18 until the latest CI, visible browser
journey, and remaining review/acceptance gaps are resolved.

Current worktree inventory is six folders: main plus branches #10, #11, #12,
#14, #18, and #45. These are separate Git worktrees, not nested copies required
for normal use. The merge/cleanup review removed verified dead trees, but the
remaining issue worktrees were preserved. Do not remove a tree based on branch
ancestry alone; follow `docs/agents/worktrees.md` and inspect dirty state first.

Other handoff findings rechecked from GitHub:

- #17 / PR #72 is still draft and conflicting with main; rebase before further
  acceptance. `docs/text-csv-handoff.md` and issue #17 comments have details.
- #67 / PR #70 is draft and mergeable; exact-head CI `36972904946` passed.
  Supplied private-package aggregate preview evidence remains outstanding.
- #56 has a design/checkpoint only at `feat/56-ankiweb-account` head `76fa434`;
  the app integration and original AnkiWeb account workflow remain unimplemented.
- Parent #1 remains explicitly incomplete. Device-only iPhone checks, release,
  and PC-off original-account sync are unproven.

No local private packages or `.env` were present in this checkout. Do not treat
office-only PIDs, local paths, or old process sessions from other handoffs as
portable or complete. Never include private package content or credentials in
GitHub evidence.

The user requested a checkpoint before moving to the office. Implementation has
stopped at this checkpoint. The application is **not finished**. Keep the original
scope: Japanese learning PWA on iPhone/Windows, offline review, existing original
AnkiWeb account synchronization with the PC off, private deployment and verified
release journey. Use PRs; do not merge draft work merely because selected tests pass.

## Authoritative starting points

- Repository: https://github.com/butahlecoq/anki
- Specification: https://github.com/butahlecoq/anki/issues/1
- Main at checkpoint: `76fa4349488b20a80182470f8a430afa352a15dd`.
- This handoff is published on `feat/18-safe-concurrency`, draft PR #73. Fetch
  current GitHub state before relying on these head IDs or process states.

## Saved work

| Work | Published state | Resume instructions |
| --- | --- | --- |
| Native Anki collection/media engine, #61 | PR #65 merged; source head `b308972b93f9ef1bddf0a31e2e2e4bd4ad4be1dd` | `docs/native-anki-engine.md`; account UI is still #56 |
| Safe hint fields, #66 | PR #68 merged; source head `4635e5b2d23f4588c68a619b6f9482ad076d2c3d` | Native initially closed disclosure; review scrolling fixes mobile navigation covering hints |
| Safe HTTPS template links, #67 | Draft PR #70; `fix/67-safe-template-links`, `06682d057bd3c634c37e5a366891321ef690b1c5` | https://github.com/butahlecoq/anki/issues/67#issuecomment-5946661798 |
| Text/CSV import/export, #17 | Draft PR #72; `feat/17-text-csv`, `638d672f150e8dd2042e180128946cb381a2a9ff` | `docs/text-csv-handoff.md`; https://github.com/butahlecoq/anki/issues/17#issuecomment-5946669981 |
| Concurrent offline changes, #18 | Draft PR #73; `feat/18-safe-concurrency`, code checkpoint `1ab4143` | Remaining work below; this branch predates merged hint/native changes |
| Visible original AnkiWeb account workflow, #56 | `feat/56-ankiweb-account` pushed at `76fa434`; no application integration files yet | https://github.com/butahlecoq/anki/issues/56#issuecomment-5946649959 |

Previously merged functionality includes export #63, offline media #62, custom
study #64, offline audit #57, browser #55, statistics #53 and private gateway #60.
Check their current GitHub state rather than reconstructing stale worktrees.

## Verification and honest limits

- Native engine exact-head Linux full CI `36971607757` passed (71 browser passes,
  9 explicit skips). The independent official Anki 26.9.3 oracle was rerun by root
  and passed at `b308972`, using generated localhost collections/fake accounts.
  Another agent independently reviewed backups/recovery/media and found no blocker.
- Hint exact-head Linux full CI `36971868581` passed. Focused normal touch,
  Enter/Space, offline review and synthetic package roundtrip passed in Chromium
  and iPhone WebKit. Windows full runs had existing workload/timeout failures;
  those are not reported as passing local full gates.
- Links integrated head `06682d0` passed focused navigation and hint journeys in
  both engines. Its exact full CI `36972904946` was running when handed off.
  Earlier pre-rebase `e5ca303` full Linux CI passed (73 browser passes, 9 skips).
  Green pre-rebase evidence is not exact-head acceptance for the new head.
- CSV typecheck/lint and 10 focused tests passed. Its first visible browser run
  was interrupted for this checkpoint; no browser pass/full gate is claimed.
- Concurrency four causal merge tests and four independently mutated collection
  tests passed. Existing focused collection/sync tests passed 92 tests, server
  suite passed 19 tests, typecheck/lint passed. Local full check session `59708`
  on ports 4367/4368 finished with exit 1: 64 browser passes, 9 explicit skips,
  7 Windows WebKit failures. The final deletion-choice guard was added after that run began;
  a fresh exact-head gate is required.
- Installed physical iPhone/Safari cold offline behavior, actual account workflow,
  independent gateway deployment and real PC-off release evidence remain unproven.

## #18 work in progress and required follow-up

Saved implementation adds schema 15 revision history and conflict records,
causal parent IDs on mutations, service metadata preservation/reuse checks,
field/tag merges, retained conflict versions and an explicit choice dialog.
Reviews include local replay policy snapshots and merge chronologically once;
Anki export preserves standard review facts rather than this local-only metadata.

Before review/merge:

1. Rebase onto current main and reconcile CSV optional stable ID/API changes.
2. Add visible two-browser independent offline edits/reviews, conflict reload,
   deliberate choice and convergence tests against the actual running service.
   Current collection tests use real mutation APIs but are not visible UI evidence.
3. Expand manual rescheduling/review order, equal timestamps, independent policy
   edits, preservation of unrelated merged fields during choice, and malformed
   revision/identity retry coverage.
4. Verify note/card/deck/media deletion races and intentional deletion confirmation.
5. Audit UI context, accessibility, protected built-in entities, error handling and
   stale/resumed choice behavior. Test transaction rollback for rejected mutations.
6. Run full exact-head checks and obtain independent review. Do not close #18 yet.

## #56 integration design

Keep original native SQLite and opaque native media authoritative. Project
supported entities directly, with stable native identities and a persisted base
manifest. Apply only explicit supported local deltas back into original rows;
retain unsupported notes/types/configuration/columns rather than rebuilding away
account data. Do not roundtrip the whole account through `.apkg`: archive caps
would exclude a large real account or the supplied examples combined.

Handle sibling native cards in different decks: the current app enforces card
deck = note deck, so preserving native card identities/decks requires an explicit
projection design. Reconciliation should commit app mutations atomically with
recoverable pending projection metadata. Add login/logout, foreground sync,
expired credentials, progress/cancel/recovery, retained conflict context, explicit
full-direction preview and durable backup choices, native media, gateway setup
and PC-off verification. #18 schema 15 integration is still pending.

## Private samples and secrets

Root `.env` contains the user's AnkiWeb credentials. It and `.packages` are
ignored and **not published**. Never print, log, commit, bundle or use credentials
to perform development collection downloads/writes. The native oracle uses only
generated fake accounts and temporary localhost collections.

Four supplied `.apkg` examples remain local. Earlier aggregate-only preview found
English grammar hint/script incompatibility and Japanese HTTPS anchor
incompatibility; `ivse` imported without errors. Hint support alone does not claim
support for executable grammar templates. Japanese previews after the link fix
were still actively processing, so compatibility/performance is not yet proven.

Private preview PID `3800`, session `31995`, was live at handoff, with a read-only
prepare-only harness in ignored `anki-safe-links/runtime`. Issue #67 records the
reconstruction recipe and aggregate output paths. Revalidate the exact process
before polling; do not restart solely because an observation times out. Do not
publish package content. Local sessions/PIDs are not portable to the office;
check GitHub evidence, and reconstruct only if the process is terminal/missing.

## Remaining full scope

Open feature/release issues at checkpoint: #17–#26, #56, #67 and parent #1.
After current drafts, continue safe resumable sync #19, backup/restore/migration
#20, storage/update protection #21, authentication/untrusted content #22, polish
#23, private free Windows deployment #24, compatibility matrix #25 and production
release journey #26. Do not replace these requirements with narrower green tests.

## Resume from another checkout

```sh
git fetch origin
gh pr list --repo butahlecoq/anki
gh issue view 1 --repo butahlecoq/anki --comments
git worktree add ../anki-office-18 -b office/18 origin/feat/18-safe-concurrency
```

Use separate worktrees for CSV, links and account integration; read their handoffs
before editing. Local `.env`/private package files require separate secure local
setup if needed and must not be committed to make the office checkout portable.

The old archive-limits tree still has **unknown pre-existing uncommitted edits**
in README.md, src/anki-archive.ts and src/anki-archive.test.ts. They were preserved
locally without being attributed to this checkpoint or pushed. Do not reset or
force-remove that worktree. Ignored runtime/reference artifacts in other trees
also need inspection before cleanup. External documentation PR #71 is separate
from these feature checkpoints; recheck its review/CI state in GitHub.
