import { expect, test } from 'vitest'
import { Rating, State, type CardRecord, type Deck, type Note, type NoteType, type ReviewEntry } from './collection'
import { collectionSearchRows, compileCollectionSearch, plainField, SearchSyntaxError } from './collection-search'

const now = new Date(2026, 9, 1, 12)
const timestamp = now.toISOString()
const decks: Deck[] = [
  { id: 'jp', name: 'Japanese', parentId: null, optionGroupId: 'default', createdAt: timestamp, updatedAt: timestamp },
  { id: 'core', name: 'Core vocabulary', parentId: 'jp', optionGroupId: 'default', createdAt: timestamp, updatedAt: timestamp },
]
const noteTypes: NoteType[] = [{ id: 'basic-reversed', name: 'Basic reversed', kind: 'standard', protected: false, fields: [{ id: 'front', name: 'Expression' }, { id: 'back', name: 'Meaning' }], templates: [{ id: 'recognition', name: 'Recognition', front: '{{Expression}}', back: '{{Meaning}}', css: '' }, { id: 'production', name: 'Production', front: '{{Meaning}}', back: '{{Expression}}', css: '' }], createdAt: timestamp, updatedAt: timestamp }]
const notes: Note[] = [
  { id: 'cat', deckId: 'core', type: 'custom', typeId: 'basic-reversed', fields: { front: '<b>猫</b>', back: 'cat &amp; kitten' }, tags: ['jlpt::n5', 'animal'], createdAt: timestamp, updatedAt: timestamp },
  { id: 'dog', deckId: 'jp', type: 'custom', typeId: 'basic-reversed', fields: { front: '犬', back: 'dog' }, tags: ['animal'], createdAt: timestamp, updatedAt: timestamp },
  { id: 'empty', deckId: 'jp', type: 'custom', typeId: 'basic-reversed', fields: { front: 'no cards', back: '' }, createdAt: timestamp, updatedAt: timestamp },
]
function card(id: string, noteId: string, overrides: Partial<CardRecord> = {}): CardRecord {
  return { id, noteId, deckId: noteId === 'cat' ? 'core' : 'jp', templateId: 'recognition', due: timestamp, state: State.Review, stability: 10, difficulty: 5, elapsedDays: 0, scheduledDays: 10, learningSteps: 0, reps: 2, lapses: 0, lastReview: timestamp, ...overrides }
}
const cards = [card('cat-front', 'cat', { flag: 3 }), card('cat-back', 'cat', { state: State.New, templateId: 'production' }), card('dog-front', 'dog', { manualSuspended: true })]
const reviews: ReviewEntry[] = [{ id: 'review-1', cardId: 'cat-front', deckId: 'core', rating: Rating.Again, state: State.Review, due: timestamp, stability: 10, difficulty: 5, elapsedDays: 2, lastElapsedDays: 0, scheduledDays: 10, learningSteps: 0, reviewedAt: new Date(2026, 8, 30, 23, 59).toISOString() }]
const rows = collectionSearchRows({ decks, notes, noteTypes, cards, reviews })
const find = (query: string) => rows.filter(compileCollectionSearch(query, now)).map((row) => row.card?.id ?? row.note.id)

test('Japanese text, HTML entities, grouping, OR, negation, and quoted values compose', () => {
  expect(find('猫')).toEqual(['cat-front', 'cat-back'])
  expect(find('"cat & kitten"')).toEqual(['cat-front', 'cat-back'])
  expect(find('(猫 OR 犬) -is:suspended')).toEqual(['cat-front', 'cat-back'])
  expect(find('猫 OR 犬 is:suspended')).toEqual(['cat-front', 'cat-back', 'dog-front'])
  expect(find('deck:"Japanese::Core vocabulary" is:new')).toEqual(['cat-back'])
  expect(find('"OR"')).toEqual([])
  expect(find('')).toHaveLength(4)
})

test('deck descendants, tags, type, flag, and template match stable joined records', () => {
  expect(find('deck:Japanese')).toHaveLength(4)
  expect(find('deck:core tag:jlpt::* note:"Basic reversed" flag:3 card:Recognition')).toEqual(['cat-front'])
  expect(find('card:Production')).toEqual(['cat-back'])
  expect(find('flag:0 is:new')).toEqual(['cat-back'])
  expect(find('tag:anima?')).toEqual(['cat-front', 'cat-back', 'dog-front'])
})

test('state and date searches distinguish new, suspended, buried, and due cards', () => {
  expect(find('is:due')).toEqual(['cat-front'])
  expect(find('due:2026-10-01')).toEqual(['cat-front', 'dog-front'])
  expect(find('due:<2026-10-01')).toEqual([])
  expect(find('due:>=2026-10-01')).toEqual(['cat-front', 'dog-front'])
  const buried = { ...rows[0], card: { ...cards[0], buriedUntil: new Date(2026, 9, 2).toISOString() } }
  expect(compileCollectionSearch('is:buried -is:due', now)(buried)).toBe(true)
  expect(compileCollectionSearch('is:learn', now)({ ...rows[0], card: { ...cards[0], state: State.Relearning } })).toBe(true)
})

test('history predicates use per-card ratings and local calendar boundaries', () => {
  expect(find('rated:2:1')).toEqual(['cat-front'])
  expect(find('rated:1')).toEqual([])
  expect(find('reviewed:2026-09-30')).toEqual(['cat-front'])
  expect(find('reviewed:>=2026-10-01')).toEqual([])
  expect(find('rated:7:3')).toEqual([])
})

test.each([
  ['cat OR', 6], ['(cat', 4], ['cat)', 3], ['deck:"Japanese', 0], ['flag:8', 0], ['unknown:value', 0], ['due:2026-02-30', 0], ['is:wrong', 0], ['rated:0', 0], ['()', 1],
])('invalid search %s returns an actionable source position', (query, position) => {
  try { compileCollectionSearch(query, now); throw new Error('Search unexpectedly accepted') }
  catch (error) { expect(error).toBeInstanceOf(SearchSyntaxError); expect((error as SearchSyntaxError).position).toBe(position); expect((error as Error).message.length).toBeGreaterThan(10) }
})

test('bounded search parsing rejects excessive length and nesting', () => {
  expect(() => compileCollectionSearch('a'.repeat(4001))).toThrow('4,000')
  expect(() => compileCollectionSearch('('.repeat(34) + 'cat' + ')'.repeat(34))).toThrow('nested levels')
})

test('literal display text decoding preserves non-HTML content without executing it', () => {
  expect(plainField('<b>猫</b> &amp; &#x72ac; &#34;')).toBe(' 猫  & 犬 "')
  expect(plainField('&#9999999999999;')).toBe('&#9999999999999;')
})
