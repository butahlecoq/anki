import type { Collection, Note, NoteType } from './collection'
import fieldPreviewWorkerUrl from './field-preview-worker.ts?worker&url'
import { readBrowserDestinationDeck, readBrowserFieldState, readBrowserSelectionSnapshot } from './collection-queries'
import { runBrowserBulkAction, runBrowserFieldChanges } from './collection-mutations'

export type BrowserSelection = { view: 'cards' | 'notes'; ids: string[] }
export type BulkAction =
  | { kind: 'tags'; mode: 'add' | 'remove'; tags: string[] }
  | { kind: 'move'; deckId: string }
  | { kind: 'suspend'; suspended: boolean }
  | { kind: 'flag'; flag: number }
  | { kind: 'delete' }

export async function selectionSummary(db: Collection, selection: BrowserSelection) {
  const snapshot = await readBrowserSelectionSnapshot(db, selection)
  return { selectedCards: snapshot.cards.length, notes: snapshot.notes.length, generatedCards: snapshot.generatedCards }
}

/** All selected records and outbox mutations commit together or roll back together. */
export async function applyBulkAction(db: Collection, selection: BrowserSelection, action: BulkAction, now = new Date(), expected?: { notes: number; selectedCards: number; generatedCards: number }) {
  return runBrowserBulkAction(db, async () => {
    const { cards, notes, generatedCards } = await readBrowserSelectionSnapshot(db, selection)
    if (expected && (notes.length !== expected.notes || cards.length !== expected.selectedCards || generatedCards !== expected.generatedCards)) throw new Error('The affected counts changed. Review a fresh confirmation before applying.')
    if (action.kind === 'move' && !await readBrowserDestinationDeck(db, action.deckId)) throw new Error('Destination deck no longer exists.')
    if (action.kind === 'tags') {
      const remove = new Set(action.tags.map((tag) => tag.trim()).filter(Boolean))
      if (!remove.size) throw new Error('Enter at least one tag.')
      for (const note of notes) await db.updateNoteTags(note.id, action.mode === 'add' ? [...(note.tags ?? []), ...action.tags] : (note.tags ?? []).filter((tag) => !remove.has(tag)), now)
    } else if (action.kind === 'move') {
      for (const note of notes) await db.moveNote(note.id, action.deckId, now)
    } else if (action.kind === 'delete') {
      for (const note of notes) await db.deleteNote(note.id, now)
      // A one-record undo would incorrectly suggest that the entire bulk deletion
      // was restored. Single-note deletions retain the existing safe undo.
      if (notes.length > 1) await db.clearPendingUndo()
    } else {
      for (const card of cards) {
        if (action.kind === 'flag') await db.setCardFlag(card.id, action.flag, now)
        else if (action.suspended) await db.suspendCard(card.id, now)
        else await db.unsuspendCard(card.id, now)
      }
      if (cards.length > 1) await db.clearPendingUndo()
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
  return runBrowserFieldChanges(db, async () => {
    // Validate the entire concrete preview before the first mutation.
    const fields = new Map<string, Record<string, string>>()
    const state = await readBrowserFieldState(db, changes)
    const notes = new Map(state.notes.map((note) => [note.id, note]))
    const types = new Map(state.noteTypes.map((type) => [type.id, type]))
    for (const change of changes) {
      const note = notes.get(change.noteId)
      const type = types.get(change.typeId)
      if (!note || JSON.stringify(note) !== JSON.stringify(change.expectedNote) || !type || JSON.stringify(type) !== JSON.stringify(change.expectedType)) throw new Error('A previewed note or note type changed. Generate a fresh preview before applying.')
      if (note.typeId !== type.id || !type.fields.some((field) => field.id === change.fieldId) || (note.fields[change.fieldId] ?? '') !== change.before) throw new Error('The preview no longer matches the selected fields.')
      fields.set(note.id, { ...(fields.get(note.id) ?? note.fields), [change.fieldId]: change.after })
    }
    for (const [noteId, values] of fields) await db.updateNote(noteId, values, now)
    return fields.size
  })
}

export async function previewFieldChanges(notes: Note[], types: NoteType[], operation: FieldOperation): Promise<FieldChange[]> {
  if (notes.length > 5000) return Promise.reject(new Error('Preview up to 5,000 notes at a time. Narrow the selection first.'))
  let size = 0
  for (const note of notes) {
    size += Object.values(note.fields).reduce((sum, value) => sum + value.length, 0)
    if (size > 8 * 1024 * 1024) return Promise.reject(new Error('Preview up to 8 MiB at a time. Narrow the selection first.'))
  }
  const selectedTypes = types.filter((type) => type.id === operation.typeId)
  if (JSON.stringify({ notes, types: selectedTypes }).length > 8 * 1024 * 1024) return Promise.reject(new Error('Preview up to 8 MiB at a time. Narrow the selection first.'))
  // WebKit does not consistently intercept offline worker-script requests with
  // the service worker. Read the precached bundle directly, then start a worker
  // from its source so preview execution needs no network request.
  const url = new URL(fieldPreviewWorkerUrl, location.href).href
  const cached = typeof caches === 'undefined' ? undefined : await caches.match(url)
  const response = cached ?? await fetch(url)
  if (!response.ok) throw new Error('The field preview could not load. Nothing was changed.')
  const source = await response.text()
  return new Promise((resolve, reject) => {
    const worker = new Worker(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)
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
