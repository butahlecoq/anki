# Git worktrees

This repository uses one git worktree per in-flight issue so several agents can work
in parallel without sharing a checkout. Each worktree carries its own `node_modules`
(roughly 240 MB), so an abandoned worktree is not free.

## Create

Branch `feat/<issue>-<slug>` or `fix/<issue>-<slug>` from an up-to-date `origin/main`,
in its own worktree outside the primary checkout:

```sh
git fetch origin
git worktree add ../anki-<slug> -b feat/<issue>-<slug> origin/main
```

## Remove

Remove a worktree in the same step that merges or closes its pull request. Do not
leave merged work on disk.

```sh
git worktree remove ../anki-<slug>
git branch -d feat/<issue>-<slug>
```

Then confirm what is left:

```sh
git worktree list
git worktree prune
```

## Before deleting a branch

Squash merges make ancestry checks unreliable. `--is-ancestor` reports a merged
branch as unmerged, and `git cherry` disagrees because squashing rewrites patch
ids. Use pull request state as the primary signal, and confirm direction before
destroying anything:

```sh
gh pr list --state all --head <branch>
git diff --stat origin/main <branch>
```

A diff full of *deletions* means `main` already contains the content and the branch
is a stale snapshot. Never force-remove a worktree with uncommitted changes: a dirty
tree is someone's in-progress work, and other agents may be active in it.

## Notes

- Local branches whose pull request is closed and whose content is on `main` are
  disposable. Delete them during cleanup.
- A worktree holding unmerged work with no pull request yet is still live. Keep it.
- Keep any fixture or reference files a worktree holds until they are relocated;
  check before removing a worktree that is not clean.