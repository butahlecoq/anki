# Existing AnkiWeb account sync

The visible **Connect AnkiWeb account** flow sends the learner's credentials through the paired PC service, downloads a native collection snapshot and verified account media into separate account-specific local stores, and offers an explicit Import Plan to copy supported content into the editable Kiroku collection for offline study. Media bytes are checked against account hashes before their cursor is committed. Static template assets and note attachments are imported as local bytes; repeated bytes are deduplicated while filename-specific content remains intact. Unsupported notes and their dependent cards, reviews, and media references are listed; import stays blocked until the learner chooses to import the representable portion. That choice is saved with the local collection and reused on later refreshes. Import never uploads notes, cards, or study history to AnkiWeb. The username, password, and returned account key stay in memory; the paired-device token is stripped before requests reach AnkiWeb. Disconnecting closes the in-memory session while retaining the downloaded account collection and media.

The native engine separately implements incremental collection sync, full-sync previews and recovery, media reconciliation, and native-to-Kiroku projection/writeback. Sync, full-sync, and media protocol behavior is checked against the official engine by the oracle below. Projection and writeback are verified with schema-11 native collection fixtures in `src/native-anki-projection.test.ts`; incremental synchronization and writeback remain outside the learner-facing account workflow. Issue #56 tracks that integration and complete two-way synchronization. The supported relay runs on the learner's own PC and requires it to be running and reachable for account transfers. A downloaded account collection and imported supported content remain available for offline study while the PC is off. ADR 0004 records this topology; no always-on third-party relay is operated.

## Protocol and connectivity findings

The [official client](https://github.com/ankitects/anki/blob/main/rslib/src/sync/http_client/mod.rs) uses native HTTPS requests with a protocol header and separate collection/media routes. The [official sync manual](https://docs.ankiweb.net/syncing.html) describes initial one-way synchronization, subsequent merges, and format conflicts that can require replacing one side. The app must preserve native IDs and sync revision metadata, not merely translate an exported package on each sync.

On 2026-10-01, a credential-free OPTIONS probe to `https://sync.ankiweb.net/sync/meta` with an unrelated Origin returned 405 and no Access-Control-Allow-Origin. This demonstrates a CORS obstacle for that transport; it does not establish that every endpoint or protocol version was probed. A separate read-only hostKey login succeeded with credentials from ignored local `.env`; its token was discarded without collection requests or writes. No credentials are included in this document.

### Browser POST measurement (2026-10-04, issue #179)

Reproduce from the repository root with `node scripts/probe-ankiweb-browser-cors.mjs`. The script opens a headless Chromium page on an ephemeral localhost origin and POSTs only unauthenticated protocol metadata (`v`, client version, and continuation flag) to `/sync/meta`. It sets no cookies, account key, session key, or collection data and discards response bodies. It also sends the same multipart POST through Node HTTPS with the exact browser Origin so the complete response header names, values and order can be retained even when Chromium correctly hides the response from page JavaScript.

Both the base provider host and numbered provider `sync1.ankiweb.net` returned HTTP 400. Chromium observed `MissingAllowOriginHeader` on each response and rejected `fetch()` with `TypeError: Failed to fetch`. Thus a page cannot read the protocol response directly: no `Access-Control-Allow-Origin` permitting the calling origin is present. The failed metadata request is unauthenticated and contains no collection data; HTTP 400 reflects request rejection and does not imply account access.

Captured complete response headers from the direct HTTPS POST to `sync.ankiweb.net`:

```text
Server: nginx
Date: Sun, 04 Oct 2026 19:25:03 GMT
Content-Type: text/plain; charset=utf-8
Content-Length: 3
Connection: keep-alive
X-Frame-Options: SAMEORIGIN
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
```

Captured complete response headers from the direct HTTPS POST to `sync1.ankiweb.net`:

```text
Server: nginx
Date: Sun, 04 Oct 2026 19:25:04 GMT
Content-Type: text/plain; charset=utf-8
Content-Length: 3
Connection: keep-alive
X-Frame-Options: SAMEORIGIN
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
```

The browser's own network observer reported HTTP 400 and `MissingAllowOriginHeader` for both hosts. The earlier OPTIONS-only evidence is superseded by this protocol POST measurement. Direct browser-to-AnkiWeb synchronization therefore requires a CORS-capable intermediary; ADR 0004 records the supported private-PC relay topology.

## Relay transport component (#59)

`server/ankiweb-gateway.ts` provides a storage-free Fetch request forwarder. The paired PC service mounts it at `/api/ankiweb/*`, validates the configured app origin and the existing paired-device credential on every request, and does not forward that credential. It streams known protocol routes to official `sync.ankiweb.net`/numbered sync hosts, refuses redirects, and bounds each direction to 64 MiB and five minutes. It does not log or retain account traffic. A learner does not configure a gateway URL or second relay key. The native incremental engine, full-sync preview/recovery, media reconciliation, and collection projection/writeback are implemented and verified; links to their code and evidence are in [the native engine notes](native-anki-engine.md). The account dialog provides login, collection snapshot download, explicit media download/verification, preview, and import.

Requests use `/api/ankiweb/sync/<method>` or `/api/ankiweb/msync/<method>` and optionally identify `syncN.ankiweb.net` when protocol negotiation returns a numbered host. The paired relay forwards only Content-Type, Anki-Sync, and the account Authorization header; it strips the paired-device token, refuses redirects, and does not retain account data or log requests. Interrupted or oversized response streams fail while being read: a 200 response header alone does not prove a complete transfer. Sync code must await and validate the complete payload before committing changes. The server mounts this route behind paired-device authentication.

### Protocol compatibility evidence

Protocol behavior has been verified against isolated collections and fake accounts with the official engine; no live account was used. Reproduce the pinned oracle with `node scripts/verify-native-anki-sync.mjs` (install `anki==26.9.3` in an isolated tools environment and set `ANKI_TEST_PYTHON`). The [scheduled latest-wheel workflow](../.github/workflows/native-anki-latest-wheel.yml) runs the same oracle nightly against the newest stable wheel, alongside an upstream boundary check. The oracle covers incremental merge, interrupted responses and recovery, media changes/conflicts, full-sync direction previews, and backup/restore. Projection/writeback are covered by the fixture suite identified above.

### Remaining account-workflow acceptance

- Expose incremental collection synchronization, full-sync previews, recovery, and backups as learner-facing actions.
- Confirm the account flow from installed iPhone Safari through the private PC relay while the PC is running. Confirm offline study after the PC is stopped as a separate journey. Deployment and physical-device evidence are outstanding.
- Do not use the user's live account as development evidence or perform account writes without the explicit backed-up learner workflow.
