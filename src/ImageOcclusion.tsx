import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  collection,
  type CardRecord,
  type NewImageOcclusionNote,
  type Note,
  type OcclusionMask,
  type OcclusionMaskDraft,
} from './collection'
import { validateMedia } from './media'
import { useDialogKeyboard } from './use-dialog-keyboard'
import { userFacingStorageError } from './offline-storage'

type DraftMask = OcclusionMaskDraft & { localId: string }
type Point = { x: number; y: number }

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const draftId = () => crypto.randomUUID?.() ?? `mask-${Math.random().toString(36).slice(2)}`
const rounded = (value: number) => Number(value.toFixed(6))

export function normalizeOcclusionRect(start: Point, end: Point) {
  const left = clamp(Math.min(start.x, end.x))
  const top = clamp(Math.min(start.y, end.y))
  const right = clamp(Math.max(start.x, end.x))
  const bottom = clamp(Math.max(start.y, end.y))
  return { x: left, y: top, width: rounded(right - left), height: rounded(bottom - top) }
}

function useObjectUrl(blob?: Blob) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    let active = true
    const objectUrl = blob && URL.createObjectURL(blob)
    queueMicrotask(() => { if (active) setUrl(objectUrl) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [blob])
  return url
}

function toDraft(mask: OcclusionMaskDraft): DraftMask {
  return { ...mask, localId: draftId() }
}

function modelMasks(masks: DraftMask[]): OcclusionMaskDraft[] {
  return masks.map((mask) => ({
    ...(mask.id ? { id: mask.id } : {}),
    ...(mask.ordinal ? { ordinal: mask.ordinal } : {}),
    x: mask.x,
    y: mask.y,
    width: mask.width,
    height: mask.height,
  }))
}

function numeric(value: string, fallback: number) {
  const next = Number(value)
  return Number.isFinite(next) ? clamp(next / 100) : fallback
}

export function ImageOcclusionCanvas({
  imageUrl,
  masks,
  onChange,
  imageWidth = 1000,
  imageHeight = 1000,
  readOnly = false,
  activeMaskId,
  revealActive = false,
}: {
  imageUrl: string
  masks: readonly OcclusionMaskDraft[]
  onChange?: (masks: OcclusionMaskDraft[]) => void
  imageWidth?: number
  imageHeight?: number
  readOnly?: boolean
  activeMaskId?: string
  revealActive?: boolean
}) {
  const [drafts, setDrafts] = useState<DraftMask[]>(() => masks.map(toDraft))
  const draftsRef = useRef(drafts)
  const [selected, setSelected] = useState<string>()
  const gestureRef = useRef<{ kind: 'draw' | 'move' | 'resize'; localId: string; start: Point; original?: DraftMask } | undefined>(undefined)

  function publish(next: DraftMask[]) {
    draftsRef.current = next
    setDrafts(next)
    onChange?.(modelMasks(next))
  }

  function point(event: ReactPointerEvent<SVGSVGElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) }
  }

  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (readOnly) return
    const target = event.target as Element
    const targetMaskId = target.closest<SVGElement>('[data-mask-local-id]')?.dataset.maskLocalId
    const resize = target.closest('[data-mask-resize]') !== null
    const start = point(event)
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* A synthetic or interrupted pointer may no longer be capturable. */ }
    if (targetMaskId) {
      const original = draftsRef.current.find((mask) => mask.localId === targetMaskId)
      if (!original) return
      setSelected(targetMaskId)
      gestureRef.current = { kind: resize ? 'resize' : 'move', localId: targetMaskId, start, original }
      return
    }
    const localId = draftId()
    const mask: DraftMask = { localId, x: start.x, y: start.y, width: 0, height: 0 }
    publish([...draftsRef.current, mask])
    setSelected(localId)
    gestureRef.current = { kind: 'draw', localId, start }
  }

  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current
    if (!gesture || readOnly) return
    const current = point(event)
    publish(draftsRef.current.map((mask) => {
      if (mask.localId !== gesture.localId) return mask
      if (gesture.kind === 'draw') return { ...mask, ...normalizeOcclusionRect(gesture.start, current) }
      if (!gesture.original) return mask
      if (gesture.kind === 'resize') return { ...mask, ...normalizeOcclusionRect({ x: gesture.original.x, y: gesture.original.y }, current) }
      const x = clamp(gesture.original.x + current.x - gesture.start.x)
      const y = clamp(gesture.original.y + current.y - gesture.start.y)
      return { ...mask, x: Math.min(x, 1 - gesture.original.width), y: Math.min(y, 1 - gesture.original.height) }
    }))
  }

  function finishPointer(event: ReactPointerEvent<SVGSVGElement>, cancelled = false) {
    const gesture = gestureRef.current
    if (!gesture) return
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* The browser may have already released capture. */ }
    const current = draftsRef.current.find((mask) => mask.localId === gesture.localId)
    if (gesture.kind === 'draw' && current && (cancelled || current.width < .01 || current.height < .01)) publish(draftsRef.current.filter((mask) => mask.localId !== gesture.localId))
    gestureRef.current = undefined
  }

  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    finishPointer(event)
  }

  function pointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    finishPointer(event, true)
  }

  function updateMask(localId: string, patch: Partial<OcclusionMaskDraft>) {
    publish(draftsRef.current.map((mask) => {
      if (mask.localId !== localId) return mask
      const x = clamp(patch.x ?? mask.x)
      const y = clamp(patch.y ?? mask.y)
      return { ...mask, ...patch, x, y, width: Math.min(clamp(patch.width ?? mask.width), 1 - x), height: Math.min(clamp(patch.height ?? mask.height), 1 - y) }
    }))
  }

  const safeWidth = Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : 1000
  const safeHeight = Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : 1000
  return <div className="occlusion-canvas-wrap">
    <svg className={`occlusion-canvas${readOnly ? ' occlusion-review-canvas' : ''}`} viewBox={`0 0 ${safeWidth} ${safeHeight}`} role="img" aria-label={readOnly ? 'Image occlusion card' : 'Draw image occlusion masks'} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel}>
      <image href={imageUrl} x="0" y="0" width={safeWidth} height={safeHeight} preserveAspectRatio="none" />
      {drafts.map((mask, index) => {
        const active = mask.id === activeMaskId
        const hidden = !readOnly || !revealActive || !active
        return <g key={mask.localId} data-mask-local-id={mask.localId}>
          <rect x={mask.x * safeWidth} y={mask.y * safeHeight} width={mask.width * safeWidth} height={mask.height * safeHeight} className={hidden ? 'occlusion-mask' : 'occlusion-revealed-mask'} />
          {!readOnly && <>
            <rect x={mask.x * safeWidth} y={mask.y * safeHeight} width={mask.width * safeWidth} height={mask.height * safeHeight} className={selected === mask.localId ? 'occlusion-selection selected' : 'occlusion-selection'} aria-label={`Mask ${index + 1}`} />
            <rect data-mask-resize="true" x={(mask.x + mask.width) * safeWidth - 14} y={(mask.y + mask.height) * safeHeight - 14} width="28" height="28" className="occlusion-resize" aria-label={`Resize mask ${index + 1}`} />
          </>}
        </g>
      })}
    </svg>
    {!readOnly && <div className="occlusion-mask-controls" role="group" aria-label="Occlusion masks">
      {drafts.map((mask, index) => <fieldset key={mask.localId}>
        <legend>Mask {index + 1}{mask.ordinal ? ` · card ${mask.ordinal}` : ''}</legend>
        <label>Position X<input aria-label={`Mask ${index + 1} x position`} type="number" min="0" max="100" value={Math.round(mask.x * 100)} onChange={(event) => updateMask(mask.localId, { x: numeric(event.target.value, mask.x) })} /></label>
        <label>Position Y<input aria-label={`Mask ${index + 1} y position`} type="number" min="0" max="100" value={Math.round(mask.y * 100)} onChange={(event) => updateMask(mask.localId, { y: numeric(event.target.value, mask.y) })} /></label>
        <label>Width<input aria-label={`Mask ${index + 1} width`} type="number" min="1" max="100" value={Math.round(mask.width * 100)} onChange={(event) => updateMask(mask.localId, { width: numeric(event.target.value, mask.width) })} /></label>
        <label>Height<input aria-label={`Mask ${index + 1} height`} type="number" min="1" max="100" value={Math.round(mask.height * 100)} onChange={(event) => updateMask(mask.localId, { height: numeric(event.target.value, mask.height) })} /></label>
        <button className="text-button" type="button" onClick={() => publish(drafts.filter((candidate) => candidate.localId !== mask.localId))}>Remove mask {index + 1}</button>
      </fieldset>)}
      {!drafts.length && <p className="form-warning">Draw one or more rectangles over the image. Each rectangle creates one card.</p>}
    </div>}
  </div>
}

export function ImageOcclusionEditor({ deckId, note, onClose }: { deckId: string; note?: Note; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const source = useLiveQuery(async () => {
    if (!note?.imageOcclusion) return undefined
    const reference = await collection.noteMedia.get(note.imageOcclusion.sourceMediaId)
    if (!reference) return undefined
    return { reference, blob: await collection.verifiedMediaBlob(reference.digest) }
  }, [note?.id, note?.imageOcclusion?.sourceMediaId])
  const [image, setImage] = useState<File>()
  const decks = useLiveQuery(() => collection.decks.orderBy('name').toArray(), [], [])
  const [destinationDeckId, setDestinationDeckId] = useState(deckId)
  const [width, setWidth] = useState(note?.imageOcclusion?.imageWidth ?? 0)
  const [height, setHeight] = useState(note?.imageOcclusion?.imageHeight ?? 0)
  const [header, setHeader] = useState(note?.fields.header ?? '')
  const [backExtra, setBackExtra] = useState(note?.fields.backExtra ?? '')
  const [tags, setTags] = useState((note?.tags ?? []).join(', '))
  const [masks, setMasks] = useState<OcclusionMaskDraft[]>(() => note?.imageOcclusion?.masks ?? [])
  const [error, setError] = useState('')
  const fileUrl = useObjectUrl(image)
  const sourceUrl = useObjectUrl(source?.blob?.blob)
  const imageUrl = fileUrl ?? sourceUrl
  const imageId = useId()

  function chooseImage(file: File | undefined) {
    if (!file) return
    try {
      const media = validateMedia(file)
      if (media.kind !== 'image') throw new Error('Choose a PNG, JPEG, or WebP image.')
      setImage(file)
      setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to use that image') }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!imageUrl || !width || !height) { setError('Choose an image and wait for its dimensions to load.'); return }
    if (!masks.length) { setError('Draw at least one occlusion mask.'); return }
    const values = { imageWidth: width, imageHeight: height, header, backExtra, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), masks }
    try {
      if (note) await collection.updateImageOcclusionNote(note.id, image ? { ...values, image } : values)
      else if (image) await collection.createImageOcclusionNote(destinationDeckId, { ...values, image } satisfies NewImageOcclusionNote)
      else throw new Error('Choose a source image.')
      onClose()
    } catch (reason) { setError(userFacingStorageError(reason, 'Unable to save image occlusion note')) }
  }

  return <div className="dialog-backdrop">
    <section {...dialogKeyboard} className="dialog note-dialog occlusion-dialog" role="dialog" aria-modal="true" aria-labelledby="occlusion-dialog-title">
      <span className="section-code">IMAGE OCCLUSION // {note ? 'EDIT' : 'NEW'}</span>
      <h2 id="occlusion-dialog-title">{note ? 'Edit image occlusion note' : 'Add image occlusion note'}</h2>
      <form onSubmit={submit}>
        <label htmlFor={imageId}>Source image
          <input id={imageId} aria-label="Source image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseImage(event.target.files?.[0])} />
          <small>PNG, JPEG, or WebP up to 10 MB. Draw, drag, or resize a rectangle directly on the image.</small>
        </label>
        {imageUrl && <>
          <img className="occlusion-size-probe" src={imageUrl} alt="" onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            if (!naturalWidth || !naturalHeight) { setError('This image has no usable dimensions.'); return }
            if (image || !width || !height) { setWidth(naturalWidth); setHeight(naturalHeight) }
          }} />
          <ImageOcclusionCanvas imageUrl={imageUrl} imageWidth={width} imageHeight={height} masks={masks} onChange={setMasks} />
        </>}
        {!imageUrl && note && source === undefined && <p className="form-warning" role="status">The source image has not finished syncing to this device.</p>}
        <label>Header<textarea value={header} onChange={(event) => setHeader(event.target.value)} rows={2} /></label>
        <label>Back Extra<textarea value={backExtra} onChange={(event) => setBackExtra(event.target.value)} rows={3} /></label>
        <label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="anatomy, bones" /><small>Separate tags with commas.</small></label>
        <label>Destination deck<select value={destinationDeckId} disabled={Boolean(note)} onChange={(event) => setDestinationDeckId(event.target.value)}>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">{note ? 'Save changes' : 'Save note'}</button></div>
      </form>
    </section>
  </div>
}

export function ImageOcclusionReview({ note, card, showAnswer, imageUrl }: { note: Note; card: CardRecord; showAnswer: boolean; imageUrl?: string }) {
  const masks = useMemo<OcclusionMask[]>(() => note.imageOcclusion?.masks ?? [], [note.imageOcclusion])
  if (!note.imageOcclusion) return <p className="form-error" role="alert">Image occlusion metadata is missing.</p>
  if (!imageUrl) return <p className="media-pending" role="status">The source image will be available after its media sync finishes.</p>
  return <div className="occlusion-review">
    {note.fields.header && <p className="occlusion-header">{note.fields.header}</p>}
    <ImageOcclusionCanvas key={`${note.updatedAt}:${card.occlusionId}`} imageUrl={imageUrl} imageWidth={note.imageOcclusion.imageWidth} imageHeight={note.imageOcclusion.imageHeight} masks={masks} readOnly activeMaskId={card.occlusionId} revealActive={showAnswer} />
    {showAnswer && note.fields.backExtra && <p className="occlusion-back-extra">{note.fields.backExtra}</p>}
  </div>
}
