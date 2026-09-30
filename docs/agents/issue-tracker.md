# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues at `butahlecoq/anki`. Use the `gh` CLI for all operations.

## Conventions

- Create an issue with `gh issue create`.
- Read issues with `gh issue view <number> --comments`.
- List issues with `gh issue list`, including labels and comments when needed.
- Comment with `gh issue comment`.
- Apply or remove labels with `gh issue edit`.
- Close issues with `gh issue close`.
- Infer the repository from the Git remote when possible; otherwise pass `--repo butahlecoq/anki`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve ambiguous references by trying the PR first, then the issue.

## Publishing and fetching

- When a skill says “publish to the issue tracker,” create a GitHub issue.
- When a skill says “fetch the relevant ticket,” read the issue and its comments.

## Wayfinding operations

- Represent a wayfinding map as one issue labelled `wayfinder:map`.
- Represent tickets as GitHub sub-issues when supported, otherwise as a task list with `Part of #<map>`.
- Represent blocking relationships with native issue dependencies when supported, otherwise with a `Blocked by:` line.
- Claim work by assigning the issue to the authenticated user.
- Resolve work by commenting with the answer, closing the issue, and updating the map.
