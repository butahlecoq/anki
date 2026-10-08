# Triage Labels

| Canonical role    | Tracker label      | Meaning                                  |
| ----------------- | ------------------ | ---------------------------------------- |
| `needs-triage`    | `needs-triage`     | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`       | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`  | An agent can finish and prove this        |
| `ready-for-human` | `ready-for-human`  | Requires human implementation            |
| `wontfix`         | `wontfix`          | Will not be actioned                     |

When a skill mentions a canonical role, use its corresponding tracker label.

## `ready-for-agent` is the only label an unattended agent may claim

Every other label means stop. This matters more than it looks: until 2026-10-03
every open issue in this repository carried `ready-for-agent` and nothing else,
so the label selected nothing at all. An agent that found #24 - which needs a
trusted certificate, a domain and a router configuration - followed the
documented process correctly, claimed it, and stalled.

`ready-for-agent` means: **an agent can finish this ticket and prove it,
unattended, on this repository, without a decision only a person can make.**
Not "an agent could write some code for it".

## What makes an issue `ready-for-human`

Any one of these is enough:

| Requirement | Example |
| --- | --- |
| A physical device | #24 requires installed-iPhone observations; #26 qualifies supported automated browser journeys separately |
| A real account | #56 syncs the owner's actual AnkiWeb account |
| A paid resource | hosted minutes, a paid certificate |
| A domain or router configuration | #24 |
| A person judging whether output looks right | #23's "coherent token-driven dark design" |
| An environment this repository cannot produce | A required runner or platform unavailable locally and in CI |

The last one is easy to miss and worth stating plainly: an issue can be blocked
by the *environment* rather than by a person. Read the body for what it needs in
order to run.

**A broken toolchain is not the same thing.** #85 was the hard case: it recorded
that Playwright could not launch on the development machine, which by the rule
above would have made it human-only. It was not. The browser launched fine once
run directly, so the blocker was a stale report rather than a missing capability,
and the remaining work was ordinary browser work with a test seam. Verify a
claimed environment blocker before labelling on it - relabelling a ticket away
from agents on a false premise is as costly as never relabelling it at all.

## An issue can be `ready-for-agent` and still be blocked

The label says **who** can do the work. The dependency edges say **when**. Both
have to be checked, and neither implies the other: #26 is blocked by six open
issues and would be correctly labelled if it were not, and #88 is unblocked and
correctly labelled.

**The failure this prevents.** On 2026-10-03 a handoff concluded that this
repository had no native blocking edges, because
`gh api repos/butahlecoq/anki/issues/<n>/blocked_by` returned `404` for all
eleven issues it checked. The path it used is not a GitHub endpoint, so it 404s
no matter what the issue's real dependencies are - and a `404` from a path that
does not exist is indistinguishable from an issue with no blockers. The
instruction to check blocking state was correct; only the command was wrong, and
a reader following the documented process would conclude every issue in the
repository was unblocked.

The blocked-by path is `/issues/<n>/dependencies/blocked_by`. The shorter
`/issues/<n>/blocked_by` is not a GitHub endpoint, and `gh` prints its error body
to stdout without applying `--jq`, so the command returns a JSON object where a
list was expected - not an empty list, and not a count. Check the exit status
before believing the result:

```sh
gh api "repos/butahlecoq/anki/issues/24/dependencies/blocked_by" --jq '[.[].number] | join(", ")'
# 22            exit 0

gh api "repos/butahlecoq/anki/issues/24/blocked_by" --jq '[.[].number] | join(", ")'
# {"message":"Not Found",...,"status":"404"}    exit 1
```

Count the edges yourself rather than trusting a number in this file:

```sh
gh issue list --repo butahlecoq/anki --state open --limit 60 --json number --jq '.[].number' |
  while read n; do gh api "repos/butahlecoq/anki/issues/$n/dependencies/blocked_by" --jq 'length'; done
```

## Relabelling

When an issue's real requirement turns out to be human-only, relabel it rather
than leaving it claimable, and say in a comment which requirement did it. The
comment is what stops the next agent from re-deriving the same conclusion from
the body and second-guessing the label.

## Acceptance evidence

Issues use an `## Acceptance criteria` checklist with stable `AC-01`-style IDs.
A completed item is ticked only when the same line records a named test,
command, or human observation using `Evidence: test: ...`, `Evidence: command:
...`, or `Evidence: human observation: ...`. A tick without named evidence does
not count as complete. Leave incomplete items unchecked. To defer one, add an
issue comment under `## Deferred acceptance`, naming its AC ID and a reason.

The generated status report counts only checked criteria with named evidence,
prints remaining items, and reports parent-story coverage from explicit story
references in issue bodies. Run `npm run premerge -- <PR-number>` before merging;
it blocks unchecked/unproven criteria unless each is deferred in an issue
comment. This is a local guard: the required hosted **Complete software gate**
checks software, but does not run this acceptance check. The GitHub merge UI
can therefore allow a merge without proven issue criteria; run `premerge`
immediately before merging. See [the CI guide](ci.md).
