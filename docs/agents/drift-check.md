# Drift check

`npm run drift` reports work that has drifted out of Git and the tracker: branches
nobody can find, uncommitted work sitting in a checkout, a stale `main`, and the
primary working directory on something other than `main`. It exits non-zero, so it
can run unattended.

Four separate losses happened in one day and none of them produced an error. A
finished sync engine sat on a branch past its pull request's merge point with no
pull request at all; 57 lines sat uncommitted in a worktree for a closed pull
request; the primary checkout sat on a superseded branch, so running the product
from it produced a build missing the collection browser, statistics, custom study
and export; and every local branch reference was stale. This check is the thing
that would have said so.

## Running it

```sh
npm run drift              # from any checkout in the repository
node scripts/drift-check.mjs --repo butahlecoq/anki --main main
```

Run it **first**, before picking up work: it tells you which checkouts and branches
belong to other agents and which are yours to touch.

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | no drift | every branch has a live pull request, every worktree is clean |
| 1 | recoverable drift | `main` behind `origin/main`, a dirty worktree nothing is in, a branch whose content is already on `main`, or something this check could not read |
| 2 | possible loss | a branch with work that is on no pull request, or commits past the merge point of a merged one |

Every finding names the worktree or branch it found, and prints the command that
fixes it. A check that could not read the tracker or `main` exits `1` rather than
printing "No drift" for a run that judged nothing.

## What it checks

- how far local `main` is behind `origin/main`, and any commit on it that is not
  on `origin/main`;
- every local branch, judged against its **live** pull request: work on no pull
  request at all, commits past the merge point of a merged pull request, a closed
  pull request with no replacement, and branches whose content has already reached
  `main`. When a branch has had more than one pull request, the open one wins, then
  the merged one, then the most recently updated - a closed pull request cannot
  hide work that was reopened;
- every worktree with uncommitted changes, separating edits to tracked files from
  files git has never seen, since a brand new file disappears with its directory;
- the primary working directory being on something other than `main`.

Binary differences count as work: `--numstat` prints `-` for them, so a branch whose
only difference is an image or a lockfile carries no line count at all.

A branch is only recommended for deletion when `main` is known to hold its work or
the branch is byte-identical to it. A branch that differs from `main` only by
*deletions*, with no pull request to explain it, gets a `branch-unverified`
verdict and asks you to look, because that is either a snapshot taken before `main`
advanced or unmerged deletion work.

## Squash merges

Ancestry checks are unreliable after a squash merge: `git merge-base --is-ancestor`
reports a merged branch as unmerged, and `git cherry` disagrees because squashing
rewrites patch ids. So pull request state is the primary signal, and the direction
of the work is confirmed with `git diff --numstat origin/main <branch>`: a diff
made only of deletions means `main` already holds the content and the branch is a
stale snapshot, not a loss.

## Liveness, and what it is worth

A dirty worktree is only alarming when nobody is in it. The check reports a
worktree as **work in progress** when a running process's command line mentions its
path, or when the check was run from inside it, and as **stranded** otherwise.

That is evidence, not proof. A session that never names its own directory in a
command line is invisible to this check, so a stranded verdict means *ask whoever
owns it*, not *it is abandoned*.

A branch an agent is sitting in is still judged - silence would let a dev server
running in a stale worktree hide work forever - but its verdicts are softened: a
branch with work on no pull request is still `2`, with the remedy *ask the agent,
do not delete it*, while a branch with nothing to lose is a note rather than
drift. Remedies name the worktree before the branch, because git refuses to delete
a branch a worktree has checked out.

It never authorises deleting a worktree or a branch; see
[worktrees.md](worktrees.md) for that.

## Why it is not part of `npm run check`

`npm run check` gates a change. This check reports the state of the whole
repository on this machine, which several agents share, so folding it in would fail
every pull request for work that is not the author's. Run it as the first thing
when picking up work, and record what it says on the pull request if it found
something concerning.

## Extending it

`analyseDrift` is pure: it takes collected facts (`main`, `primary`, `worktrees`,
`branches`, `pullRequests`, `commandLines`, `cwd`) and returns findings plus an
exit code, with no shell access. `scripts/drift-check.test.mjs` tests it that way,
including the squash-merge, liveness, binary-diff and unreadable-tracker cases. New
verdicts belong there, not in the collectors.

`gitArgs` holds every git invocation, so a flag this repository's git rejects is
one failing test rather than a silently empty report.