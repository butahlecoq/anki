/**
 * The identity scheme shared by every direction of Anki package interchange.
 *
 * Anki's formats identify decks, note types, notes and reviews by number, while
 * this app addresses them by string. An entity that arrived from a package
 * carries that Native Identity, and its app identity is the number behind the
 * scheme prefix: `anki-deck:1700000000010`.
 *
 * An entity the app creates for itself has no number to carry, so one is derived
 * from a stable seed. The derivation is a pure function of the seed, which is
 * what lets two devices, and two round trips, reach the same identity.
 *
 * See docs/adr/0001-synthesised-deck-identity.md.
 */

/** The app identity of an entity that arrived from a package. */
export function nativeIdentity(kind: string, source: string | number) {
  return `anki-${kind}:${source}`
}

/**
 * A deterministic safe integer for a seed that carries no Native Identity.
 * Identical across devices and runs, so relationships survive repeated exports.
 */
export function derivedNativeId(seed: string) {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(seed)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return Number(hash % 700_000_000_000n) + 1_000_000_000_000
}

/**
 * The identity form a deck took before its identity was derived from its Deck
 * Path. Still present in collections imported before ADR 0001, and reconciled
 * at import time rather than by a migration.
 */
export function legacyDeckIdentity(identity: string) {
  return identity.startsWith('anki-deck-path:')
}

/**
 * The Native Identity to write into a package: the number an identity already
 * carries, or one derived from the identity itself when it carries none.
 */
export function nativeIdOf(identity: string, kind: string) {
  const carried = identity.startsWith(`anki-${kind}:`) ? Number(identity.slice(`anki-${kind}:`.length)) : Number.NaN
  return Number.isSafeInteger(carried) && carried > 0 ? carried : derivedNativeId(identity)
}