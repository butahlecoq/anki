# AnkiWeb metadata client identifier — #234

## Confirmed failure and cause

The deployed source at `496a4c3` and the diagnostics branch at `928a393` send
`{ v: 10, cv: 'kiroku,0.1,web' }` to `sync/meta`. A Node FormData request matching
that request returns HTTP 400 from actual AnkiWeb with the existing desktop
profile's cached authentication. No account details or key values were shown or
saved. Preferences were opened read-only with a restricted unpickler.

An independent official Anki 26.9.3 `Collection.sync_status` check succeeded with
that same profile, establishing that its cached authentication is usable. That
check used a temporary empty collection, which was removed afterwards; the
owner's collection was not opened or changed.

Controlled metadata-only comparisons isolate the client-family token:

| Comparison | Result |
| --- | --- |
| Protocol 10, original `kiroku` identifier | HTTP 400 |
| Protocol 11, original `kiroku` identifier | HTTP 400 |
| Protocol 11, official header identifier but original metadata identifier | HTTP 400 |
| Protocol 11, original header identifier but official metadata identifier | HTTP 200, valid metadata |
| Protocol 11, `anki` family with version `0.1.0` | HTTP 200, valid metadata |
| Protocol 11, `anki` family with platform `web` | HTTP 200, valid metadata |
| Protocol 11, `kiroku` family with current compatibility version and Windows platform | HTTP 400 |
| Protocol 10, official metadata identifier | HTTP 200, valid metadata |

The official client's generated request was inspected using a local HTTP
receiver and a generated key. Its metadata identifier is
`anki,26.09.3 (29bb700b),windows`. The public
[MetaRequest source](https://github.com/ankitects/anki/blob/26.09.3/rslib/src/sync/collection/meta.rs)
defines the `v` and `cv` fields. The production comparisons above are the
evidence for accepting the `anki` family; the public self-hosted server's
behavior alone does not establish that production requirement.

## Correction and regression

The metadata identifier becomes `anki,0.1.0 (kiroku),web`: an accepted protocol
family, the actual application version, explicit Kiroku identification, and the
web platform. Protocol 10 and multipart framing stay in use.

`checks account metadata through the paired relay with an accepted client
family and Kiroku identification` in `src/native-anki-http-errors.test.ts`
uses the public NativeAnkiClient and paired relay boundaries. Its synthetic
upstream rejects the confirmed unsupported family with HTTP 400. Before the
correction it failed with `sync/meta`, status 400, source `upstream`; afterwards
all four tests in that file passed.

The compiled patched NativeAnkiClient then called real AnkiWeb's metadata
endpoint using the cached authentication: HTTP 200, valid metadata, and
`cont: true`. Only its login transport was replaced to supply the existing key;
this does **not** verify password sign-in. No collection upload/download,
account media transfer, or remote sync transaction was performed.

A final comparison through the same public compiled NativeAnkiClient changed
only the first client-family token, retaining protocol 10, version, Kiroku
marker, platform, multipart body, and authentication. `kiroku` returned HTTP
400 at `sync/meta`, source `upstream`, phase `collection check`; `anki` returned
HTTP 200 with continuation allowed. The patched client also received valid
HTTP 200 media initialization metadata from real `msync/begin`, with zero
files transferred. This still does not verify password sign-in or account copy
against production.

## Visible failure, reload, and retry

The existing official-account browser journey now creates a non-sensitive
local note, records its visible stable card identity and pending-change
inventory, and pairs through the real temporary PC service. The fixture rejects
unknown metadata client families and fails the first accepted metadata request
once with HTTP 400, then forwards subsequent requests to official Anki 26.9.3's
isolated self-hosted server. Existing media responses remain synthetic.

The journey checks the actionable route/phase, cleared password input, unchanged
local identity and pending work across failure and reload, successful retry,
Import Plan, representable-only collection copy, credential persistence audit,
unchanged local note after the copy, and offline study of the imported material.
With a persistent isolated `anki==26.9.3` interpreter, it passed in desktop
Chromium: **1 passed in 15.8 seconds**. Command:

```powershell
$env:ANKI_TEST_PYTHON = (Resolve-Path runtime/anki-26.9.3-tools/Scripts/python.exe).Path
$env:KIROKU_WEB_PORT = '4180'
$env:KIROKU_SYNC_PORT = '4181'
npx playwright test tests/e2e/ankiweb-account.spec.ts --project=desktop-chromium --output=runtime/234-account-metadata-retry-complete
```

Log: `account-metadata-retry-complete.log`. An earlier attempt reached the copy
successfully, then failed because the expanded test was on Browse while looking
for a deck-opening button. The test now explicitly visits Decks after verifying
that the original note remains. Its retained failure artifacts are in
`runtime/234-account-metadata-retry`. This fixture evidence is distinct from
the real-production cached-auth metadata checks above.

## Current-session WebKit coverage and UI integration

PR #242 merged the #235 UI and test corrections into `0f3e181`. This branch is
rebased onto that commit. The older shared sample-card/button commit is dropped
because both changes are already present on main; the shared files match main.
The deployed app manifest and service health still report `496a4c3c2355` on
2026-10-07. Repository integration has not updated the running deployment.

The account journey now runs current-session coverage in both browser projects
and keeps the cold-reload variant separate. WebKit therefore verifies failure,
local note identity/pending work after reload, retry, account media verification,
Import Plan, representable-only copy, credential persistence audit, and warm
offline study. Only its cold-reload variant retains the explicit platform skip.

A controlled one-token rollback changes the accepted metadata family back to
`kiroku`, retaining protocol/version/marker/platform. The first run stopped at a
test wording mismatch: the UI identifies the upstream as "AnkiWeb", rather than
the literal "upstream". That run is not the retry regression proof. After the
assertion matches the public UI, WebKit reproduces the intended persistent HTTP
400 at `sync/meta`: local work survives the initial failure and reload, but
retry cannot display the account decks. Evidence: `warm-account-family-retry-red.log`
and `runtime/234-warm-account-family-retry-red`.

Restoring the accepted family produces **3 passes and 1 explicit WebKit
cold-reload skip in 45.6 seconds**. Command: `npx playwright test
tests/e2e/ankiweb-account.spec.ts --output=runtime/234-warm-account-green`, with
the pinned interpreter and isolated ports 4180/4181. Log:
`warm-account-green.log`. Both WebKit viewport screenshots were inspected: the
metadata error includes phase, route, source-identifying service name and build;
the successful representable copy message is readable in the scrollable dialog.
These images contain only generated fixture data. Media source preservation
does not establish audible playback.

The viewport attachment records Chromium configured/actual 1280 × 720, DPR 1.
Windows WebKit's standard iPhone project is configured 390 × 664 but measures
312 × 531, DPR 3.75. This is the normal phone project, not the calibrated all-page
design audit. Viewport records and the focused HTML report are preserved locally.
Focused diagnostic/message suites pass **8 tests**; focused ESLint and diff
checks pass. A final complete gate and independent review on the new commit
remain required before acceptance or merge.

## Remaining verification

The independent spec review of `16af303` found one evidence gap: the test did
not recheck pending local work immediately after successful retry, before
importing new content. The inventory assertion now compares that stage with
the original local-work inventory. All account journeys pass again: **3 passed,
1 explicit WebKit cold-reload skip, 45.0 seconds**,
`pending-after-retry-green.log`, `runtime/234-pending-after-retry-green`.

The full check on `16af303` had stopped in the unit phase: its copied official
package lacked the required `runtime/anki-26.09.3.json` sidecar. It reports
692 unit passes, 3 skips and one missing-file failure; browsers did not start.
The matching sidecar was restored from the verified #235 archive (SHA256
`8658476ff4b7150e8e7f2997192a0e54adc925e3a0a570d4435e2f6fcabc56dd`). With the
package environment variable enabled, the focused official import regression
passes (1 selected test; 24 filtered out). This corrects fixture setup; it is
not a product change or a passing full gate. A fresh complete run on the new
commit is still required.

Run the full software gate and independent standards/spec review on the final
commit. The owner's original
message lacked phase/source details; this reproduces and corrects the real
metadata HTTP 400, but does not retrospectively prove that every original
account attempt failed at this phase. The owner should retry account connection
after the reviewed app/service update and report the sanitized request details
if another phase fails. Physical-iPhone password sign-in, account-copy UI, and
audible playback remain distinct from the automated and cached-auth metadata
evidence.
