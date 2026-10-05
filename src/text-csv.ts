import { type Collection, type Deck, type Note, type NoteType } from './collection'
import { readTextExportSnapshot, readTextImportSnapshot } from './collection-queries'

export const TEXT_BYTE_LIMIT = 16 * 1024 * 1024
export const TEXT_ROW_LIMIT = 20_000
export type TextEncoding = 'auto' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'shift_jis'
export type Delimiter = ',' | '\t' | ';' | '|'
export type CsvRow = { line: number; values: string[]; error?: string }
export type CsvDocument = { rows: CsvRow[]; delimiter: Delimiter; encoding: string }
export type ColumnMapping = 'ignore' | 'deck' | 'type' | 'tags' | 'identifier' | `field:${string}`
export type ImportOptions = { mapping: ColumnMapping[]; header: boolean; deckId: string; typeId: string; html: 'keep' | 'strip'; duplicates: 'update' | 'ignore' | 'duplicate' | 'error'; newRows: 'add' | 'ignore'; createDecks: boolean; replaceTags: boolean }
export type PlannedRow = { line: number; action: 'add' | 'update' | 'ignore' | 'error'; message: string; original: string[]; noteId?: string; existing?: Note; typeId?: string; deckId?: string; deckPath?: string; fields?: Record<string, string>; tags?: string[] }
export type TextPreview = { rows: PlannedRow[]; revision: string; newDecks: string[] }

export function decodeText(bytes: Uint8Array, encoding: TextEncoding): { text: string; encoding: string } {
  if (bytes.byteLength > TEXT_BYTE_LIMIT) throw new Error('Text files must be at most 16 MiB.')
  const selected = encoding === 'auto' ? bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8' : encoding
  try { return { text: new TextDecoder(selected, { fatal: true }).decode(bytes), encoding: selected } }
  catch { throw new Error(`This file is not valid ${selected}. Choose the correct encoding, such as Shift JIS, and preview again.`) }
}

/** Bounded, quote-aware records; structural failures belong to their source row. */
export function parseDelimited(text: string, delimiter: Delimiter, quote: '"' | "'" | ''): CsvRow[] {
  if (text.length > TEXT_BYTE_LIMIT) throw new Error('Text is too large; split it into files of at most 16 MiB.')
  const rows: CsvRow[] = []
  let values: string[] = [], value = '', quoted = false, closed = false, error: string | undefined
  let line = 1, startLine = 1
  const append = (text: string) => { if (value.length + text.length > 1024 * 1024) error ??= 'A field is too large. Remaining text in that field was omitted; split it into smaller fields.'; else value += text }
  const field = () => { if (values.length < 128) values.push(value); else error ??= 'This row exceeds 128 columns.'; value = ''; closed = false }
  const row = () => {
    const explicitEmpty = closed
    field()
    if (explicitEmpty || values.some((cell) => cell.length) || values.length > 1 || error) rows.push({ line: startLine, values, error })
    if (rows.length > TEXT_ROW_LIMIT) throw new Error('At most 20,000 rows are supported; split this file.')
    values = []; error = undefined; startLine = line + 1
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === quote) {
        if (text[index + 1] === quote) { append(quote); index++ }
        else { quoted = false; closed = true }
      } else { append(character); if (character === '\n') line++ }
      continue
    }
    if (character === delimiter) field()
    else if (character === '\r' || character === '\n') { row(); if (character === '\r' && text[index + 1] === '\n') index++; line++ }
    else if (quote && character === quote) {
      if (!value && !closed) quoted = true
      else { error ??= 'Unexpected quote inside an unquoted field.'; append(character) }
    } else if (closed) {
      if (!/\s/.test(character)) { error ??= 'Unexpected text after a closing quote.'; append(character) }
    } else append(character)
  }
  if (quoted) error = 'Quoted field is not closed. Check this row and its following lines.'
  if (value || values.length || closed || error) row()
  return rows
}

export function readTextDocument(bytes: Uint8Array, encoding: TextEncoding, delimiter: Delimiter | 'auto', quote: '"' | "'" | ''): CsvDocument {
  const decoded = decodeText(bytes, encoding)
  let selected: Delimiter = delimiter === 'auto' ? ',' : delimiter
  if (delimiter === 'auto') {
    let best = -Infinity
    for (const candidate of ['\t', ',', ';', '|'] as Delimiter[]) {
      let sample: CsvRow[]
      try { sample = parseDelimited(decoded.text, candidate, quote).slice(0, 20) } catch { continue }
      const widths = new Map<number, number>()
      sample.forEach((row) => widths.set(row.values.length, (widths.get(row.values.length) ?? 0) + 1))
      const score = Math.max(0, ...[...widths].map(([width, count]) => width > 1 ? count * width + (count === sample.length ? 1000 : 0) : 0)) - sample.filter((row) => row.error).length * 10
      if (score > best) { best = score; selected = candidate }
    }
  }
  return { rows: parseDelimited(decoded.text, selected, quote), delimiter: selected, encoding: decoded.encoding }
}

export function serializeDelimited(rows: string[][], delimiter: Delimiter = ','): string {
  return rows.map((row) => row.map((cell) => /["\r\n]/.test(cell) || cell.includes(delimiter) || /^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(delimiter)).join('\r\n') + '\r\n'
}

export function plainText(value: string): string {
  const template = document.createElement('template')
  template.innerHTML = value
  template.content.querySelectorAll('script,style').forEach((element) => element.remove())
  template.content.querySelectorAll('br').forEach((element) => element.replaceWith('\n'))
  template.content.querySelectorAll('p,div,li').forEach((element) => element.append('\n'))
  return template.content.textContent?.replace(/\n$/, '') ?? ''
}

export function pathsForDecks(decks: Deck[]): Map<string, string> {
  const byId = new Map(decks.map((deck) => [deck.id, deck]))
  const paths = new Map<string, string>()
  for (const deck of decks) {
    const names = [deck.name], seen = new Set([deck.id])
    let parent = deck.parentId && byId.get(deck.parentId)
    while (parent) {
      if (seen.has(parent.id)) throw new Error('Deck hierarchy contains a cycle.')
      seen.add(parent.id); names.unshift(parent.name); parent = parent.parentId && byId.get(parent.parentId)
    }
    paths.set(deck.id, formatDeckPath(names))
  }
  return paths
}

function formatDeckPath(names: string[]) { return names.some((name) => name.includes('::') || name.startsWith('[')) ? JSON.stringify(names) : names.join('::') }
function deckPathParts(path: string): string[] {
  const parts: unknown = path.startsWith('[') ? JSON.parse(path) : path.split('::')
  if (!Array.isArray(parts) || parts.length > 32 || parts.some((part) => typeof part !== 'string' || !part.trim() || part.length > 120 || part !== part.trim())) throw new Error('Deck paths need nonempty names up to 120 characters and at most 32 levels. Literal :: names use a JSON array of path names.')
  return parts as string[]
}

async function snapshot(db: Collection) {
  const { notes, decks, noteTypes: types, deleted: graves } = await readTextImportSnapshot(db)
  return { notes, decks, types, graves, revision: JSON.stringify([notes, decks, types, graves]) }
}

function importedId(value: string, known: Set<string>): string {
  if (known.has(value) || /^(anki-note:|csv-note:)/.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return value
  if (known.has(`anki-note:${value}`)) return `anki-note:${value}`
  if (value.length > 120) throw new Error('External identifiers must be at most 120 characters.')
  return `csv-note:${btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

function tagsFromText(value: string): string[] {
  let tags: unknown = value.trim().startsWith('[') ? JSON.parse(value) : value.split(/[,;\s]+/).filter(Boolean)
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.trim().length > 120)) throw new Error('Tags must be a JSON string array or a whitespace-separated list, with at most 120 characters per tag.')
  tags = [...new Set((tags as string[]).map((tag) => tag.trim()).filter(Boolean))]
  return tags as string[]
}

export async function previewTextImport(db: Collection, document: CsvDocument, options: ImportOptions): Promise<TextPreview> {
  if (options.header && document.rows[0]?.error) throw new Error(`Header row is invalid: ${document.rows[0].error}`)
  const roles = options.mapping.filter((role) => role !== 'ignore')
  if (new Set(roles).size !== roles.length) throw new Error('Map each field and metadata role only once.')
  const state = await snapshot(db)
  const paths = pathsForDecks(state.decks)
  const noteIds = new Set([...state.notes.map((note) => note.id), ...state.graves.filter((grave) => grave.entityType === 'note').map((grave) => grave.entityId)])
  const deletedNotes = new Set(state.graves.filter((grave) => grave.entityType === 'note').map((grave) => grave.entityId))
  const notesById = new Map(state.notes.map((note) => [note.id, note]))
  const typesById = new Map(state.types.map((type) => [type.id, type]))
  const byFirstField = new Map<string, Note[]>()
  for (const note of state.notes) {
    const firstId = typesById.get(note.typeId)?.fields[0]?.id
    const first = firstId ? note.fields[firstId]?.trim() : ''
    if (first) { const key = JSON.stringify([note.typeId, note.deckId, first]); const group = byFirstField.get(key); if (group) group.push(note); else byFirstField.set(key, [note]) }
  }
  const rows: PlannedRow[] = [], newDecks = new Set<string>(), incoming = new Map<string, string>()
  const sourceRows = options.header ? document.rows.slice(1) : document.rows
  for (const row of sourceRows) {
    const planned: PlannedRow = { line: row.line, action: 'error', message: '', original: row.values }
    try {
      if (row.error) throw new Error(row.error)
      if (row.values.length !== options.mapping.length) throw new Error(`Expected ${options.mapping.length} columns, received ${row.values.length}.`)
      const mapped = (role: ColumnMapping) => { const column = options.mapping.indexOf(role); return column < 0 ? undefined : row.values[column] }
      const typeName = mapped('type')?.trim()
      const types = typeName ? state.types.filter((type) => type.id === typeName || type.name === typeName) : state.types.filter((type) => type.id === options.typeId)
      if (types.length !== 1) throw new Error('Note type is missing or ambiguous. Create/select the required note type and preview again.')
      const type = types[0]
      if (type.kind === 'image-occlusion') throw new Error('Image occlusion requires source images and masks; use Anki package import.')
      planned.typeId = type.id
      const destination = mapped('deck')?.trim()
      const matches = destination ? state.decks.filter((deck) => deck.id === destination || paths.get(deck.id) === destination) : state.decks.filter((deck) => deck.id === options.deckId)
      if (matches.length > 1) throw new Error('Deck path is ambiguous. Map its unique deck ID instead.')
      if (matches.length === 1) { planned.deckId = matches[0].id; planned.deckPath = paths.get(matches[0].id)! }
      else if (destination && options.createDecks) {
        const parts = deckPathParts(destination)
        if (parts.some((_, index) => [...paths.values()].filter((path) => path === formatDeckPath(parts.slice(0, index + 1))).length > 1)) throw new Error('A parent deck path is ambiguous. Select or rename the required deck before importing.')
        planned.deckPath = destination
      } else throw new Error('Destination deck is missing. Select a deck or allow creation of mapped deck paths.')
      const identifier = mapped('identifier')?.trim()
      planned.noteId = identifier ? importedId(identifier, noteIds) : undefined
      if (planned.noteId && (planned.noteId.length > 512 || [...planned.noteId].some((character) => character.charCodeAt(0) < 32))) throw new Error('Stable note identifier is invalid or too long.')
      if (planned.noteId && deletedNotes.has(planned.noteId)) throw new Error('This identifier belongs to a deleted note. Remove its identifier to create a new note.')
      const existingById = planned.noteId ? notesById.get(planned.noteId) : undefined
      const fields: Record<string, string> = { ...(existingById?.fields ?? {}) }
      let fieldCount = 0
      options.mapping.forEach((role, index) => {
        if (!role.startsWith('field:')) return
        const field = type.fields.find((candidate) => candidate.name === role.slice(6))
        if (!field) { if (row.values[index]) throw new Error(`Field “${role.slice(6)}” does not belong to this row's note type.`); return }
        fields[field.id] = options.html === 'strip' ? plainText(row.values[index]) : row.values[index]; fieldCount++
      })
      if (!fieldCount && !existingById) throw new Error('Map at least one note field, or a stable identifier for a metadata-only update.')
      const first = fields[type.fields[0].id]?.trim()
      const matchesByField = !identifier && first ? byFirstField.get(JSON.stringify([type.id, planned.deckId, first])) ?? [] : []
      const matchesNotes = existingById ? [existingById] : matchesByField
      if (matchesNotes.length > 1 && options.duplicates === 'update') throw new Error('Multiple notes match the first field. Map a stable identifier to choose the note to update.')
      const existing = matchesNotes[0]
      if (existing && existing.typeId !== type.id) throw new Error('Identifier belongs to a different note type; select that type or create a new note.')
      planned.existing = existing
      planned.fields = existing ? { ...existing.fields, ...fields } : Object.fromEntries(type.fields.map((field) => [field.id, fields[field.id] ?? '']))
      const tagText = mapped('tags')
      planned.tags = tagText === undefined ? existing?.tags ?? [] : options.replaceTags ? tagsFromText(tagText) : [...new Set([...(existing?.tags ?? []), ...tagsFromText(tagText)])]
      const generation = db.tryCardGenerationStatus(type, planned.fields)
      if (!generation.ok) throw new Error(generation.error)
      if (!generation.value.eligible.length && !existing) throw new Error('These fields generate no reviewable cards. Fill the prompt or valid cloze deletions.')
      const key = identifier ? `id:${planned.noteId}` : first ? `field:${type.id}:${planned.deckPath}:${first}` : undefined
      const signature = JSON.stringify([planned.fields, planned.tags, planned.deckPath, type.id])
      if (key && incoming.has(key) && options.duplicates !== 'duplicate') {
        if (incoming.get(key) !== signature) throw new Error('Another row uses this identifier/first field with different values. Resolve the conflicting rows.')
        planned.action = 'ignore'; planned.message = 'Repeated identical note row; ignored.'
      } else if (existing && options.duplicates === 'error') throw new Error('A matching note already exists. Choose update, ignore or add duplicate.')
      else if (existing && options.duplicates === 'ignore') { planned.action = 'ignore'; planned.message = 'Existing matching note; ignored.' }
      else if (existing && options.duplicates === 'update') { planned.action = 'update'; planned.noteId = existing.id; planned.message = 'Update fields/tags and move the whole note if its deck changes; card/review identities stay.' }
      else if (options.newRows === 'ignore') { planned.action = 'ignore'; planned.message = 'New notes are ignored by the selected policy.' }
      else {
        planned.action = 'add'; planned.message = existing || key && incoming.has(key) ? 'Add an intentional duplicate with a new identity.' : 'Add a new note.'
        if (existing || key && incoming.has(key)) planned.noteId = undefined
      }
      if (key) incoming.set(key, signature)
      if (planned.action === 'add' || planned.action === 'update') {
        if (!planned.deckId) newDecks.add(planned.deckPath!)
      }
    } catch (reason) { planned.action = 'error'; planned.message = reason instanceof Error ? reason.message : 'Invalid row.' }
    rows.push(planned)
  }
  return { rows, revision: state.revision, newDecks: [...newDecks] }
}

export async function applyTextImport(db: Collection, preview: TextPreview, partial: boolean) {
  if (!partial && preview.rows.some((row) => row.action === 'error')) throw new Error('Fix invalid rows or explicitly choose partial import.')
  const result = { added: 0, updated: 0, ignored: preview.rows.filter((row) => row.action === 'ignore').length, errors: preview.rows.filter((row) => row.action === 'error').length }
  await db.transaction('rw', [db.notes, db.decks, db.noteTypes, db.cards, db.outbox, db.deletedEntities, db.deckOptionGroups, db.syncRevisions], async () => {
    const state = await snapshot(db)
    if (state.revision !== preview.revision) throw new Error('Collection changed after preview. Preview again before importing.')
    const paths = pathsForDecks(state.decks)
    const byPath = new Map([...paths].map(([id, path]) => [path, id]))
    for (const row of preview.rows) {
      if (row.action !== 'add' && row.action !== 'update') continue
      let deckId = row.deckId
      if (!deckId) {
        let parentId: string | null = null
        const parts = deckPathParts(row.deckPath!)
        for (let index = 0; index < parts.length; index++) {
          const path = formatDeckPath(parts.slice(0, index + 1))
          let id = byPath.get(path)
          if (!id) { id = (await db.createDeck(parts[index], { parentId })).id; byPath.set(path, id) }
          parentId = id
        }
        deckId = parentId!
      }
      if (row.action === 'add') {
        const note = await db.createNote(deckId, row.typeId!, row.fields!, new Date(), row.noteId)
        if (row.tags?.length) await db.updateNoteTags(note.id, row.tags)
        result.added++
      } else {
        await db.updateNote(row.noteId!, row.fields!)
        await db.updateNoteTags(row.noteId!, row.tags!)
        await db.moveNote(row.noteId!, deckId)
        result.updated++
      }
    }
  })
  return result
}

export type TextExportOptions = { mode: 'notes' | 'cards'; deckId?: string; fields: string[]; tags: boolean; deck: boolean; type: boolean; identifiers: boolean; html: 'keep' | 'strip'; header: boolean; delimiter: Delimiter; bom: boolean }
export async function exportTextCollection(db: Collection, options: TextExportOptions) {
    const { notes, decks, noteTypes: types, cards } = await readTextExportSnapshot(db)
    const paths = pathsForDecks(decks), typesById = new Map(types.map((type) => [type.id, type]))
    const scope = new Set<string>(options.deckId ? [options.deckId] : decks.map((deck) => deck.id))
    if (options.deckId) for (let changed = true; changed;) { changed = false; for (const deck of decks) if (deck.parentId && scope.has(deck.parentId) && !scope.has(deck.id)) { scope.add(deck.id); changed = true } }
    const header = [...(options.identifiers ? ['_note_id'] : []), ...(options.mode === 'cards' ? ['_card_id', '_template', '_card_deck'] : []), ...(options.deck ? ['_deck'] : []), ...(options.type ? ['_note_type'] : []), ...(options.tags ? ['_tags'] : []), ...options.fields.map((field) => `Field: ${field}`)]
    if (header.length > 128) throw new Error('Select at most 128 export columns including metadata.')
    if (!header.length) throw new Error('Select at least one field or metadata column to export.')
    const rows: string[][] = []
    let bytes = Number(options.bom) * 3 + (options.header ? new TextEncoder().encode(serializeDelimited([header], options.delimiter)).byteLength : 0)
    const append = (note: Note, card?: { id: string; templateId: string; deckId: string }) => {
      const type = typesById.get(note.typeId)
      if (!type) throw new Error('A note type is missing; repair the collection before exporting.')
      const row = [...(options.identifiers ? [note.id] : []), ...(card ? [card.id, type.templates.find((template) => template.id === card.templateId)?.name ?? card.templateId, paths.get(card.deckId) ?? ''] : []), ...(options.deck ? [paths.get(note.deckId) ?? ''] : []), ...(options.type ? [type.name] : []), ...(options.tags ? [JSON.stringify(note.tags ?? [])] : []), ...options.fields.map((name) => { const field = type.fields.find((candidate) => candidate.name === name); const value = field ? note.fields[field.id] ?? '' : ''; return options.html === 'strip' ? plainText(value) : value })]
      if (row.some((value) => value.length > 1024 * 1024)) throw new Error('An export field exceeds 1 MiB; choose smaller fields or use Anki package export.')
      bytes += new TextEncoder().encode(serializeDelimited([row], options.delimiter)).byteLength
      if (bytes > TEXT_BYTE_LIMIT || rows.length >= TEXT_ROW_LIMIT) throw new Error('Text export exceeds 16 MiB or 20,000 rows. Export a smaller deck scope or use Anki package export.')
      rows.push(row)
    }
    const notesById = new Map(notes.map((note) => [note.id, note]))
    if (options.mode === 'notes') notes.filter((note) => scope.has(note.deckId)).forEach((note) => append(note))
    else cards.filter((card) => scope.has(card.deckId)).forEach((card) => { const note = notesById.get(card.noteId); if (!note) throw new Error('A card has no note.'); append(note, card) })
    return { text: `${options.bom ? '\ufeff' : ''}${serializeDelimited(options.header ? [header, ...rows] : rows, options.delimiter)}`, count: rows.length }
}

export function defaultMapping(document: CsvDocument, type: NoteType, header: boolean): ColumnMapping[] {
  const names = header ? document.rows[0]?.values ?? [] : document.rows[0]?.values.map(() => '') ?? []
  return names.map((name, index): ColumnMapping => {
    if (name === '_note_id') return 'identifier'
    if (name === '_deck') return 'deck'
    if (name === '_note_type') return 'type'
    if (name === '_tags') return 'tags'
    if (['_card_id', '_template', '_card_deck'].includes(name)) return 'ignore'
    const field = type.fields.find((candidate) => candidate.name.toLowerCase() === name.replace(/^Field: /, '').toLowerCase())
    return field ? `field:${field.name}` : type.fields[index] && !names.some((value) => value.startsWith('_') || value.startsWith('Field: ')) ? `field:${type.fields[index].name}` : name.startsWith('Field: ') ? `field:${name.slice(7)}` : 'ignore'
  })
}
