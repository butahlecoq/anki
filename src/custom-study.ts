import type { CardRecord, Collection, Grade } from './collection'
import { isRenderedCardEmpty, renderNoteCard } from './card-rendering'
import { collectionSearchRows, compileCollectionSearch, type SearchRow } from './collection-search'
import { customStudyKey, customStudySessions, type CustomStudySession } from './custom-study-state'
import { eligibleForQueue } from './scheduler'

export type CustomStudyDefinition = Pick<CustomStudySession, 'name' | 'search' | 'limit' | 'order' | 'reschedule'>
function renderable(row: SearchRow, now: Date) {
  if (!row.card || !row.noteType || !eligibleForQueue(row.card, now)) return false
  const template = row.noteType.templates.find((entry) => entry.id === row.card!.templateId)
  if (!template) return false
  if (row.noteType.kind === 'image-occlusion') return true
  return !isRenderedCardEmpty(renderNoteCard(row.noteType, template, row.note.fields, row.card.clozeOrdinal))
}
function rank(value: string) {
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}
export async function previewCustomStudy(db: Collection, definition: CustomStudyDefinition, now = new Date(), sessionId = '') {
  if (!definition.name.trim() || definition.name.trim().length > 100) throw new Error('Use a session name of 1–100 characters.')
  if (!Number.isInteger(definition.limit) || definition.limit < 1 || definition.limit > 5000) throw new Error('Card limit must be a whole number from 1 to 5,000.')
  if (!['due', 'added', 'random', 'forgotten'].includes(definition.order)) throw new Error('Choose a supported card order.')
  if (typeof definition.reschedule !== 'boolean') throw new Error('Choose whether these reviews change scheduling.')
  const matches = compileCollectionSearch(definition.search, now)
  const [decks, notes, cards, noteTypes, reviews, sessions] = await Promise.all([db.decks.toArray(), db.notes.toArray(), db.cards.toArray(), db.noteTypes.toArray(), db.reviewEntries.toArray(), customStudySessions(db)])
  const reserved = new Set(sessions.filter((session) => session.id !== sessionId).flatMap((session) => session.cardIds))
  const rows = collectionSearchRows({ decks, notes, cards, noteTypes, reviews }).filter((row) => matches(row) && renderable(row, now) && !reserved.has(row.card!.id))
  const lastAgain = (row: SearchRow) => Math.max(0, ...row.reviews.filter((entry) => entry.rating === 1).map((entry) => Date.parse(entry.reviewedAt)))
  rows.sort((a, b) => {
    const result = definition.order === 'random' ? rank(a.card!.id) - rank(b.card!.id)
      : definition.order === 'forgotten' ? lastAgain(b) - lastAgain(a)
      : definition.order === 'added' ? a.note.createdAt.localeCompare(b.note.createdAt)
      : a.card!.due.localeCompare(b.card!.due)
    return result || a.card!.id.localeCompare(b.card!.id)
  })
  return { matching: rows.length, cards: rows.slice(0, definition.limit).map((row) => row.card!), expressions: rows.slice(0, Math.min(definition.limit, 10)).map((row) => Object.values(row.note.fields).find(Boolean) ?? '(empty)') }
}
export async function createCustomStudy(db: Collection, definition: CustomStudyDefinition, now = new Date()) {
  return db.transaction('rw', db.tables, async () => {
    const id = crypto.randomUUID()
    if ((await customStudySessions(db)).some((session) => session.name.toLocaleLowerCase() === definition.name.trim().toLocaleLowerCase())) throw new Error('A custom session already uses that name. Choose another name.')
    const preview = await previewCustomStudy(db, definition, now, id)
    const session: CustomStudySession = { ...definition, name: definition.name.trim(), id, cardIds: preview.cards.map((card) => card.id), completed: [], createdAt: now.toISOString() }
    await db.settings.put({ key: customStudyKey, value: [...await customStudySessions(db), session] })
    return session
  })
}
export async function changeCustomStudy(db: Collection, id: string, action: 'rebuild' | 'empty' | 'delete', now = new Date()) {
  return db.transaction('rw', db.tables, async () => {
    const sessions = await customStudySessions(db)
    const session = sessions.find((item) => item.id === id)
    if (!session) throw new Error('Custom session no longer exists.')
    const cards = action === 'rebuild' ? (await previewCustomStudy(db, session, now, id)).cards : []
    const replacement = { ...session, cardIds: cards.map((card) => card.id), completed: [] }
    await db.settings.put({ key: customStudyKey, value: action === 'delete' ? sessions.filter((item) => item.id !== id) : sessions.map((item) => item.id === id ? replacement : item) })
  })
}
export async function customStudyQueue(db: Collection, id: string, now = new Date()) {
  const session = (await customStudySessions(db)).find((item) => item.id === id)
  if (!session) return []
  const records = await db.cards.bulkGet(session.cardIds)
  const cards = records.filter((card): card is CardRecord => Boolean(card && eligibleForQueue(card, now)))
  const notes = await db.notes.bulkGet(cards.map((card) => card.noteId)), types = await db.noteTypes.toArray()
  return cards.filter((card, index) => {
    const note = notes[index], noteType = note && types.find((type) => type.id === note.typeId)
    return Boolean(note && renderable({ note, noteType, card, deckPath: '', reviews: [] }, now))
  })
}
export async function answerCustomStudy(db: Collection, sessionId: string, cardId: string, rating: Grade, now = new Date(), durationMs?: number) {
  return db.transaction('rw', db.tables, async () => {
    const sessions = await customStudySessions(db)
    const session = sessions.find((item) => item.id === sessionId)
    if (!session || !session.cardIds.includes(cardId)) throw new Error('This card is no longer in this custom session.')
    const card = (await customStudyQueue(db, sessionId, now)).find((item) => item.id === cardId)
    if (!card) throw new Error('This custom-study card is no longer available.')
    const review = await db.answer(cardId, rating, now, durationMs, { allowEarly: true, reschedule: session.reschedule })
    const updated = { ...session, cardIds: session.cardIds.filter((id) => id !== cardId), completed: [...session.completed, { cardId, reviewId: review.id }] }
    await db.settings.put({ key: customStudyKey, value: sessions.map((item) => item.id === sessionId ? updated : item) })
    const undo = await db.latestReviewUndo()
    if (undo) await db.settings.put({ key: 'reviewUndo', value: { ...undo, customSession: { before: session, after: updated } } })
    return review
  })
}
export async function undoCustomStudy(db: Collection, sessionId: string) {
  return db.transaction('rw', db.tables, async () => {
    const sessions = await customStudySessions(db), session = sessions.find((item) => item.id === sessionId)
    const undo = await db.latestReviewUndo()
    const completed = undo && session?.completed.find((item) => item.reviewId === undo.review.id)
    if (!session || !completed || !undo) throw new Error('No recent review from this session can be undone.')
    await db.undoLastReview()
  })
}
export const practiceChoices = [1, 2, 3, 4].map((rating, index) => ({ rating: rating as Grade, label: ['Again', 'Hard', 'Good', 'Easy'][index] as 'Again' | 'Hard' | 'Good' | 'Easy', interval: 'No schedule change' }))
export function customPreset(preset: string, now = new Date()) {
  if (preset === 'ahead') return { search: 'is:review -is:due', order: 'due' as const }
  if (preset === 'forgotten') return { search: 'rated:7:1', order: 'forgotten' as const }
  if (preset === 'focus') return { search: 'deck:*', order: 'added' as const }
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return { search: `is:due due:<=${today}`, order: 'due' as const }
}
