# Contributing

Kiroku uses GitHub Issues as an executable dependency graph. Issue #1 is the parent specification; Issues #2–#26 are vertical slices with native blocking relationships.

Read [the generated live repository status](docs/agents/status.md) before selecting work. Run `npm run status:check` to see whether its recorded base still matches `origin/main`; regenerate it with `npm run status`. It reports current PR, CI, branch and worktree evidence from Git and GitHub.

## First, check for drift

```sh
npm run drift
```

Run this before picking up work. It reports branches that carry work no pull request can find, worktrees holding uncommitted changes, how far local `main` is behind `origin/main`, and whether the primary checkout is on `main`. It exits non-zero when it finds any, so read the code it prints: `1` is recoverable drift, `2` is possible loss.

A finding is evidence, not a verdict. "Nothing is in it" means no running process named that path, which a session that never names its directory will not show; ask before you delete anything. See [the drift check guide](docs/agents/drift-check.md) for what each check does and how it survives squash merges.

## Claim work safely

1. Find an open issue labelled `ready-for-agent` whose native blocked-by count is zero. The label says who can do the work; the dependency edges say when, and neither implies the other. [The triage labels guide](docs/agents/triage-labels.md) has both commands, what makes an issue human-only, and a blocking-endpoint trap that returns a JSON error object where a list belongs.

   Do not claim anything labelled `ready-for-human`, `needs-triage` or `needs-info`. `ready-for-agent` means an agent can finish the ticket and prove it unattended; it does not mean an agent could write some code for it.

2. Assign it to yourself before changing code.
3. Create a dedicated branch and worktree named for the issue.
4. Implement only that ticket's acceptance criteria using the highest user-visible test seam available.
5. Run focused tests throughout and `npm run check` before requesting review.
6. Push the branch and open a PR that includes `Closes #<issue>`.
7. Record a named test, command, or human observation on each completed issue criterion before ticking it. Leave unfinished criteria unchecked and record explicit deferrals in an issue comment.
8. Run `npm run premerge -- <PR-number>` immediately before merging. It refuses an unlinked issue, a missing checklist, or any unchecked/unproven criterion without a matching issue-comment deferral.
9. Do not close a ticket until its PR is merged and its acceptance evidence is recorded.

Example claim:

```powershell
gh issue edit 3 --repo butahlecoq/anki --add-assignee "@me"
git fetch origin
git worktree add ..\anki-3 -b feat/3-first-offline-review origin/main
```

Never run two implementation agents in the same worktree; see [one agent, one worktree](#one-agent-one-worktree) below for why that is not negotiable.

There is no blocking GitHub Actions gate, so `npm run check` — typecheck, lint, unit, server, build, and browser — remains the full software gate, and its result must be recorded on the pull request. `npm run premerge` is the separate acceptance-evidence gate. A non-blocking scheduled workflow monitors the latest Anki sync wheel for #150. See [the CI guide](docs/agents/ci.md) for the billing limitation and workflow scope.

GitHub does not enforce `premerge` because this repository has no required hosted
checks or branch protection. The repository merge procedure must run the local
pre-merge check; GitHub's merge button and a direct `gh pr merge` can bypass it.

### Attributing an observed build

Open **Support / build details** in the application to record its version, 12-character Git commit, and whether it is a release build. For a sync-service observation, record the `build` object from `GET /api/health` as well. The generated web app manifest carries the same version and commit in its `kiroku` member. Compare the commit with `git rev-parse --short=12 <commit>` in the checkout used to build the app; a development build is explicitly labelled and is not a release artifact.

### Local browser verification

Use Node.js 22 or newer and the repository's pinned npm version (`npm@11.16.0`). In a fresh worktree, install dependencies and matching browser engines:

```powershell
npm ci
npx playwright install chromium webkit
```

Run browser verification with isolated ports and a private runtime directory. Choose another unused port pair when these ports are occupied; never kill another agent's server.

```powershell
$env:KIROKU_WEB_PORT = '4583'
$env:KIROKU_SYNC_PORT = '4584'
$env:KIROKU_RUNTIME_DIRECTORY = "$PWD\.runtime\browser-run"
npx playwright test
```

The local default runs one worker because Windows WebKit becomes intermittently
starved when the full suite runs six workers concurrently. This is a resource
isolation policy, not a test reduction: all projects and journeys still run.
On a host with measured capacity for parallel WebKit runs, opt in explicitly
with `npx playwright test --workers=2` (or another tested value), while keeping
the one-worker result as the local gate evidence.

Playwright's WebKit project emulates a phone-sized browser; it is not installed iOS Safari. Warm offline journeys verify an already loaded application. Fresh offline navigation, service-worker behavior, and audible playback have documented WebKit or physical-device limits. Keep those skips and limitations separate from application failures.

If a browser process fails before the application starts with `spawn UNKNOWN`, capture the Node/npm/Playwright versions, command, exact head, and process-launch context, then compare an unrestricted run with a clean baseline. Do not treat an application assertion, port collision, reused server, or browser automation limitation as the same failure, and do not claim an unproven historical root cause.

## Rules, and the failures they prevent

Each of these is here because it was broken. When one seems inconvenient, the failure it names is the reason.

### `main` is not a notebook

`main` changes only through a reviewed pull request. Narrative status belongs in the
tracker and in what `npm run check` prints, not in handoff prose committed to `main`.
The generated `docs/agents/status.md` snapshot is the deliberate exception: it is
machine-produced by `npm run status`, linked below, and must not be edited by hand.

**The failure it prevents.** On 2026-10-02, `docs/development-handoff.md` received 24 commits directly on `main` in a single evening. Every one rewrote prose describing worktrees at `C:/work/anki*` — paths that do not exist on this machine, whose real root is `D:/work` — and asserted that the `gh` CLI was not installed when it is. The agent producing those commits never queried the tracker. Writing narrative status into `main` gave it somewhere to record guesses that no check ever challenged, and an audit found every verifiable claim in the file wrong.

Branch protection is not available on this repository's plan, so nothing stops a push mechanically and this rule is held by convention. `npm run drift` reports commits on `main` that are not on `origin/main` for exactly this reason; treat that finding as the error it is.

### A merged pull request and a removed worktree are one action

Merging a pull request and removing its worktree and its branch are a single action, performed together in the same step. [docs/agents/worktrees.md](docs/agents/worktrees.md) has the commands.

**The failure it prevents.** An audit at the time counted nine registered worktrees, four of them holding work that was superseded, duplicated or uncommitted. The worktree guide explained removal well, so the guidance was not missing — what was missing was any reason to do it as part of merging.

### A branch starts from current `origin/main`

Branch from a freshly fetched `origin/main`, never from a stale local `main`:

```sh
git fetch origin
git worktree add ..\anki-<slug> -b feat/<issue>-<slug> origin/main
```

**The failure it prevents.** PR #133 targeted `feat/99-inspectable-import-plan`, which had already merged to `main`, so its base no longer existed; landing the change meant re-porting it by hand onto `main` (see `b947979`). A stale base also produces the conflicting pull requests that never merge and are never closed, which is drift with a review UI in front of it.

A local `main` that is behind `origin/main` is not a valid base. `npm run drift` reports how far behind it is.

### One agent, one worktree

One agent works in one worktree, and two agents never share a checkout. Worktrees are cheap to create and expensive to share: each carries its own `node_modules`, and a shared one silently merges two agents' uncommitted changes, test artifacts and generated files into a state neither can interpret or delete.

**The failure it prevents.** Uncommitted work in a shared checkout is unattributable. Nobody can tell whether a modified file is a half-finished change or debris, so the safe response is to leave the whole worktree alone and start again - which is how nine worktrees and their `node_modules` accumulated in the first place.

### Every push runs the local gate

The hosted workflow cannot run on this repository, so a broken change could reach
`main` without an automated check. A flaky device-key rotation test once reached
`main` for exactly that reason. Running `npm ci` in a fresh clone invokes the
repository's `prepare` script, which configures `core.hooksPath=.githooks`; no
separate hook-install command is needed. Before each push, `.githooks/pre-push`
runs `npm run check:push` (typecheck, lint, unit tests, status tests, and server
tests). On the reference Windows machine this took **about 29 seconds**; the
target is under two minutes. The full `npm run check` remains the pull-request
gate and also covers production build and browser journeys.

### Text files use the same line endings on every platform

`.gitattributes` checks text files out with LF on Windows and POSIX. This avoids a
fast-forward being blocked by an untracked copy of a remote document whose only
byte difference was CRLF versus LF. `npm run drift` compares untracked text files
with `origin/main` after normalizing line endings. When it finds a duplicate, it
prints the exact `git restore --source=origin/main --staged --worktree -- "<path>"`
command to replace and stage the local copy from the remote branch.

## Pull requests

- Keep one ticket per PR unless an issue explicitly says otherwise.
- State the user-visible outcome and test evidence. With no automated checks, this is the only record that anything was verified.
- Call out skipped physical-device checks separately from passing automated WebKit checks.
- Do not commit user collections, packages, credentials, certificates, runtime data, or generated backups.
- Preserve unknown files and changes; do not reset or discard another agent's work.
