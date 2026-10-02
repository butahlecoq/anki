import type { CardTemplate, NoteMediaReference, NoteType } from './collection'
import { tryRenderTemplate, type RenderOptions, type RenderedTemplate } from './template-renderer'

export interface CardMediaDescription {
  id: string
  kind: NoteMediaReference['kind']
  displayName: string
  side: NoteMediaReference['side']
  playback: NoteMediaReference['playback']
  url?: string
  automatic: boolean
}

export interface RenderedCard {
  front?: RenderedTemplate
  back?: RenderedTemplate
  typedAnswer?: string
  isEmpty: boolean
  css: string
  media: CardMediaDescription[]
  error?: string
}

export function fieldsByName(fields: readonly { id: string; name: string }[], valuesById: Record<string, string>) {
  return Object.fromEntries(fields.map((field) => [field.name, valuesById[field.id] ?? '']))
}

export function describeCardMedia(reference: NoteMediaReference, url?: string, automatic = false): CardMediaDescription {
  return {
    id: reference.id,
    kind: reference.kind,
    displayName: reference.displayName,
    side: reference.side,
    playback: reference.playback,
    ...(url ? { url } : {}),
    automatic,
  }
}

export function renderCard(
  template: Pick<CardTemplate, 'front' | 'back' | 'css'>,
  fields: Record<string, string>,
  options: Pick<RenderOptions, 'kind' | 'ordinal' | 'media'> = {},
  attachments: CardMediaDescription[] = [],
): RenderedCard {
  const front = tryRenderTemplate(template.front, fields, undefined, { ...options, side: 'front' })
  if (!front.ok) return { isEmpty: false, css: template.css, media: attachments, error: front.error }
  const back = tryRenderTemplate(template.back, fields, front.value.html, { ...options, side: 'back' })
  return {
    front: front.value,
    ...(back.ok ? { back: back.value } : {}),
    ...(front.value.typedAnswer !== undefined ? { typedAnswer: front.value.typedAnswer } : {}),
    isEmpty: front.value.isEmpty,
    css: template.css,
    media: attachments,
    ...(!back.ok ? { error: back.error } : {}),
  }
}

export function renderNoteCard(
  noteType: Pick<NoteType, 'kind' | 'fields'>,
  template: Pick<CardTemplate, 'front' | 'back' | 'css'>,
  fieldsById: Record<string, string>,
  ordinal?: number,
  media?: RenderOptions['media'],
  attachments: CardMediaDescription[] = [],
) {
  return renderCard(template, fieldsByName(noteType.fields, fieldsById), {
    kind: noteType.kind === 'image-occlusion' ? 'standard' : noteType.kind,
    ordinal,
    media,
  }, attachments)
}

/** A side error is reported separately; only the front's rendered emptiness controls card eligibility. */
export function isRenderedCardEmpty(card: Pick<RenderedCard, 'isEmpty'>) {
  return card.isEmpty
}
