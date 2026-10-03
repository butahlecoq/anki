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

const scheme = (kind: string) => `anki-${kind}:`

/** The app identity of an entity that arrived from a package. */
export function nativeIdentity(kind: string, source: string | number) {
  return `${scheme(kind)}${source}`
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
 * The number to write into a package: the one an identity already carries, or
 * one derived from the identity itself when it carries none.
 */
export function nativeNumberOf(identity: string, kind: string) {
  const prefix = scheme(kind)
  const carried = identity.startsWith(prefix) ? Number(identity.slice(prefix.length)) : Number.NaN
  return Number.isSafeInteger(carried) && carried > 0 ? carried : derivedNativeId(identity)
}

/**
 * The identity of a deck a package names only inside a Deck Path, derived from
 * that path so a Synthesised Deck is exchangeable like any other deck.
 */
export function deckIdentity(deckPath: string) {
  return nativeIdentity('deck', derivedNativeId(`deck-path:${deckPath}`))
}

/**
 * Whether a deck still carries the identity form it took before its identity
 * was derived from its Deck Path. Present in collections imported before ADR
 * 0001, and reconciled at import time rather than by a migration.
 */
export function hasLegacyDeckIdentity(identity: string) {
  return identity.startsWith('anki-deck-path:')
}
