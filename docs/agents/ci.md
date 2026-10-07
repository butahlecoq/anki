# Continuous integration

The owner made `butahlecoq/anki` public on 8 October 2026 and authorized restoring
GitHub Actions. This supersedes the old private-source requirement in parent #1.
Learner collections, credentials and deployment runtime remain private and local;
public source does not publish a learner's running PC service.

## Hosted software gate

`.github/workflows/ci.yml` runs **Complete software gate** on pull requests,
pushes to `main`, and manual dispatch. It installs Node 22, npm 11.16.0, Python
3.13 and the pinned Chromium/WebKit engines. The official Anki 26.9.3 wheel
generates a synthetic collection package and supplies the native sync oracle.
No owner account, private package, deployment credential or service is used.

The steps run `npm run check:push` (typecheck, lint, unit, tracker and server
tests), `npm run build`, then `npm run test:e2e -- --workers=1` against isolated
production app/service ports and runtime. These are the same checks as the local
`npm run check`, with one browser worker chosen explicitly for the hosted runner.
The job has a 45-minute timeout and cancels superseded runs on the same PR/ref.
Actions are pinned to verified commit hashes and the job has read-only contents
permission; checkout does not retain credentials and fetches full history for
the tracker tests that inspect `origin/main` and merge bases.

Standard GitHub-hosted runners in public repositories are free according to
[GitHub's billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Private repositories also receive an allowance; the earlier account billing
failure was not evidence that all private Actions require payment. This workflow
uses the standard `ubuntu-24.04` runner and disables uv caching. It neither
uploads artifacts nor configures an Actions cache because storage is billed
separately. Failure diagnostics remain in job logs; Playwright reports and traces
are available during the job and can be reproduced locally. Do not switch to a
larger runner or enable paid storage as a routine fix.

`main` requires pull requests, resolved conversations and the successful
**Complete software gate** check, including for administrators. Force pushes
and branch deletion are disabled. Zero mandatory GitHub approval counts allow
the owner's autonomous workflow; the independent Standards/Spec review and the
acceptance-evidence gate still apply before merging. No `master` branch currently
exists. Protect any future default branch equivalently before using it.

The existing scheduled latest-Anki-wheel monitor is separate and non-blocking.
It reports upstream regressions as issues; it is not the pinned release gate.

## Local verification and acceptance

Run `npm run check` locally for the complete software gate. Record the exact
commit, Node/npm/Playwright versions, ports, runtime, pass/fail/skip counts and
first actionable failure on each PR. `npm run premerge -- <PR-number>` remains
the separate local acceptance-evidence gate. Hosted CI does not prove issue
criteria by itself and GitHub does not run that local tracker guard.

Use unused ports and a fresh synthetic runtime. Never reuse or stop the owner's
service to test a change. Distinguish process-launch failures, port collisions,
application assertions and automation limitations. Compare any unexplained
browser failure with the same current `origin/main` baseline.

WebKit emulation is not installed iOS Safari. Declared cold service-worker and
audio limits and physical iPhone installation, audible playback and storage
retention remain separate evidence. A passing hosted job cannot establish those
physical observations. Keep skips visible in reports.
