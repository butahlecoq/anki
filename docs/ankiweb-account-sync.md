# Existing AnkiWeb account sync

The user requires two-way synchronization with their existing AnkiWeb account. The supported topology and whether the PC must be running are tracked by #186. This supersedes the original package-only compatibility scope. Issue #56 tracks the complete feature. The current app's **Connect a PC** service uses Kiroku's own protocol and does not synchronize an AnkiWeb account.

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

## Private gateway transport (#59)

`server/ankiweb-gateway.ts` provides a portable Fetch handler. It streams known protocol routes to official `sync.ankiweb.net`/numbered sync hosts, checks a configured HTTPS caller origin and a separate 256-bit key, strips gateway credentials/cookies, refuses redirects, and bounds each direction to 64 MiB and five minutes. It has no collection store and emits no logs. It is not the complete account-sync feature: native collection mapping, incremental merge, full-sync previews, media reconciliation, and visible connection UI remain under #56.

An authenticated personal HTTPS gateway can remain available independently of the PC. A Cloudflare Workers Free deployment is one option; its [documented limits](https://developers.cloudflare.com/workers/platform/limits/) include daily request and resource limits. Keep the account on the Free plan; reaching limits must fail rather than require paid upgrades. Cloudflare processes account traffic in transit, so this is a personal deployment decision. No service is deployed by this repository change.

### Prepare a deployment

1. Set `PWA_ORIGIN` in `wrangler.ankiweb.jsonc` to the exact trusted HTTPS app origin, without a trailing slash or path. It is a public origin, never an account credential.
2. Generate a random 32-byte hex gateway key locally. Store it as the Worker's `GATEWAY_KEY` secret using `npx wrangler secret put GATEWAY_KEY --config wrangler.ankiweb.jsonc`. Do not use the AnkiWeb password as this key. The app's eventual connection flow must request the gateway key at runtime; it must never be bundled with Vite.
3. Before publishing, inspect the bundle using `npx wrangler deploy --config wrangler.ankiweb.jsonc --dry-run`. The worker entry imports no `.env`, filesystem, collection or server code.
4. When deploying the reviewed configuration, use `npx wrangler deploy --config wrangler.ankiweb.jsonc`. Only authenticated requests from the configured origin are accepted. Do not enable request/body/header logging.

Requests use `/ankiweb/sync/<method>` or `/ankiweb/msync/<method>`, the `X-Kiroku-Gateway-Key` header, and optionally `X-AnkiWeb-Host` for a numbered official host returned by protocol negotiation. The gateway forwards only Content-Type, Anki-Sync and Authorization. Native protocol credentials remain in those protocol headers/body; the independent gateway key is never forwarded. Interrupted/oversized response streams fail while being read: a 200 response header alone does not prove a complete transfer. Sync code must await and validate the complete payload before committing changes.

### Outstanding acceptance

- Implement native identities/revisions and actual two-way account sync; package interchange alone is insufficient.
- Prove protocol behavior with the official engine and isolated collections, including response loss, concurrent official-client work, media and full-sync direction conflicts.
- Confirm the personal gateway works from installed iPhone Safari with PC off. Deployment and physical-device evidence are outstanding.
- Provide explicit backups and reviewable direction choices before any real account collection mutation. Development must not overwrite the user's live account.
