# Deck media verification workload

The deterministic `src/deck-media-verification.test.ts` fixture creates one Deck with 12 distinct eight-byte media bodies and a second reference to the first digest. It measures `verifiedMediaBlob` calls and the `crypto.subtle.digest` calls made by `readDeckOfflineMedia`. Gates hold the first four reads, then the first four hashes, so the peaks reflect concurrent work rather than scheduler timing.

| First readiness read | Result |
| --- | ---: |
| Distinct digests / references | 12 / 13 |
| Body fetch calls / fetched bytes | 12 / 96 |
| Digest calls / hashed bytes | 12 / 96 |
| Peak concurrent body reads / hashes | 4 / 4 |
| Readiness | ready, 12 required, 0 missing |

After an unrelated note-text edit, a second readiness read reports the same result and performs zero additional digest calls. The current Collection query still fetches each body to read its content version, so this is a hash-work saving, not a claim of reduced transfer or memory use on that second read. The version is assigned on Collection media writes; rows without one are hashed conservatively. `inspectDeckOfflineMedia` and explicit preparation always hash, including for out-of-band corruption that does not update a content version.

The in-memory verification cache retains at most 256 recent digests per Collection. Preparation evicts a corrupt body only if its stored content version still matches the bytes just checked; a concurrent replacement is rechecked on the next pass.

The fixture compares the caller-visible result with the literal readiness expectations in `src/deck-media-readiness.test.ts` and `src/deck-readiness.test.tsx`. No elapsed-time or speedup claim is made. Run with `npx vitest run src/deck-media-verification.test.ts src/deck-media-readiness.test.ts src/deck-readiness.test.tsx`.
