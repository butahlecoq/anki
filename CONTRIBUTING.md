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

Example claim:

```powershell
gh issue edit 3 --repo butahlecoq/anki --add-assignee "@me"
git fetch origin
git worktree add ..\anki-3 -b feat/3-first-offline-review origin/main
```

Never run two implementation agents in the same worktree. Separate worktrees prevent uncommitted changes, test artifacts, and generated files from overwriting each other.

There is no GitHub Actions workflow at present, so `npm run check` — typecheck, lint, unit, server, build, and browser — is the only gate, and its result must be recorded on the pull request. See [the CI guide](docs/agents/ci.md) for why the workflow was removed and what restoring it involves.

Note that the browser suite cannot complete a sync pairing on the current host (#85), so six desktop specs fail on clean `main`. Attribute a browser failure to your change only after comparing it against a clean baseline.

## Pull requests

- Keep one ticket per PR unless an issue explicitly says otherwise.
- State the user-visible outcome and test evidence. With no automated checks, this is the only record that anything was verified.
- Call out skipped physical-device checks separately from passing automated WebKit checks.
- Do not commit user collections, packages, credentials, certificates, runtime data, or generated backups.
- Preserve unknown files and changes; do not reset or discard another agent's work.
