# Contributing

Kiroku uses GitHub Issues as an executable dependency graph. Issue #1 is the parent specification; Issues #2–#26 are vertical slices with native blocking relationships.

## Claim work safely

1. Find an open `ready-for-agent` issue whose native `blocked_by` count is zero.
2. Assign it to yourself before changing code.
3. Create a dedicated branch and worktree named for the issue.
4. Implement only that ticket's acceptance criteria using the highest user-visible test seam available.
5. Run focused tests throughout and `npm run check` before requesting review.
6. Push the branch and open a PR that includes `Closes #<issue>`.
7. Do not close a ticket until its PR is merged and its acceptance evidence is recorded.

## Local browser verification on Windows

Use Node.js 22 or newer and the repository's npm version (`npm@11.16.0`), then
install the locked dependencies and matching Playwright browsers:

```powershell
npm ci
npx playwright install chromium webkit
npx playwright test
```

The Playwright projects launch Chromium and Playwright's WebKit build. The WebKit
project emulates an iPhone; it is not installed Safari. A Playwright `spawn UNKNOWN`
reported before the first test is a Windows child-process launch failure, not an
application assertion. On the development host this was recorded by earlier
Windows runs while browser processes were restricted. With the same Node.js 22.18.0,
npm 11.16.0, installed browser binaries, and PATH in the unrestricted run, both
Chromium and WebKit launched. Installing browsers again did not explain or resolve
the earlier failure; run browser checks in a terminal context that allows Node to
start child executables. Node's `spawn UNKNOWN` message does not include the Windows
process-creation status, so if it persists outside a restricted runner, inspect the
Windows security policy or endpoint protection logs rather than changing the app.

When running Playwright alongside another local app or test run, isolate its servers
and sync data with environment variables. For example:

```powershell
$env:KIROKU_WEB_PORT = '4383'
$env:KIROKU_SYNC_PORT = '4384'
$env:KIROKU_RUNTIME_DIRECTORY = "$PWD\.runtime\sync"
npx playwright test
```

The Playwright configuration keeps browser artifacts in that worktree's
`test-results` and `playwright-report` directories. Use a distinct runtime directory
for each concurrent run; do not stop another run's web or sync server to free a port.

Example claim:

```powershell
gh issue edit 3 --repo butahlecoq/anki --add-assignee "@me"
git fetch origin
git worktree add ..\anki-3 -b feat/3-first-offline-review origin/main
```

Never run two implementation agents in the same worktree. Separate worktrees prevent uncommitted changes, test artifacts, and generated files from overwriting each other.

## Pull requests

- Keep one ticket per PR unless an issue explicitly says otherwise.
- State the user-visible outcome and test evidence.
- Call out skipped physical-device checks separately from passing automated WebKit checks.
- Do not commit user collections, packages, credentials, certificates, runtime data, or generated backups.
- Preserve unknown files and changes; do not reset or discard another agent's work.
