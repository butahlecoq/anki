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

## Known environment gaps

- **#85** — Playwright cannot complete a sync pairing on this host. Six
  desktop-chromium specs fail on clean `main` with *"PC connected"* never
  appearing. Compare a browser run against a clean `origin/main` baseline before
  attributing any browser failure to a change.
- The browser suite reuses existing servers outside CI
  (`reuseExistingServer: !process.env.CI`) on fixed ports 4173 and 4174, so
  leftover servers from an earlier run can silently change the result. Run
  serially, and treat a run whose failure count differs from a previous run on
  identical code as inconclusive rather than as a signal.