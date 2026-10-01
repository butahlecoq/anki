export interface RenderedTemplate {
  html: string
  isEmpty: boolean
  typedAnswer?: string
}

export interface RenderOptions {
  kind?: 'standard' | 'cloze'
  ordinal?: number
  side?: 'front' | 'back'
}

export type RenderResult = { ok: true; value: RenderedTemplate } | { ok: false; error: string }

const token = /{{\s*([#^/])?\s*([^{}]+?)\s*}}/g
const clozeToken = /{{c(\d+)::([\s\S]*?)}}/g

type ClozePart = { ordinals: number[]; answer: string; hint?: string }

function parseCloze(value: string): Array<string | ClozePart> {
  const parts: Array<string | ClozePart> = []
  let cursor = 0
  for (const match of value.matchAll(clozeToken)) {
    const prefix = value.slice(cursor, match.index)
    if (/{{c(?:\d|[,:-])/.test(prefix)) throw new Error(`Malformed cloze deletion near character ${cursor + 1}`)
    if (prefix) parts.push(prefix)
    const ordinal = Number(match[1])
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error(`Cloze ordinal must be a positive integer near character ${match.index + 1}`)
    const [answer, ...hintParts] = match[2].split('::')
    if (!answer || answer.includes('{{') || hintParts.length > 1) throw new Error(`Malformed cloze deletion near character ${match.index + 1}`)
    parts.push({ ordinals: [ordinal], answer, ...(hintParts.length ? { hint: hintParts[0] } : {}) })
    cursor = match.index + match[0].length
  }
  const rest = value.slice(cursor)
  if (/{{c(?:\d|[,:-])/.test(rest)) throw new Error(`Unclosed cloze deletion near character ${cursor + 1}`)
  if (rest) parts.push(rest)
  return parts
}

export function clozeOrdinals(value: string): number[] {
  return [...new Set(parseCloze(value).flatMap((part) => typeof part === 'string' ? [] : part.ordinals))].sort((a, b) => a - b)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}

function renderCloze(value: string, ordinal: number, side: 'front' | 'back'): string {
  return parseCloze(value).map((part) => {
    if (typeof part === 'string') return escapeHtml(part)
    if (!part.ordinals.includes(ordinal)) return escapeHtml(part.answer)
    return `<span class="cloze">${side === 'front' ? `[${escapeHtml(part.hint || '…')}]` : escapeHtml(part.answer)}</span>`
  }).join('')
}

function renderReading(value: string, filter: 'furigana' | 'kana' | 'kanji'): string {
  const annotation = /([^\s[\]<>]+)\[([^[\]<>]+)\]/g
  let html = ''
  let cursor = 0
  for (const match of value.matchAll(annotation)) {
    html += escapeHtml(value.slice(cursor, match.index))
    const [, base, reading] = match
    html += filter === 'furigana' ? `<ruby>${escapeHtml(base)}<rt>${escapeHtml(reading)}</rt></ruby>`
      : escapeHtml(filter === 'kana' ? reading : base)
    cursor = match.index + match[0].length
  }
  return html + escapeHtml(value.slice(cursor))
}

type Replacement = { field: string; filter?: 'text' | 'furigana' | 'kana' | 'kanji' | 'cloze' | 'type' | 'type-cloze' }

function replacement(raw: string): Replacement {
  const name = raw.trim()
  const parts = name.split(':')
  if (parts.length === 1) return { field: name }
  const [filter, second, third] = parts
  if (filter === 'type' && second === 'cloze' && third && parts.length === 3) return { field: third, filter: 'type-cloze' }
  if (['text', 'furigana', 'kana', 'kanji', 'cloze', 'type'].includes(filter) && second && parts.length === 2) return { field: second, filter: filter as Replacement['filter'] }
  throw new Error(`Unsupported template filter: ${parts.slice(0, -1).join(':')}`)
}

/** Validate the deliberately small template language before storing a template. */
export function validateTemplate(template: string, fieldNames: readonly string[], side: 'front' | 'back', kind: 'standard' | 'cloze' = 'standard'): void {
  const known = new Set(fieldNames)
  let section: string | undefined
  let cursor = 0
  for (const match of template.matchAll(token)) {
    if (/{{|}}/.test(template.slice(cursor, match.index))) throw new Error('Unmatched template delimiter')
    const [, marker, rawName] = match
    cursor = match.index + match[0].length
    const parsed = replacement(rawName)
    const name = parsed.field
    if (marker === '/') {
      if (section !== name) throw new Error(`Unmatched template conditional: ${name}`)
      section = undefined
      continue
    }
    if (name === 'FrontSide') {
      if (side === 'front') throw new Error('FrontSide is not allowed on the front template')
      if (marker || parsed.filter) throw new Error('FrontSide cannot be filtered or conditional')
    } else if (!known.has(name) && !(kind === 'cloze' && /^c[1-9]\d*$/.test(name) && marker)) throw new Error(`Unknown field in template: ${name}`)
    if (parsed.filter === 'cloze' || parsed.filter === 'type-cloze') {
      if (kind !== 'cloze') throw new Error('Cloze filter requires a cloze note type')
    }
    if (marker) {
      if (parsed.filter) throw new Error('Template conditionals cannot use filters')
      if (section) throw new Error('Nested template conditionals are not supported')
      section = name
    }
  }
  if (/{{|}}/.test(template.slice(cursor))) throw new Error('Unmatched template delimiter')
  if (section) throw new Error(`Unclosed template conditional: ${section}`)
}

/** Replace fields without evaluating template text or field contents as code. */
export function renderTemplate(template: string, fields: Record<string, string>, front?: string, options: RenderOptions = {}): RenderedTemplate {
  const side = options.side ?? (front === undefined ? 'front' : 'back')
  let html = ''
  let cursor = 0
  let section: { name: string; enabled: boolean } | undefined
  let visibleField = false
  let typedAnswer: string | undefined
  for (const match of template.matchAll(token)) {
    const position = match.index
    const [source, marker, rawName] = match
    const { field: name, filter } = replacement(rawName)
    if (!section || section.enabled) html += template.slice(cursor, position)
    cursor = position + source.length
    const ordinal = options.ordinal ?? (filter === 'cloze' || filter === 'type-cloze' ? clozeOrdinals(fields[name] ?? '')[0] : undefined)
    const conditionValue = /^c[1-9]\d*$/.test(name) && options.kind === 'cloze'
      ? Boolean(options.ordinal === Number(name.slice(1))) : Boolean(fields[name]?.trim())
    if (marker === '#' || marker === '^') {
      if (section) throw new Error('Nested template conditionals are not supported')
      section = { name, enabled: marker === '#' ? conditionValue : !conditionValue }
    } else if (marker === '/') {
      if (!section || section.name !== name) throw new Error(`Unmatched template conditional: ${name}`)
      section = undefined
    } else if (!section || section.enabled) {
      const value = name === 'FrontSide' ? (front ?? '') : (fields[name] ?? '')
      if (filter === 'type' || filter === 'type-cloze') {
        if (typedAnswer !== undefined) throw new Error('Only one typed answer is supported per card')
        typedAnswer = filter === 'type-cloze' ? parseCloze(value).filter((part): part is ClozePart => typeof part !== 'string' && part.ordinals.includes(ordinal ?? 0)).map((part) => part.answer).join(', ') : value
      } else {
        if (value.trim() && name !== 'FrontSide') visibleField = true
        html += name === 'FrontSide' ? value : filter === 'cloze'
          ? renderCloze(value, ordinal ?? 0, side)
          : filter === 'furigana' || filter === 'kana' || filter === 'kanji' ? renderReading(value, filter)
            : escapeHtml(value)
      }
    }
  }
  if (section) throw new Error(`Unclosed template conditional: ${section.name}`)
  html += template.slice(cursor)
  return { html, isEmpty: !visibleField, ...(typedAnswer !== undefined ? { typedAnswer } : {}) }
}

export function tryRenderTemplate(template: string, fields: Record<string, string>, front?: string, options: RenderOptions = {}): RenderResult {
  try {
    validateTemplate(template, Object.keys(fields), options.side ?? (front === undefined ? 'front' : 'back'), options.kind)
    return { ok: true, value: renderTemplate(template, fields, front, options) }
  }
  catch (reason) { return { ok: false, error: reason instanceof Error ? reason.message : 'Unable to render template' } }
}
