import { resolveTemplateNavigation } from './template-navigation'
import { sanitizeFieldHtml } from './field-html'

export interface RenderedTemplate {
  html: string
  isEmpty: boolean
  typedAnswer?: string
}

export interface RenderOptions {
  kind?: 'standard' | 'cloze'
  ordinal?: number
  side?: 'front' | 'back'
  htmlFields?: ReadonlySet<string>
  media?: Record<string, { kind: 'image' | 'audio'; url: string; automatic?: boolean }>
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
    if (!answer || answer.includes('{{') || hintParts.length > 1 || hintParts[0]?.includes('{{')) throw new Error(`Malformed cloze deletion near character ${match.index + 1}`)
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

const mediaToken = /\[\[kiroku-media:([^\]]+)]]/g

function resolveTemplateMedia(template: string, media: RenderOptions['media']) {
  let used = false
  const html = template.replace(/\[\[kiroku-media:([^\]]+)]]/g, (_token, encodedName: string) => {
    let name = encodedName
    try { name = decodeURIComponent(name) } catch { /* keep malformed marker inert */ }
    const source = media?.[name]
    if (!source) return `<span class="media-pending">[media unavailable: ${escapeHtml(name)}]</span>`
    used = true
    return source.kind === 'image'
      ? `<img class="card-image" src="${escapeHtml(source.url)}" alt="${escapeHtml(name)}">`
      : `<audio class="card-audio" controls${source.automatic ? ' autoplay' : ''} src="${escapeHtml(source.url)}">Audio: ${escapeHtml(name)}</audio>`
  })
  return { html, used }
}

function removeTemplateResourceElements(template: string): string {
  return template
    .replace(/<(script|style|object|iframe|audio|video|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:script|style|object|iframe|audio|video|svg|math|img|source|track|embed|link|base|meta)\b[^>]*\/?>/gi, '')
}

function renderField(value: string, media: RenderOptions['media'], preserveHtml = false): string {
  if (!preserveHtml) {
    let html = ''
    let cursor = 0
    for (const match of value.matchAll(mediaToken)) {
      html += escapeHtml(value.slice(cursor, match.index))
      cursor = match.index + match[0].length
      let name = match[1]
      try { name = decodeURIComponent(name) } catch { /* keep malformed token inert */ }
      const source = media?.[name]
      if (!source) html += `<span class="media-pending">[media unavailable: ${escapeHtml(name)}]</span>`
      else if (source.kind === 'image') html += `<img class="card-image" src="${escapeHtml(source.url)}" alt="${escapeHtml(name)}">`
      else html += `<audio class="card-audio" controls${source.automatic ? ' autoplay' : ''} src="${escapeHtml(source.url)}">Audio: ${escapeHtml(name)}</audio>`
    }
    return html + escapeHtml(value.slice(cursor))
  }
  const replacements = new Map<string, string>()
  let markerBase = '\uE000kiroku-media-slot-'
  while (value.includes(markerBase)) markerBase += 'x'
  const marked = value.replace(mediaToken, (_token, encodedName: string) => {
    let name = encodedName
    try { name = decodeURIComponent(name) } catch { /* keep malformed token inert */ }
    const source = media?.[name]
    const output = !source ? `<span class="media-pending">[media unavailable: ${escapeHtml(name)}]</span>`
      : source.kind === 'image' ? `<img class="card-image" src="${escapeHtml(source.url)}" alt="${escapeHtml(name)}">`
        : `<audio class="card-audio" controls${source.automatic ? ' autoplay' : ''} src="${escapeHtml(source.url)}">Audio: ${escapeHtml(name)}</audio>`
    const marker = `${markerBase}${replacements.size}\uE001`
    replacements.set(marker, output)
    return marker
  })
  let html = sanitizeFieldHtml(marked).html
  for (const [marker, replacement] of replacements) html = html.replaceAll(marker, replacement)
  return html
}

function renderCloze(value: string, ordinal: number, side: 'front' | 'back'): string {
  return parseCloze(value).map((part) => {
    if (typeof part === 'string') return escapeHtml(part)
    if (!part.ordinals.includes(ordinal)) return escapeHtml(part.answer)
    return `<span class="cloze">${side === 'front' ? `[${escapeHtml(part.hint || '…')}]` : escapeHtml(part.answer)}</span>`
  }).join('')
}

function renderReading(value: string, filter: 'furigana' | 'kana' | 'kanji'): string {
  const annotation = /(\p{Script=Han}+(?:[\p{Script=Hiragana}\p{Script=Katakana}]+)?)\[([^[\]<>]+)\]/gu
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

type Replacement = { field: string; filter?: 'text' | 'furigana' | 'kana' | 'kanji' | 'cloze' | 'type' | 'type-cloze' | 'hint' }

function replacement(raw: string, known: ReadonlySet<string>): Replacement {
  const name = raw.trim()
  if (known.has(name)) return { field: name }
  // Anki ignores empty filters, e.g. the extra separator in cloze::Text.
  // Keep the final field slot so an empty field remains invalid.
  const parts = name.split(':').filter((part, index, all) => part || index === all.length - 1)
  if (parts.length === 1) return { field: parts[0] }
  const [filter, second, third] = parts
  if (filter === 'type' && second === 'cloze' && third && parts.length === 3) return { field: third, filter: 'type-cloze' }
  if (['text', 'furigana', 'kana', 'kanji', 'cloze', 'type', 'hint'].includes(filter) && second && parts.length === 2) return { field: second, filter: filter as Replacement['filter'] }
  throw new Error(`Unsupported template filter: ${parts.slice(0, -1).join(':')}`)
}

function templateConditionValue(name: string, fields: Readonly<Record<string, string>>, options: Pick<RenderOptions, 'kind' | 'ordinal'>): boolean {
  return /^c[1-9]\d*$/.test(name) && options.kind === 'cloze'
    ? options.ordinal === Number(name.slice(1)) : Boolean(fields[name]?.trim())
}

type TemplateSection = { name: string; enabled: boolean }

function updateTemplateSections(sections: TemplateSection[], marker: string, name: string, value: boolean) {
  if (marker === '/') {
    if (sections.at(-1)?.name !== name) throw new Error(`Unmatched template conditional: ${name}`)
    sections.pop()
  } else {
    const parentEnabled = sections.at(-1)?.enabled ?? true
    sections.push({ name, enabled: parentEnabled && (marker === '#' ? value : !value) })
  }
}

/** Visible substitutions that retain appended image/audio markup. */
export function templateMediaFields(template: string, fields: Readonly<Record<string, string>>, options: Pick<RenderOptions, 'kind' | 'ordinal'> = {}): ReadonlySet<string> {
  const known = new Set(Object.keys(fields))
  const eligible = new Set<string>()
  const sections: TemplateSection[] = []
  for (const [, marker, rawName] of template.matchAll(token)) {
    const { field, filter } = replacement(rawName, known)
    if (marker) {
      updateTemplateSections(sections, marker, field, templateConditionValue(field, fields, options))
      continue
    }
    // Text strips HTML; answer inputs and hints do not display attached media.
    if ((sections.at(-1)?.enabled ?? true) && known.has(field) && !['text', 'type', 'type-cloze', 'hint'].includes(filter ?? '')) eligible.add(field)
  }
  return eligible
}

/** Validate the deliberately small template language before storing a template. */
export function validateTemplate(template: string, fieldNames: readonly string[], side: 'front' | 'back', kind: 'standard' | 'cloze' = 'standard'): void {
  const known = new Set(fieldNames)
  const sections: TemplateSection[] = []
  let cursor = 0
  for (const match of template.matchAll(token)) {
    if (/{{|}}/.test(template.slice(cursor, match.index))) throw new Error('Unmatched template delimiter')
    const [, marker, rawName] = match
    cursor = match.index + match[0].length
    const parsed = replacement(rawName, known)
    const name = parsed.field
    if (marker === '/') {
      updateTemplateSections(sections, marker, name, true)
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
      updateTemplateSections(sections, marker, name, true)
    }
  }
  if (/{{|}}/.test(template.slice(cursor))) throw new Error('Unmatched template delimiter')
  if (sections.length) throw new Error(`Unclosed template conditional: ${sections.at(-1)!.name}`)
}

/** Replace fields without evaluating template text or field contents as code. */
export function renderTemplate(template: string, fields: Record<string, string>, front?: string, options: RenderOptions = {}): RenderedTemplate {
  // Remove raw resource loaders before trusted local media placeholders are
  // expanded; CSP and a script-free sandbox remain second boundaries.
  const navigation = resolveTemplateNavigation(removeTemplateResourceElements(template), fields)
  template = navigation.markup
  const templateMedia = resolveTemplateMedia(template, options.media)
  template = templateMedia.html
  const side = options.side ?? (front === undefined ? 'front' : 'back')
  const known = new Set(Object.keys(fields))
  let html = ''
  let cursor = 0
  const sections: TemplateSection[] = []
  let visibleField = navigation.hasContent || templateMedia.used
  let typedAnswer: string | undefined
  let hintIndex = 0
  for (const match of template.matchAll(token)) {
    const position = match.index
    const [source, marker, rawName] = match
    const { field: name, filter } = replacement(rawName, known)
    if (sections.at(-1)?.enabled ?? true) html += template.slice(cursor, position)
    cursor = position + source.length
    const ordinal = options.ordinal ?? (filter === 'cloze' || filter === 'type-cloze' ? clozeOrdinals(fields[name] ?? '')[0] : undefined)
    const conditionValue = templateConditionValue(name, fields, options)
    if (marker) {
      updateTemplateSections(sections, marker, name, conditionValue)
    } else if (sections.at(-1)?.enabled ?? true) {
      const value = name === 'FrontSide' ? (front ?? '') : (fields[name] ?? '')
      if (filter === 'type' || filter === 'type-cloze') {
        if (typedAnswer !== undefined) throw new Error('Only one typed answer is supported per card')
        typedAnswer = filter === 'type-cloze' ? parseCloze(value).filter((part): part is ClozePart => typeof part !== 'string' && part.ordinals.includes(ordinal ?? 0)).map((part) => part.answer).join(', ') : value
        if (typedAnswer.trim()) visibleField = true
      } else {
        if (value.trim() && name !== 'FrontSide') visibleField = true
        html += filter === 'text' ? escapeHtml(value) : filter === 'hint' ? (value.trim() ? (() => { const id = `kiroku-hint-${hintIndex++}`; return `<div class="card-hint"><input class="card-hint-toggle" type="checkbox" id="${id}"><label for="${id}">Show ${escapeHtml(name)}</label><div class="card-hint-content">${renderField(value, options.media, options.htmlFields?.has(name))}</div></div>` })() : '') : name === 'FrontSide' ? value : filter === 'cloze'
          ? renderCloze(value, ordinal ?? 0, side)
          : filter === 'furigana' || filter === 'kana' || filter === 'kanji' ? renderReading(value, filter)
            : renderField(value, options.media, options.htmlFields?.has(name))
      }
    }
  }
  if (sections.length) throw new Error(`Unclosed template conditional: ${sections.at(-1)!.name}`)
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
