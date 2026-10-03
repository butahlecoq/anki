import type { CardTemplate, NoteMediaReference, NoteType } from './collection'
import { tryRenderTemplate, type RenderOptions, type RenderedTemplate } from './template-renderer'

export interface CardMediaDescription {
  id: string
  kind: NoteMediaReference['kind']
  displayName: string
  side: NoteMediaReference['side']
  /** 'automatic' audio plays on its own; 'manual' waits for the learner. */
  playback: NoteMediaReference['playback']
  url?: string
}

export interface RenderedCard {
  front?: RenderedTemplate
  back?: RenderedTemplate
  typedAnswer?: string
  isEmpty: boolean
  css: string
  media: CardMediaDescription[]
  /** A failure on the front alone. It suppresses the card, because there is
   * nothing to show. */
  error?: string
  /** A failure on the back alone. The question is still worth showing, so this
   * is reported beside the card rather than in place of it. */
  backError?: string
}

export function fieldsByName(fields: readonly { id: string; name: string }[], valuesById: Record<string, string>) {
  return Object.fromEntries(fields.map((field) => [field.name, valuesById[field.id] ?? '']))
}

export function describeCardMedia(reference: NoteMediaReference, url?: string): CardMediaDescription {
  return {
    id: reference.id,
    kind: reference.kind,
    displayName: reference.displayName,
    side: reference.side,
    playback: reference.playback,
    ...(url ? { url } : {}),
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
    ...(back.ok ? { back: back.value } : { backError: back.error }),
    ...(front.value.typedAnswer !== undefined ? { typedAnswer: front.value.typedAnswer } : {}),
    isEmpty: front.value.isEmpty,
    css: template.css,
    media: attachments,
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

/**
 * Whether this card can be shown to a learner.
 *
 * A card is displayable unless its front renders to nothing. An image occlusion
 * note has no front template at all, so an empty front is expected rather than a
 * fault and the card is still displayable. A front that failed to render is
 * displayable too: the error is reported, but the card must not become
 * permanently unanswerable because of it.
 */
export function isRenderedCardDisplayable(card: Pick<RenderedCard, 'isEmpty' | 'error'>, kind?: NoteType['kind']) {
  if (card.error) return true
  if (kind === 'image-occlusion') return true
  return !card.isEmpty
}
