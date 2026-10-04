# Continuous integration

The GitHub Actions workflow has been removed. Both of its jobs — *Fast checks*
and *Browser tests* — were failing to start on this account with:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

Nothing in the workflow was at fault; the runners never executed, so the checks
carried no information about any change. Continuing to present them as required
status made every pull request permanently unmergeable while providing no
verification at all.

## The local gate

`npm run check` is now the only gate, and it is the complete one:

```sh
npm run check   # typecheck, lint, unit, server, build, browser
```

It runs in about two minutes on a healthy machine, against the same scripts the
removed workflow invoked. `docs/agents/ci.md` previously documented the two jobs;
this file records why they are gone and what replaced them.

## What this costs

There is no automated verification of anything, on any branch, until the
workflow comes back. Nothing catches a regression before it reaches a user.
`npm run check` has to be run deliberately, and its result has to be recorded on
the pull request, because nothing else will.

Restoring the workflow is a matter of reinstating `.github/workflows/ci.yml`
once billing allows runners to start. The two jobs are unchanged in intent:
fast checks without browser engines, and a separate browser job for the
cross-browser journeys.

## Local verification guidance

Record the exact commit, Node/npm/Playwright versions, ports, runtime directory,
pass/fail/skip counts, and first actionable assertion on every pull request.
Compare browser failures with a fresh `origin/main` baseline before attributing
them to a change.

Separate these cases:

- **Process launch:** the browser process fails before the application starts,
  such as a reproducible `spawn UNKNOWN`. Record the command and environment;
  the historical cause is unconfirmed unless evidence proves it.
- **Port or server reuse:** the configured web or sync port is occupied, or a
  prior server is silently reused. Use isolated unused ports and a unique runtime
  directory; never kill another agent's server.
- **Application failure:** the browser launches and an application assertion,
  request, or sync operation fails. Preserve that failure and diagnose its first
  actionable symptom.
- **Automation limitation:** WebKit emulation is not installed Safari. Service
  workers and audible playback have known limitations, and physical installed-
  Safari checks remain separate evidence.

Outside CI, the browser suite may reuse existing servers
(`reuseExistingServer: !process.env.CI`). Isolate each run instead of relying on
fixed ports, and treat a changed failure count on identical code as
inconclusive until the run is repeated without competing jobs.
