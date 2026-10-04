## Agent skills

### Live status

Before selecting work, read [the generated live repository status](docs/agents/status.md).
Regenerate it with `npm run status`; the report includes local worktrees and current tracker state.

### Issue tracker

Issues and specs are tracked in GitHub Issues for `butahlecoq/anki`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage-role labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

### Worktrees

Work happens in one git worktree per in-flight issue. Remove the worktree in the
same step that merges its pull request, and confirm a branch is disposable before
deleting it. See `docs/agents/worktrees.md`.
