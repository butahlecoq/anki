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

## Remaining verification

Run the full software gate, the visible generated-account copy journey, and
independent standards/spec review on the final commit. The owner's original
message lacked phase/source details; this reproduces and corrects the real
metadata HTTP 400, but does not retrospectively prove that every original
account attempt failed at this phase. The owner should retry account connection
after the reviewed app/service update and report the sanitized request details
if another phase fails. Physical-iPhone password sign-in, account-copy UI, and
audible playback remain distinct from the automated and cached-auth metadata
evidence.
