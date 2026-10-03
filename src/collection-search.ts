import { Rating, State, type CardRecord, type Deck, type Note, type NoteType, type ReviewEntry } from './collection'
import { eligibleForStudy } from './scheduler'

export class SearchSyntaxError extends Error {
  constructor(public readonly position: number, message: string) { super(message); this.name = 'SearchSyntaxError' }
}

export interface SearchRow {
  note: Note
  card?: CardRecord
  noteType?: NoteType
  deckPath: string
  reviews: ReviewEntry[]
}
export interface SearchCollection { decks: Deck[]; notes: Note[]; cards: CardRecord[]; noteTypes: NoteType[]; reviews: ReviewEntry[] }
type Predicate = (row: SearchRow) => boolean
type Token = { value: string; position: number; kind: 'word' | 'or' | '(' | ')' | '-' }
const normalized = (text: string) => text.normalize('NFKC').toLocaleLowerCase()

export function plainField(text: string) {
  // Scan once: a tag regexp repeatedly rescans fields containing many unmatched <.
  let stripped = '', cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('<', cursor)
    if (open < 0) { stripped += text.slice(cursor); break }
    const close = text.indexOf('>', open + 1)
    if (close < 0) { stripped += text.slice(cursor); break }
    stripped += text.slice(cursor, open) + ' '; cursor = close + 1
  }
  return stripped.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity]!)
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, digits: string) => {
      const code = digits[0].toLowerCase() === 'x' ? parseInt(digits.slice(1), 16) : Number(digits)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    })
}

function tokens(query: string): Token[] {
  if (query.length > 4000) throw new SearchSyntaxError(4000, 'Search is limited to 4,000 characters.')
  const result: Token[] = []
  for (let index = 0; index < query.length;) {
    if (/\s/.test(query[index])) { index++; continue }
    const position = index
    if (['(', ')', '-'].includes(query[index])) {
      const value = query[index++] as '(' | ')' | '-'
      result.push({ value, position, kind: value }); continue
    }
    let value = '', quoted = false
    while (index < query.length && !/[\s()]/.test(query[index])) {
      if (query[index] === '"') {
        quoted = true; index++
        let closed = false
        while (index < query.length) {
          if (query[index] === '"') { index++; closed = true; break }
          if (query[index] === '\\' && ['"', '\\'].includes(query[index + 1])) index++
          value += query[index++]
        }
        if (!closed) throw new SearchSyntaxError(position, 'Close the quoted search value with a double quote.')
      } else value += query[index++]
    }
    if (!value) throw new SearchSyntaxError(position, 'Enter a search value inside the quotes.')
    result.push({ value, position, kind: !quoted && value.toUpperCase() === 'OR' ? 'or' : 'word' })
    if (result.length > 256) throw new SearchSyntaxError(position, 'Search is limited to 256 terms.')
  }
  return result
}

function glob(value: string) {
  const pattern = [...normalized(value)]
  return (text: string) => {
    const input = [...normalized(text)]
    let source = 0, cursor = 0, star = -1, retry = 0
    while (source < input.length) {
      if (pattern[cursor] === '?' || pattern[cursor] === input[source]) { source++; cursor++ }
      else if (pattern[cursor] === '*') { star = cursor++; retry = source }
      else if (star >= 0) { cursor = star + 1; source = ++retry }
      else return false
    }
    while (pattern[cursor] === '*') cursor++
    return cursor === pattern.length
  }
}

function calendarDate(value: string, position: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SearchSyntaxError(position, 'Use a date in YYYY-MM-DD format.')
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(0); date.setFullYear(year, month - 1, day); date.setHours(0, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new SearchSyntaxError(position, 'That calendar date does not exist.')
  return date
}

function termPredicate(token: Token, now: Date): Predicate {
  const colon = token.value.indexOf(':')
  if (colon < 0) {
    const term = normalized(token.value)
    return (row) => Object.values(row.note.fields).some((field) => normalized(plainField(field)).includes(term))
  }
  const field = token.value.slice(0, colon).toLowerCase(), value = token.value.slice(colon + 1)
  const fail = (message: string): never => { throw new SearchSyntaxError(token.position, message) }
  if (!value) fail(`Enter a value after ${field}:`)
  const matches = glob(value)
  if (field === 'deck') return (row) => matches(row.deckPath) || matches(row.note.deckId) || normalized(row.deckPath).startsWith(`${normalized(value)}::`)
  if (field === 'tag') return (row) => (row.note.tags ?? []).some(matches)
  if (field === 'note') return (row) => Boolean(row.noteType && (matches(row.noteType.name) || matches(row.noteType.id)))
  if (field === 'card') return (row) => Boolean(row.card && (matches(row.card.templateId) || row.noteType?.templates.some((template) => template.id === row.card?.templateId && matches(template.name))))
  if (field === 'flag') {
    if (!/^[0-7]$/.test(value)) fail('Flag must be a number from 0 to 7.')
    return (row) => Boolean(row.card && (row.card.flag ?? 0) === Number(value))
  }
  if (field === 'is') {
    const state = value.toLowerCase()
    if (!['new', 'learn', 'learning', 'relearning', 'review', 'suspended', 'buried', 'due'].includes(state)) fail('State must be new, learn, learning, relearning, review, suspended, buried, or due.')
    return (row) => {
      const card = row.card
      if (!card) return false
      if (state === 'suspended') return Boolean(card.manualSuspended || card.templateSuspended || card.suspended)
      if (state === 'buried') return Boolean(card.buriedUntil && Date.parse(card.buriedUntil) > now.getTime())
      if (state === 'due') return card.state !== State.New && eligibleForStudy(card, now)
      if (state === 'learn') return card.state === State.Learning || card.state === State.Relearning
      return card.state === ({ new: State.New, learning: State.Learning, relearning: State.Relearning, review: State.Review })[state as 'new' | 'learning' | 'relearning' | 'review']
    }
  }
  if (field === 'due' || field === 'reviewed') {
    const match = value.match(/^(<=|>=|<|>|=)?(\d{4}-\d{2}-\d{2})$/)
    if (!match) fail('Use a calendar date, optionally prefixed with <, <=, >, >=, or =.')
    const date = calendarDate(match![2], token.position)
    const end = new Date(date); end.setDate(end.getDate() + 1)
    const compare = (timestamp: number) => match![1] === '<' ? timestamp < date.getTime() : match![1] === '<=' ? timestamp < end.getTime() : match![1] === '>' ? timestamp >= end.getTime() : match![1] === '>=' ? timestamp >= date.getTime() : timestamp >= date.getTime() && timestamp < end.getTime()
    return field === 'due' ? (row) => Boolean(row.card && row.card.state !== State.New && compare(Date.parse(row.card.due))) : (row) => row.reviews.some((review) => compare(Date.parse(review.reviewedAt)))
  }
  if (field === 'rated') {
    const match = value.match(/^(\d+)(?::([1-4]))?$/)
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 36500) fail('Use rated:days or rated:days:rating, with 1–36,500 days and ratings 1–4.')
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(match![1]) + 1).getTime()
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    return (row) => row.reviews.some((review) => Date.parse(review.reviewedAt) >= start && Date.parse(review.reviewedAt) < end && (!match![2] || review.rating === Number(match![2]) as Rating))
  }
  return fail(`Unknown search operator ${field}:. Supported operators: deck, tag, is, due, note, flag, card, rated, reviewed.`)
}

/** Validate the whole query before returning a predicate; callers retain old results on error. */
export function compileCollectionSearch(query: string, now = new Date()): Predicate {
  const input = tokens(query)
  let cursor = 0
  const fail = (message: string): never => { throw new SearchSyntaxError(input[cursor]?.position ?? query.length, message) }
  function atom(depth: number): Predicate {
    if (depth > 32) fail('Search groups are limited to 32 nested levels.')
    const token = input[cursor++]
    if (!token) fail('Enter a term after the operator.')
    if (token.kind === '-') { const predicate = atom(depth + 1); return (row) => !predicate(row) }
    if (token.kind === '(') {
      const predicate = expression(depth + 1)
      if (input[cursor]?.kind !== ')') fail('Close this search group with ).')
      cursor++; return predicate
    }
    if (token.kind !== 'word') { cursor--; fail('Expected a search term.') }
    return termPredicate(token, now)
  }
  function conjunction(depth: number): Predicate {
    const terms = [atom(depth)]
    while (cursor < input.length && input[cursor].kind !== ')' && input[cursor].kind !== 'or') terms.push(atom(depth))
    return (row) => terms.every((term) => term(row))
  }
  function expression(depth: number): Predicate {
    const alternatives = [conjunction(depth)]
    while (input[cursor]?.kind === 'or') { cursor++; alternatives.push(conjunction(depth)) }
    return (row) => alternatives.some((predicate) => predicate(row))
  }
  if (!input.length) return () => true
  const predicate = expression(0)
  if (cursor < input.length) fail('Unexpected closing parenthesis.')
  return predicate
}

export function collectionDeckPaths(records: Deck[]): Map<string, string> {
  const decks = new Map(records.map((deck) => [deck.id, deck]))
  const paths = new Map<string, string>()
  function deckPath(id: string): string {
    if (paths.has(id)) return paths.get(id)!
    const parts: string[] = [], seen = new Set<string>()
    let current: string | null = id
    while (current && !seen.has(current)) {
      seen.add(current); const deck = decks.get(current)
      if (!deck) break
      parts.unshift(deck.name); current = deck.parentId
    }
    const path = parts.join('::'); paths.set(id, path); return path
  }
  for (const deck of records) deckPath(deck.id)
  return paths
}

export function collectionSearchRows(data: SearchCollection): SearchRow[] {
  const notes = new Map(data.notes.map((note) => [note.id, note]))
  const types = new Map(data.noteTypes.map((type) => [type.id, type]))
  const paths = collectionDeckPaths(data.decks)
  const deckPath = (id: string) => paths.get(id) ?? ''
  const reviews = new Map<string, ReviewEntry[]>()
  for (const review of data.reviews) { const list = reviews.get(review.cardId) ?? []; list.push(review); reviews.set(review.cardId, list) }
  const rows: SearchRow[] = []
  const represented = new Set<string>()
  for (const card of data.cards) {
    const note = notes.get(card.noteId)
    if (!note) continue
    represented.add(note.id)
    rows.push({ note, card, noteType: types.get(note.typeId), deckPath: deckPath(card.deckId), reviews: reviews.get(card.id) ?? [] })
  }
  for (const note of data.notes) if (!represented.has(note.id)) rows.push({ note, noteType: types.get(note.typeId), deckPath: deckPath(note.deckId), reviews: [] })
  return rows
}
