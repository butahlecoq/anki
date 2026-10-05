# Native Anki synchronization engine

Issue #61 implements the native boundary for #56. The visible account flow
downloads a separate snapshot and offers an explicit Import Plan to copy the
supported portion into the learner's editable collection. Unsupported notes
stay omitted by a saved local choice on later refreshes; this is not incremental
two-way account synchronization.

## Implemented boundary

`NativeAnkiClient` negotiates legacy protocol 10, keeping account host keys in
private process memory. A supplied transport can use the private gateway from
#59; the independent oracle uses only localhost and generated credentials.
Requests use the official multipart protocol. Responses are capped at 64 MiB.
Transport callbacks receive a fourth `{ signal }` argument and must forward it
to `fetch`. Client and state operations accept optional `{ signal, timeoutMs }`;
each request defaults to a five-minute deadline and cannot exceed it. Deadline
racing covers response headers and streamed body reads, including transports
that ignore cancellation. Distinct `cancelled` and `timeout` errors retain the
recovery boundary; cancellation never proves that the server did not commit.

Native SQLite schema 11 snapshots retain original identities and opaque native
columns. The official server supports a protocol 10 full download from a modern
collection and supplies this schema. Download verifies SQLite/schema and the
delivered revision against post-download metadata: the download itself advances
the official server's mod/usn. Schema changes produce an explicit full-sync
result; no automatic destructive direction is chosen.

Incremental sync applies graves, native configuration and objects, bounded
chunks, sanity checks and finish/abort to a private database copy. Outbound
objects use the server revision. The final local cursor is server USN + 1.
Native tombstones retain review history. Concurrent note/deletion and review
identity conflicts carry both concrete versions without embedding them in the
error message.

`NativeAnkiState` stores snapshots, attempts and conflicts in a separate Dexie
database without credential fields. Failed sessions preserve the checkpoint and
a recovery marker. Successful sync commits a new checkpoint atomically.
Web Locks serialize sessions across pages. Recovery retries stable native
identities after an interrupted page or lost finish response; unresolved
conflicts block retry. State replacement checks the expected revision and
atomically retains the previous checkpoint in the separate `backups` table.
Backups are not automatically pruned; a storage/quota failure aborts replacement.

Exclusive account and media synchronization requires the browser Web Locks API.
If it is missing (including iOS Lockdown Mode), startup fails with a typed
`NativeSyncError('unsupported', ...)` before recording an attempt; the durable
checkpoint, cursor, and pending media remain unchanged. The app does not detect
Lockdown Mode itself; it detects the missing platform capability.

`state.previewFullSync(client, SQL)` binds local SHA-256 and revision to current
remote mod/schema/USN. Pass that preview with an explicit `direction` to
`state.fullSynchronize()` to upload or download. Upload retains local, prepared
upload and remote snapshots durably before its destructive request. It verifies
the expected remote revision immediately before upload and verifies uploaded
native content by downloading it again. The native protocol has no atomic
compare-and-swap upload endpoint; callers should avoid simultaneous full-sync
decisions from multiple clients.

An interrupted full upload keeps its prepared backup and original checkpoint.
`state.recoverFullSync()` verifies remote content and commits a checkpoint only
if it matches; it never automatically sends another destructive upload. A stale
decision or unmatched upload requires a fresh preview and explicit direction.
Interrupted downloads likewise require a new direction decision before local
replacement. `state.restoreBackup(id, expectedRevision)` restores retained local
bytes while retaining the displaced checkpoint and makes no account write.
Low-level client upload/download primitives do not replace these state-backed
user workflow boundaries.

Incoming fields and note-type sort-field changes rebuild native `sfld` and
first-field SHA-1 checksum caches, including decoded entities and preserved
media filenames. The cache text rules are independently compared against the
official backend, rather than treating a nonzero checksum as proof.

`NativeAnkiMedia` uses official multipart `msync` begin/changes/download/upload/
sanity operations. Native filenames and opaque bytes are preserved independently
of the app's supported attachment types. Downloads validate ZIP boundaries,
manifest membership and official SHA-1 content checks before committing bytes
and their media cursor together. A separate SHA-256 is retained and rechecked
before uploads. Uploads use at most 25 entries and target 2.5 MiB; each file is
limited to 63 MiB by the gateway's 64 MiB response boundary. Larger native files
stop explicitly rather than being omitted or renamed.

Media attempts, pending files, cursors and divergent local/account versions
live in a separate Dexie database without credential fields. Interrupted
uploads remain pending and recover by stable filename/hash comparison. Explicit
local/remote conflict resolution preserves the alternate version. Web Locks
serialize media sessions; edits are rejected during an active recovery marker.
Issue #56 now has `src/native-anki-account.ts`, which derives distinct stable
IndexedDB names for the collection checkpoint and media stores from a
normalized AnkiWeb username using a domain-separated SHA-256 digest. The raw
username, password, and session key are not persisted. Closing the stores on
logout retains account data; deleting it must be a separate explicit action.
This namespace is a separation mechanism, not encryption or an authentication
boundary. The visible login/download/Deck-list workflow is implemented in
`src/AnkiWebAccountDialog.tsx`. Native-to-app projection and writeback are also
implemented and verified, but remain unwired to the learner's editable
collection.

## Reproducible evidence

Install official `anki==26.9.3` in an isolated tools virtual environment. Set
`ANKI_TEST_PYTHON` to its Python interpreter, then run:

```powershell
node scripts/verify-native-anki-sync.mjs
npx vitest run src/native-anki-state.test.ts
```

The independent oracle starts an official sync server on an ephemeral localhost
port, creates temporary Japanese collections and fake accounts, and checks:

- Native edits and review history received by the official headless client.
- Official edits received by the native engine and repeated convergence.
- A server finish whose response is deliberately lost, followed by recovery.
- Official note/card deletions with retained review history.
- Official cache interpretation for Japanese/HTML/entities/media filenames.
- Japanese media filename download/upload/deletion and uploads across the
  official maximum 25-file batch boundary.
- Truncated media download rejection without files/cursor commit.
- Divergent media retaining both versions, explicit local resolution and
  convergence observed by the official headless client.
- A lost media upload response, durable reopen and pending-file recovery.
- Note type, deck, option-group and opaque collection configuration changes
  received by the official client.
- Full upload/download verified by native content and official headless reads,
  with local/remote/prepared snapshots retained before upload.
- Backup storage failure preventing upload, stale preview rejection and local
  backup restoration without account writes.
- Lost full-upload response recovery across reopen without a repeated upload.
- Cancellation during an official incremental session, bounded stalled headers
  and stalled body reads, with recoverable checkpoint preservation.
- Divergent dirty cards and dirty-deck/account-deletion conflicts retaining
  concrete native versions instead of silently overwriting or resurrecting.

Temporary oracle collections are removed when its server exits. It does not read
`.env`, connect to the real account or deploy a gateway. The five tests in
`src/native-anki-state.test.ts` cover projection-map durability, checkpoint
recovery after a lost finish response, conflict versions across reopen,
concurrent session/replacement rejection, and safe refusal without Web Locks.
The separate official oracle supplies protocol interoperability evidence.

## Boundaries and remaining account workflow

The engine supports the verified current protocol 10/schema 11 interchange
boundary. Other SQLite versions and upstream stop/upgrade responses fail safely
with the native checkpoint retained. Collection responses/uploads use the
64 MiB gateway boundary; individual media files are limited to 63 MiB. No file
is silently omitted to fit these limits. Future protocol/format expansion and
granular field-level native conflict editing are separate enhancements; native
conflicts currently require an explicit backed-up full-direction decision.

The native projection and writeback boundary in
`src/native-anki-projection.ts` and `src/native-anki-writeback.ts` is implemented
and verified by `src/native-anki-projection.test.ts`. The visible #188 flow
connects an account, downloads a snapshot, and copies a user-selected
representable portion for offline study; it does not upload notes, cards or
study history. Issue #56 still needs incremental synchronization wired into the
collection workflow and installed-iPhone/offline evidence. No real-account
writes have been used as development evidence.

## Primary protocol references

Protocol facts were inspected in the official implementation; the new module
is independently written rather than copied Rust implementation code:

- [Anki syncing manual](https://docs.ankiweb.net/syncing.html)
- [Official collection sync](https://github.com/ankitects/anki/tree/main/rslib/src/sync/collection)
- [Metadata decision boundary](https://github.com/ankitects/anki/blob/main/rslib/src/sync/collection/meta.rs)
- [Chunk wire format](https://github.com/ankitects/anki/blob/main/rslib/src/sync/collection/chunks.rs)
- [Deletion markers](https://github.com/ankitects/anki/blob/main/rslib/src/sync/collection/graves.rs)
- [Sanity checks](https://github.com/ankitects/anki/blob/main/rslib/src/sync/collection/sanity.rs)
- [Official media protocol](https://github.com/ankitects/anki/tree/main/rslib/src/sync/media)
- [Native note caches](https://github.com/ankitects/anki/blob/main/rslib/src/notes/mod.rs)

The pinned server/headless oracle baseline is Anki 26.9.3. Upstream currently
declares sync protocol versions 8 through 11 and minimum collection schema 11;
this engine uses protocol 10 with schema 11, which is inside that window. The
`Latest Anki native sync oracle` workflow installs the newest stable PyPI wheel
each night and checks the boundary constants in a fresh `ankitects/anki` source
checkout. A regression opens or updates a tracker issue with the failing check,
wheel version, and constant diff. This monitor is non-blocking and uses GitHub
Actions only; no external paid runner is configured. If account billing
prevents Actions from starting, the scheduled evidence is unavailable until
that account state changes. Protocol 10 support remains a verified current
interoperability boundary, not a guarantee that upstream will keep it
indefinitely. Future server upgrade responses must stop safely.
