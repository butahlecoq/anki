# Native Anki synchronization engine (in progress)

Issue #61 implements the native boundary for #56. This engine is not yet wired
to the app and does not establish finished AnkiWeb synchronization.

## Implemented boundary

`NativeAnkiClient` negotiates legacy protocol 10, keeping account host keys in
private process memory. A supplied transport can use the private gateway from
#59; the independent oracle uses only localhost and generated credentials.
Requests use the official multipart protocol. Responses are capped at 64 MiB.

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
conflicts block retry. State replacement checks the expected revision.

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
The account UI must select an account-specific storage namespace before using
these state stores; it is not implemented by this protocol boundary.

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

Temporary oracle collections are removed when its server exits. It does not read
`.env`, connect to the real account or deploy a gateway. The three storage tests
cover checkpoint preservation/recovery across reopen, durable conflict versions
and concurrent session/replacement rejection. These storage tests do not prove
protocol interoperability; the separate official oracle supplies that evidence.

## Remaining work before #61 can close

- Full upload, explicit preview/backup boundaries and broader native formats.
- Transport cancellation/deadline contract and richer protocol validation.
- Additional independent conflict/interruption/batch/configuration fixtures.
- Complete recovery/resolution API, including retaining backups before replacing
  a native checkpoint. The UI must not expose replacement without that workflow.

#56 additionally needs native projection into editable app entities, visible
account controls, deployed independent gateway and installed-iPhone evidence
with the PC off. No real-account writes have been used as development evidence.

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

The verified server/headless wheel version is 26.9.3. Protocol 10 support is a
verified current interoperability boundary, not a guarantee that upstream will
keep it indefinitely. Future server upgrade responses must stop safely.
