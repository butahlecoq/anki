# Development handoff — 2026-10-01

Work was paused at the user's request. Both unfinished features are saved in GitHub branches; neither is merged.

## Main

Main is at `56f471c` and includes merged reviewer maintenance (#11 / PR #51) and bounded Anki archive imports (#45 / PR #52). Completed worktrees for #10, #11, and #45 are redundant, but have not been removed.

## Statistics — #14 / PR #53

Branch: `feat/14-progress-statistics`. Draft PR: https://github.com/butahlecoq/anki/pull/53.

The latest head `581ca056fd71b429e4c27195f72d2b7779cb368a` passed CI: https://github.com/butahlecoq/anki/actions/runs/36894387582. Statistics, review duration, shared dashboard/reviewer queue, heatmap navigation, and chronological card history are implemented. Review the exact-head CI logs and screenshot artifacts, record acceptance evidence, update the PR body, and merge only after that review.

Offline statistics run in both engines. Fresh-document offline reopening has a separate Chromium check and an explicit WebKit skip. Earlier failed WebKit reloads left the old DOM alive. Audit issue #54 tracks correction of other misleading reopen tests and is a native blocker for compatibility #25 and release #26: https://github.com/butahlecoq/anki/issues/54. Physical installed-iPhone offline reopening is still unverified.

## Collection browser — #12

Branch: `feat/12-collection-browser`, based on main `56f471c`, without the statistics branch. Implementation includes search with error positions, card/note views, sortable pages of 50, persistent stable-ID selection, transactional bulk maintenance, confirmed field previews in a worker, and duplicate/empty reports. Nested move destinations now show full paths.

Latest local checks: typecheck, lint (one existing ImageOcclusion fast-refresh warning), 29 focused parser/maintenance/component tests, and production build passed. The worker builds as its own small asset and is included in the PWA precache.

New `tests/e2e/browser.spec.ts` journeys are saved but have not been executed. They use visible controls and actual worker execution for offline replacement, selection persistence, tags/flags/deletion, a 72-note package, duplicate reports, pagination, and regex timeout/recovery. Verify their selectors and behavior in CI; do not assume they pass. Local Playwright browser launch still fails with `spawn UNKNOWN`, and no computer-use browser is available.

Remaining before #12 is reviewable:

- Run the full `npm run check` in CI and resolve failures. Capture and inspect desktop/mobile browser screenshots and overflow checks; add screenshot artifact retention as needed.
- Finish coverage for bulk move/suspension and empty reports through visible controls, plus any acceptance gaps found in review.
- After #14 merges, rebase this branch onto main. Combine App navigation/routes and both CSS additions; preserve Statistics and Browse. Rerun required checks on the resulting head.
- Update the PR validation evidence, comment on #12, and close the issue only after merge.

## Resume on another computer

Clone/fetch `butahlecoq/anki`, then check out the named feature branches. This handoff travels with `feat/12-collection-browser`; local worktree folders are not needed. Run `npm ci` in the chosen checkout. Follow `CONTRIBUTING.md` and the issue-tracker guidance; the broader parent goal #1 remains incomplete.
