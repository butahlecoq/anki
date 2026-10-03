# Contributing

Kiroku uses GitHub Issues as an executable dependency graph. Issue #1 is the parent specification; Issues #2–#26 are vertical slices with native blocking relationships.

## First, check for drift

```sh
npm run drift
```

Run this before picking up work. It reports branches that carry work no pull request can find, worktrees holding uncommitted changes, how far local `main` is behind `origin/main`, and whether the primary checkout is on `main`. It exits non-zero when it finds any, so read the code it prints: `1` is recoverable drift, `2` is possible loss.

A finding is evidence, not a verdict. "Nothing is in it" means no running process named that path, which a session that never names its directory will not show; ask before you delete anything. See [the drift check guide](docs/agents/drift-check.md) for what each check does and how it survives squash merges.

## Claim work safely

1. Find an open `ready-for-agent` issue whose native `blocked_by` count is zero.
2. Assign it to yourself before changing code.
3. Create a dedicated branch and worktree named for the issue.
4. Implement only that ticket's acceptance criteria using the highest user-visible test seam available.
5. Run focused tests throughout and `npm run check` before requesting review.
6. Push the branch and open a PR that includes `Closes #<issue>`.
7. Do not close a ticket until its PR is merged and its acceptance evidence is recorded.

Example claim:

```powershell
gh issue edit 3 --repo butahlecoq/anki --add-assignee "@me"
git fetch origin
git worktree add ..\anki-3 -b feat/3-first-offline-review origin/main
```

Never run two implementation agents in the same worktree; see [one agent, one worktree](#one-agent-one-worktree) below for why that is not negotiable.

There is no GitHub Actions workflow at present, so `npm run check` — typecheck, lint, unit, server, build, and browser — is the only gate, and its result must be recorded on the pull request. See [the CI guide](docs/agents/ci.md) for why the workflow was removed and what restoring it involves.

Note that the browser suite cannot complete a sync pairing on the current host (#85), so six desktop specs fail on clean `main`. Attribute a browser failure to your change only after comparing it against a clean baseline.

## Rules, and the failures they prevent

Each of these is here because it was broken. When one seems inconvenient, the failure it names is the reason.

### `main` is not a notebook

`main` changes only through a reviewed pull request. Status belongs in the tracker and in what `npm run check` prints, not in prose files committed to `main`.

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

## Pull requests

- Keep one ticket per PR unless an issue explicitly says otherwise.
- State the user-visible outcome and test evidence. With no automated checks, this is the only record that anything was verified.
- Call out skipped physical-device checks separately from passing automated WebKit checks.
- Do not commit user collections, packages, credentials, certificates, runtime data, or generated backups.
- Preserve unknown files and changes; do not reset or discard another agent's work.
