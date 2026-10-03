# Triage Labels

| Canonical role    | Tracker label      | Meaning                                  |
| ----------------- | ------------------ | ---------------------------------------- |
| `needs-triage`    | `needs-triage`     | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`       | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`  | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`  | Requires human implementation            |
| `wontfix`         | `wontfix`          | Will not be actioned                     |

When a skill mentions a canonical role, use its corresponding tracker label.

## `ready-for-agent` is the only label an unattended agent may claim

Every other label means stop. This matters more than it looks: for a long time
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
| A physical device | #26 ends in a real-iPhone confirmation checklist |
| A real account | #56 syncs the owner's actual AnkiWeb account |
| A paid resource | hosted minutes, a paid certificate |
| A domain or router configuration | #24 |
| A person judging whether output looks right | #23's "coherent token-driven dark design" |
| An environment this machine does not have | #77 needs a Linux CI run for its baselines |

The last one is easy to miss and worth stating plainly: an issue can be blocked
by *this host* rather than by a human. Read the body for what it needs to run.

## An issue can be `ready-for-agent` and still be blocked

The label says **who** can do the work. The dependency edges say **when**. Both
have to be checked, and neither implies the other:

```sh
# who may claim it
gh issue view <n> --repo butahlecoq/anki --json labels --jq '[.labels[].name] | join(",")'

# whether it is blocked
gh api "repos/butahlecoq/anki/issues/<n>/dependencies/blocked_by" --jq '[.[].number] | join(", ")'
```

An empty result means unblocked. A `404` means the issue number does not exist,
**not** that the issue is unblocked - `gh` prints both, so read the exit status.

## The endpoint that is easy to get wrong

`/issues/<n>/blocked_by` is not a GitHub endpoint. It 404s for every issue,
including ones with real dependencies. Piping it into `--jq 'length'` yields
nothing and a non-zero exit, which is easy to mistake for a count of zero:

```sh
gh api "repos/butahlecoq/anki/issues/24/blocked_by"                 # 404, exit 1
gh api "repos/butahlecoq/anki/issues/24/dependencies/blocked_by"    # [22], exit 0
```

A handoff asserted there were no native blocking edges in this repository,
citing that 404. There are 66 of them, 38 declared on open issues. `24` is
blocked by `22`, and `26` is blocked by `19`, `21`, `23`, `24`, `25`, `54` and
`56`.

## Relabelling

When an issue's real requirement turns out to be human-only, relabel it rather
than leaving it claimable, and say in a comment which requirement did it. The
comment is what stops the next agent from re-deriving the same conclusion from
the body and second-guessing the label.