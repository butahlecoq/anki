import type { Deck } from './collection'

/** One Deck Path rule for both snapshot media selection and package assembly. */
export function selectAnkiExportDecks(decks: readonly Deck[], deckId?: string) {
  const byId = new Map(decks.map((deck) => [deck.id, deck]))
  const paths = new Map<string, string>()
  function path(id: string, seen = new Set<string>()): string {
    const cached = paths.get(id)
    if (cached) return cached
    const deck = byId.get(id)
    if (!deck || seen.has(id)) throw new Error('A deck relationship is missing or cyclic.')
    seen.add(id)
    const value = deck.parentId ? `${path(deck.parentId, seen)}::${deck.name}` : deck.name
    paths.set(id, value)
    return value
  }
  const selectedPath = deckId ? path(deckId) : undefined
  const selected = new Set(decks.filter((deck) => !selectedPath || path(deck.id) === selectedPath || path(deck.id).startsWith(`${selectedPath}::`)).map((deck) => deck.id))
  return { path, selected, selectedPath }
}
