import 'fake-indexeddb/auto'
import { afterAll, test } from 'vitest'
import { createCollection, Rating } from './collection'
import { readCardsForNote, readAnkiExportSnapshot } from './collection-queries'

const rootCount = 32
const childrenPerRoot = 6
const grandchildrenPerChild = 2
const rowsPerDeck = 12
const db = createCollection(`summary-profile-${crypto.randomUUID()}`)
afterAll(async () => { await db.removeLocalCollection() })

test.skipIf(!process.env.SUMMARY_PROFILE)('profile synthetic Deck summaries', async () => {
  const cards: Array<{ id: string; deckId: string }> = []
  for (let rootIndex = 0; rootIndex < rootCount; rootIndex++) {
    const root = await db.createDeck(`Root ${rootIndex}`)
    const decks = [root]
    for (let childIndex = 0; childIndex < childrenPerRoot; childIndex++) {
      const child = await db.createDeck(`Child ${childIndex}`, { parentId: root.id })
      decks.push(child)
      for (let grandchildIndex = 0; grandchildIndex < grandchildrenPerChild; grandchildIndex++) decks.push(await db.createDeck(`Grandchild ${grandchildIndex}`, { parentId: child.id }))
    }
    for (const deck of decks) for (let row = 0; row < rowsPerDeck; row++) {
      const note = await db.createBasicNote(deck.id, { front: `${deck.name}-${row}`, back: 'answer' }, new Date(1_700_000_000_000 + cards.length))
      const card = (await readCardsForNote(db, note.id))[0]
      if (card) cards.push({ id: card.id, deckId: card.deckId })
    }
  }
  for (let index = 0; index < 8; index++) await db.createDeck(`Empty ${index}`)
  const allCards = (await readAnkiExportSnapshot(db)).cards
  for (const [index, card] of allCards.entries()) if (index % 5 === 0) await db.answer(card.id, Rating.Good, new Date(1_700_000_000_000 + index), undefined, { allowEarly: true, reschedule: false })

  await db.summaries() // warm Dexie and storage paths
  const samples: number[] = []
  let count = 0
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    const result = await db.summaries()
    samples.push(performance.now() - start)
    count = result.length
  }
  const medianMs = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  console.log(JSON.stringify({ roots: rootCount, childrenPerRoot, grandchildrenPerChild, decks: rootCount * (1 + childrenPerRoot * (1 + grandchildrenPerChild)) + 8, rowsPerDeck, notes: cards.length, cards: cards.length, reviews: Math.ceil(cards.length / 5), outputDecks: count, medianMs: +medianMs.toFixed(1), samplesMs: samples.map((sample) => +sample.toFixed(1)) }))
}, 120_000)
