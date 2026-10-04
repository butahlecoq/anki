# Existing AnkiWeb account sync

The user requires two-way synchronization with their existing AnkiWeb account. The browser cannot read AnkiWeb's protocol response directly (#179), so the supported relay runs on the learner's own PC as part of the Kiroku service and is reached over the private network. Account synchronization requires that PC to be running and reachable. A downloaded collection remains available for offline study while the PC is off. No always-on third-party relay is operated; an internet-facing relay for PC-off account sync would have to be operated and funded by each learner. ADR 0004 records this topology; #188 wires the first visible account path. Issue #56 tracks the full account-sync feature. The current app's **Connect a PC** service uses Kiroku's own protocol and does not yet synchronize an AnkiWeb account.

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

The browser's own network observer reported HTTP 400 and `MissingAllowOriginHeader` for both hosts. The earlier OPTIONS-only evidence is superseded by this protocol POST measurement. Direct browser-to-AnkiWeb synchronization therefore requires a CORS-capable intermediary; current architecture and deployment choices remain subject to #186 and #188.

## Relay transport component (#59)

`server/ankiweb-gateway.ts` is an unmounted, storage-free Fetch request forwarder. It streams known protocol routes to official `sync.ankiweb.net`/numbered sync hosts, checks a configured HTTPS caller origin and a separate 256-bit key, strips gateway credentials/cookies, refuses redirects, and bounds each direction to 64 MiB and five minutes. The supported application path will mount the forwarder inside the learner's PC service and authorize it with that service's existing paired-device credential; the extra gateway key is not part of the learner setup. #188 owns that integration. Native collection mapping, incremental merge, full-sync previews and media reconciliation remain outstanding under #56.

Requests use `/ankiweb/sync/<method>` or `/ankiweb/msync/<method>` and optionally identify `syncN.ankiweb.net` when protocol negotiation returns a numbered host. The relay forwards only Content-Type, Anki-Sync and Authorization, refuses redirects, and does not retain account data or log requests. Interrupted/oversized response streams fail while being read: a 200 response header alone does not prove a complete transfer. Sync code must await and validate the complete payload before committing changes. The existing separate-key handler must be mounted behind paired-device authentication before it is a supported learner-facing path.

### Outstanding acceptance

- Implement native identities/revisions and actual two-way account sync; package interchange alone is insufficient.
- Prove protocol behavior with the official engine and isolated collections, including response loss, concurrent official-client work, media and full-sync direction conflicts.
- Confirm account sync from installed iPhone Safari through the private PC relay while the PC is running. Confirm offline study after the PC is stopped as a separate journey. Deployment and physical-device evidence are outstanding.
- Provide explicit backups and reviewable direction choices before any real account collection mutation. Development must not overwrite the user's live account.
