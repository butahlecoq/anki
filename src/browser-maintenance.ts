import type { CardRecord, Collection, Note, NoteType } from './collection'

export type BrowserSelection = { view: 'cards' | 'notes'; ids: string[] }
export type BulkAction =
  | { kind: 'tags'; mode: 'add' | 'remove'; tags: string[] }
  | { kind: 'move'; deckId: string }
  | { kind: 'suspend'; suspended: boolean }
  | { kind: 'flag'; flag: number }
  | { kind: 'delete' }

async function resolveSelection(db: Collection, selection: BrowserSelection) {
  const ids = [...new Set(selection.ids)]
  if (!ids.length) throw new Error('Select at least one record.')
  let cards: CardRecord[], notes: Note[]
  if (selection.view === 'cards') {
    const stored = await db.cards.bulkGet(ids)
    if (stored.some((card) => !card)) throw new Error('A selected card no longer exists. Refresh the results before applying this action.')
    cards = stored as CardRecord[]
    const storedNotes = await db.notes.bulkGet([...new Set(cards.map((card) => card.noteId))])
    if (storedNotes.some((note) => !note)) throw new Error('A selected card no longer has a note.')
    notes = storedNotes as Note[]
  } else {
    const stored = await db.notes.bulkGet(ids)
    if (stored.some((note) => !note)) throw new Error('A selected note no longer exists. Refresh the results before applying this action.')
    notes = stored as Note[]
    cards = await db.cards.where('noteId').anyOf(ids).toArray()
  }
  return { cards, notes }
}

export async function selectionSummary(db: Collection, selection: BrowserSelection) {
  return db.transaction('r', db.notes, db.cards, async () => {
    const { cards, notes } = await resolveSelection(db, selection)
    const allCards = await db.cards.where('noteId').anyOf(notes.map((note) => note.id)).count()
    return { selectedCards: cards.length, notes: notes.length, generatedCards: allCards }
  })
}

/** All selected records and outbox mutations commit together or roll back together. */
export async function applyBulkAction(db: Collection, selection: BrowserSelection, action: BulkAction, now = new Date()) {
  return db.transaction('rw', db.tables, async () => {
    const { cards, notes } = await resolveSelection(db, selection)
    if (action.kind === 'move' && !await db.decks.get(action.deckId)) throw new Error('Destination deck no longer exists.')
    if (action.kind === 'tags') {
      const remove = new Set(action.tags.map((tag) => tag.trim()).filter(Boolean))
      for (const note of notes) await db.updateNoteTags(note.id, action.mode === 'add' ? [...(note.tags ?? []), ...action.tags] : (note.tags ?? []).filter((tag) => !remove.has(tag)), now)
    } else if (action.kind === 'move') {
      for (const note of notes) await db.moveNote(note.id, action.deckId, now)
    } else if (action.kind === 'delete') {
      for (const note of notes) await db.deleteNote(note.id, now)
      // A one-record undo would incorrectly suggest that the entire bulk deletion
      // was restored. Single-note deletions retain the existing safe undo.
      if (notes.length > 1) await db.settings.delete('noteDeletionUndo')
    } else {
      for (const card of cards) {
        if (action.kind === 'flag') await db.setCardFlag(card.id, action.flag, now)
        else if (action.suspended) await db.suspendCard(card.id, now)
        else await db.unsuspendCard(card.id, now)
      }
      if (cards.length > 1) await db.settings.delete('cardMaintenanceUndo')
    }
    return { notes: notes.length, cards: cards.length }
  })
}

export interface FieldChange {
  noteId: string
  typeId: string
  fieldId: string
  before: string
  after: string
  expectedNote: Note
  expectedType: NoteType
}
export interface FieldOperation {
  typeId: string
  fieldId: string
  mode: 'literal' | 'regex' | 'set'
  find: string
  replacement: string
  caseSensitive: boolean
}

/** Regex callers run this pure computation in the cancellable preview worker. */
export function fieldChangePreview(notes: Note[], types: NoteType[], operation: FieldOperation): FieldChange[] {
  const type = types.find((candidate) => candidate.id === operation.typeId)
  if (!type?.fields.some((field) => field.id === operation.fieldId)) throw new Error('Select an existing note type and field.')
  if (type.kind === 'image-occlusion') throw new Error('Use the image occlusion editor to edit its fields.')
  if (operation.mode !== 'set' && !operation.find) throw new Error('Enter the text or pattern to find.')
  if (operation.find.length > 1000) throw new Error('Patterns are limited to 1,000 characters.')
  if (operation.replacement.length > 100_000) throw new Error('Replacement text is limited to 100,000 characters.')
  let expression: RegExp | undefined
  if (operation.mode === 'regex') expression = new RegExp(operation.find, operation.caseSensitive ? 'gu' : 'giu')
  const changes: FieldChange[] = []
  let expanded = 0
  for (const note of notes) {
    if (note.typeId !== type.id) continue
    const before = note.fields[operation.fieldId] ?? ''
    let after: string
    if (operation.mode === 'set') after = operation.replacement
    else if (expression) after = before.replace(expression, operation.replacement)
    else if (operation.caseSensitive) after = before.split(operation.find).join(operation.replacement)
    else {
      // Escaping a literal creates a safe non-quantified regexp; a replacement
      // callback preserves literal $ characters instead of interpreting groups.
      const literal = new RegExp(operation.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
      after = before.replace(literal, () => operation.replacement)
    }
    expanded += before.length + after.length
    if (expanded > 8 * 1024 * 1024) throw new Error('The preview exceeds 8 MiB. Narrow the selection or shorten the replacement.')
    if (after !== before) changes.push({ noteId: note.id, typeId: type.id, fieldId: operation.fieldId, before, after, expectedNote: note, expectedType: type })
  }
  return changes
}

export async function applyFieldChanges(db: Collection, changes: FieldChange[], now = new Date()) {
  if (!changes.length) throw new Error('There are no field changes to apply.')
  return db.transaction('rw', db.tables, async () => {
    // Validate the entire concrete preview before the first mutation.
    const fields = new Map<string, Record<string, string>>()
    for (const change of changes) {
      const note = await db.notes.get(change.noteId)
      const type = await db.noteTypes.get(change.typeId)
      if (!note || JSON.stringify(note) !== JSON.stringify(change.expectedNote) || !type || JSON.stringify(type) !== JSON.stringify(change.expectedType)) throw new Error('A previewed note or note type changed. Generate a fresh preview before applying.')
      if (note.typeId !== type.id || !type.fields.some((field) => field.id === change.fieldId) || (note.fields[change.fieldId] ?? '') !== change.before) throw new Error('The preview no longer matches the selected fields.')
      fields.set(note.id, { ...(fields.get(note.id) ?? note.fields), [change.fieldId]: change.after })
    }
    for (const [noteId, values] of fields) await db.updateNote(noteId, values, now)
    return fields.size
  })
}

export function previewFieldChanges(notes: Note[], types: NoteType[], operation: FieldOperation): Promise<FieldChange[]> {
  if (notes.length > 5000) return Promise.reject(new Error('Preview up to 5,000 notes at a time. Narrow the selection first.'))
  let size = 0
  for (const note of notes) {
    size += Object.values(note.fields).reduce((sum, value) => sum + value.length, 0)
    if (size > 8 * 1024 * 1024) return Promise.reject(new Error('Preview up to 8 MiB at a time. Narrow the selection first.'))
  }
  const selectedTypes = types.filter((type) => type.id === operation.typeId)
  if (JSON.stringify({ notes, types: selectedTypes }).length > 8 * 1024 * 1024) return Promise.reject(new Error('Preview up to 8 MiB at a time. Narrow the selection first.'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./field-preview-worker.ts', import.meta.url), { type: 'module' })
    const timer = window.setTimeout(() => { worker.terminate(); reject(new Error('This pattern took too long. Simplify it or use literal replacement. Nothing was changed.')) }, 2000)
    const finish = () => { window.clearTimeout(timer); worker.terminate() }
    worker.onmessage = (event: MessageEvent<{ changes?: FieldChange[]; error?: string }>) => {
      finish()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve(event.data.changes ?? [])
    }
    worker.onerror = () => { finish(); reject(new Error('The field preview could not run. Nothing was changed.')) }
    worker.postMessage({ notes, types: selectedTypes, operation })
  })
}
