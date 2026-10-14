# PC collection sync attempts

`syncCollection` owns one active transport attempt per `Collection` object and paired connection in the current JavaScript context. Calls from Sync now and Deck offline preparation for that same pair join the active promise; each subscribed caller receives progress, and dropping one observer does not cancel the write. An attempt releases ownership on success, an incomplete result, or failure, so the next call can retry. Separate Collection objects and changed connections may proceed independently.

Before a response changes local records or the sync cursor, Collection checks the connection inside its IndexedDB transaction. A response from an old pairing therefore cannot advance a newer pairing's cursor. The UI also checks the current connection before showing progress or completion from an older attempt. Existing Collection Generation and authentication checks remain in preflight and the PC transport.

This ownership map is per browser JavaScript context. Two tabs do not join one transport attempt. The server's operation identities, Collection Generation checks, and local transactional application remain the cross-tab durability safeguards; this change does not promise a cross-tab lock or global cancellation.
