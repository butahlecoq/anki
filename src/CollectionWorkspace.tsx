import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Rating,
  BASIC_NOTE_TYPE_ID,
  IMAGE_OCCLUSION_NOTE_TYPE_ID,
  collection,
  type Deck,
  type DeckCounts,
  type DeckOptionGroup,
  type DeckOptionSettings,
  type DeckSummary,
  type CardRecord,
  type Grade,
  type Note,
  type NoteMediaReference,
} from './collection'
import { MediaRenderer } from './MediaRenderer'
import { replayAudioElements } from './audio-playback'
import { ImageOcclusionEditor, ImageOcclusionReview } from './ImageOcclusion'
import { NoteTypeManager } from './NoteTypeManager'
import { TemplatePreview } from './TemplatePreview'
import { useReviewMedia } from './use-review-media'
import { validateMedia } from './media'
import { createAndDownloadPcBackup, listPcBackups, pairCollection, previewPcBackupRestore, syncCollection, type PcBackup } from './sync-client'
import { supportsServiceWorkers } from './browser-capabilities'
import { rotateCredential } from './sync-client'
import { clozeOrdinals } from './template-renderer'
import { compareTypedAnswer } from './typed-answer'
import { prepareAnkiImport, type PreparedAnkiImport } from './anki-import'
import { CardHistory, Statistics, TodayWorkload } from './Statistics'
import { CollectionBrowser } from './CollectionBrowser'
import { unavailableReason } from './scheduler'
import { describeCardMedia, isRenderedCardDisplayable, renderNoteCard } from './card-rendering'
import { undoAnnouncement, undoLabel } from './undo'
import { ExportDialog } from './ExportDialog'
import { CustomStudy } from './CustomStudy'
import { answerCustomStudy, customStudyQueue, practiceChoices, undoCustomStudy } from './custom-study'
import { customStudySessions } from './custom-study-state'
import { isShortcutBlocked } from './keyboard-shortcuts'
import { TextCollectionDialog } from './TextCollectionDialog'
import { SyncConflicts } from './SyncConflicts'
import { loadSampleDeck, removeSampleDeck, SAMPLE_DECK_NAME } from './sample-deck'
import { useRoute } from './route'
import { pairOutcomeMessage, pairingClosesOn, SYNC_LOCAL_ONLY, syncOutcomeMessage } from './sync-messages'
import { useDialogKeyboard } from './use-dialog-keyboard'

function CountStrip({ counts, reviews }: { counts: DeckCounts; reviews: number }) {
  return (
    <div className="count-strip" role="group" aria-label="Deck counts">
      <span>NEW <strong>{counts.new}</strong></span>
      <span>LEARNING <strong>{counts.learning}</strong></span>
      <span>REVIEW <strong>{counts.review}</strong></span>
      <span>REVIEWS <strong>{reviews}</strong></span>
    </div>
  )
}

function DeckDialog({ deck, parentId, onClose }: { deck?: Deck; parentId?: string; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const [name, setName] = useState(deck?.name ?? '')
  const [error, setError] = useState('')
  const title = deck ? 'Rename deck' : parentId ? 'Create a child deck' : 'Create a deck'

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      if (deck) await collection.renameDeck(deck.id, name)
      else await collection.createDeck(name, { parentId })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save deck')
    }
  }

  return (
    <div className="dialog-backdrop">
      <section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="deck-dialog-title">
        <span className="section-code">DECK // {deck ? 'EDIT' : 'NEW'}</span>
        <h2 id="deck-dialog-title">{title}</h2>
        <form onSubmit={submit}>
          <label>
            Deck name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="text-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-action" type="submit">{deck ? 'Save name' : parentId ? 'Create child deck' : 'Create deck'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

type PendingAttachment = { file: File; side: 'front' | 'back'; playback: 'automatic' | 'manual' }

function NoteDialog({ deckId, note, onClose }: { deckId: string; note?: Note; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const noteTypes = useLiveQuery(() => collection.noteTypes.orderBy('name').toArray(), [], [])
  const [typeId, setTypeId] = useState(note?.typeId ?? BASIC_NOTE_TYPE_ID)
  const [imageEditor, setImageEditor] = useState(note?.typeId === IMAGE_OCCLUSION_NOTE_TYPE_ID)
  const noteType = noteTypes.find((type) => type.id === typeId)
  const [fields, setFields] = useState<Record<string, string>>(note?.fields ?? {})
  const [error, setError] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const textareas = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const existingMedia = useLiveQuery(() => note ? collection.mediaForNote(note.id) : [], [note?.id], [])
  const generation = noteType ? collection.tryCardGenerationStatus(noteType, fields) : undefined
  const clozeEditorField = noteType?.kind === 'cloze' ? noteType.templates[0]?.front.match(/{{\s*cloze:([^{}:]+?)\s*}}/)?.[1].trim() : undefined

  if (imageEditor) return <ImageOcclusionEditor deckId={deckId} note={note} onClose={onClose} />

  function makeCloze(fieldId: string) {
    const textarea = textareas.current[fieldId]
    if (!textarea) return
    const value = fields[fieldId] ?? ''
    const { selectionStart: start, selectionEnd: end } = textarea
    if (start === end) { setError('Select text to make a cloze deletion'); return }
    if (/{{|}}/.test(value.slice(start, end)) || [...value.matchAll(/{{c\d+::[\s\S]*?}}/g)].some((match) => start < match.index + match[0].length && end > match.index)) {
      setError('Select text outside existing deletions'); return
    }
    try {
      const ordinal = Math.max(0, ...clozeOrdinals(value)) + 1
      const replacement = `{{c${ordinal}::${value.slice(start, end)}}}`
      setFields((current) => ({ ...current, [fieldId]: value.slice(0, start) + replacement + value.slice(end) }))
      setError('')
      requestAnimationFrame(() => { textarea.focus(); textarea.setSelectionRange(start, start + replacement.length) })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to make cloze deletion')
    }
  }

  function selectMedia(files: FileList | null) {
    if (!files?.length) return
    try {
      const next = Array.from(files).map((file) => {
        const definition = validateMedia(file)
        return { file, side: 'front' as const, playback: definition.kind === 'audio' ? 'automatic' as const : 'manual' as const }
      })
      setAttachments((current) => [...current, ...next])
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to attach media')
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      if (note) {
        if (typeId === BASIC_NOTE_TYPE_ID) await collection.updateBasicNote(note.id, { front: fields.front ?? '', back: fields.back ?? '' })
        else await collection.updateNote(note.id, fields)
        await Promise.all(attachments.map(({ file, side, playback }) => collection.attachMedia(note.id, { file, side, playback })))
      } else if (typeId === BASIC_NOTE_TYPE_ID) await collection.createBasicNoteWithMedia(deckId, { front: fields.front ?? '', back: fields.back ?? '' }, attachments)
      else await collection.createNote(deckId, typeId, fields)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save note')
    }
  }

  return (
    <div className="dialog-backdrop">
      <section {...dialogKeyboard} className="dialog note-dialog" role="dialog" aria-modal="true" aria-labelledby="note-dialog-title">
        <span className="section-code">{noteType?.name.toUpperCase() ?? 'NOTE'} // {note ? 'EDIT' : 'NEW'}</span>
        <h2 id="note-dialog-title">{note ? `Edit ${noteType?.name ?? ''} note` : `Add a ${noteType?.name ?? ''} note`}</h2>
        <form onSubmit={submit}>
          <label>Note type
            <select value={typeId} disabled={Boolean(note)} onChange={(event) => { if (event.target.value === IMAGE_OCCLUSION_NOTE_TYPE_ID) { setImageEditor(true); return } setTypeId(event.target.value); setFields({}); setAttachments([]) }}>
              {noteTypes.map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}
            </select>
          </label>
          {noteType?.fields.map((field, index) => <div key={field.id}>
            <label>{typeId === BASIC_NOTE_TYPE_ID ? field.name[0].toUpperCase() + field.name.slice(1) : field.name}
              <textarea ref={(element) => { textareas.current[field.id] = element }} lang="ja" value={fields[field.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [field.id]: event.target.value }))} rows={index === 0 ? 3 : 4} />
            </label>
            {clozeEditorField === field.name && <button className="text-button" type="button" onClick={() => makeCloze(field.id)}>Make cloze</button>}
          </div>)}
          {noteType?.kind === 'cloze' && <small>Select text and choose Make cloze, or type {'{{c1::answer::optional hint}}'} directly. Each number creates one card.</small>}
          {typeId === BASIC_NOTE_TYPE_ID && <label>
            Images and audio
            <input type="file" multiple accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/ogg,audio/wav" onChange={(event) => selectMedia(event.target.files)} />
            <small>PNG, JPEG, WebP up to 10 MB; MP3, Ogg, WAV up to 20 MB.</small>
          </label>}
          {attachments.map((attachment, index) => (
            <div className="media-attachment" key={`${attachment.file.name}-${index}`}>
              <strong>{attachment.file.name}</strong>
              <label>Show on <select value={attachment.side} onChange={(event) => setAttachments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, side: event.target.value as PendingAttachment['side'] } : item))}><option value="front">front</option><option value="back">back</option></select></label>
              {attachment.file.type.startsWith('audio/') && <label>Play <select value={attachment.playback} onChange={(event) => setAttachments((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, playback: event.target.value as PendingAttachment['playback'] } : item))}><option value="automatic">automatically</option><option value="manual">manually</option></select></label>}
              <button className="text-button" type="button" onClick={() => setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index))}>Remove</button>
            </div>
          ))}
          {existingMedia.map((media) => <ExistingMedia key={media.id} media={media} />)}
          {note?.retiredFields && Object.keys(note.retiredFields).length > 0 && <section className="retired-fields" aria-label="Retired fields">
            <h3>Retired fields</h3>
            <p>Saved values from fields that are no longer part of this note type.</p>
            <dl>{Object.entries(note.retiredFields).map(([fieldId, value]) => <div key={fieldId}><dt>Retired field · {fieldId}</dt><dd>{value || '(empty)'}</dd></div>)}</dl>
          </section>}
          {typeId !== BASIC_NOTE_TYPE_ID && generation?.ok && <p className="card-generation-status" aria-live="polite">{generation.value.eligible.length} {generation.value.eligible.length === 1 ? 'card' : 'cards'} will be created.</p>}
          {generation?.ok && generation.value.skipped.map(({ templateId, reason }) => <p className="form-warning" role="status" key={templateId}>{noteType?.templates.find((template) => template.id === templateId)?.name}: {reason}. No card will be created.</p>)}
          {generation && !generation.ok && <p className="form-error" role="alert">{generation.error}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="text-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-action" type="submit">{note ? 'Save changes' : 'Save note'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function ExistingMedia({ media }: { media: NoteMediaReference }) {
  const [error, setError] = useState('')
  return <div className="media-attachment"><strong>{media.displayName}</strong><span>{media.side} · {media.kind}</span><button className="text-button" type="button" onClick={() => void collection.removeMedia(media.id).catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to remove media'))}>Remove</button>{error && <p className="form-error" role="alert">{error}</p>}</div>
}

function SyncControls({ offlineSyncAvailable }: { offlineSyncAvailable: boolean }) {
  const settings = useLiveQuery(() => collection.syncSettings(), [], undefined)
  const [pairing, setPairing] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [code, setCode] = useState('')
  const [message, setMessage] = useState(SYNC_LOCAL_ONLY)
  const [busy, setBusy] = useState(false)
  const offlineShellSupported = supportsServiceWorkers()
  const pairingKeyboard = useDialogKeyboard(() => setPairing(false), pairing)
  const [backups, setBackups] = useState<PcBackup[]>([])
  const [restorePreview, setRestorePreview] = useState('')

  useEffect(() => {
    if (!settings) return
    let active = true
    void listPcBackups(settings).then(({ backups: latest }) => { if (active) setBackups(latest) }).catch(() => { if (active) setBackups([]) })
    return () => { active = false }
  }, [settings])

  async function pair(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    const result = await pairCollection(collection, endpoint, code)
    setBusy(false)
    setMessage(pairOutcomeMessage(result.state))
    // Only a successful pairing closes the form; a rejection keeps the code the
    // learner just typed, which is the one thing that could still work.
    if (pairingClosesOn(result.state)) {
      setPairing(false)
      setCode('')
    }
  }

  async function sync() {
    if (!offlineSyncAvailable || !offlineShellSupported) {
      setMessage('Sync is paused until Kiroku confirms its offline app shell is ready. Keep this page open and retry once it is ready.')
      return
    }
    // With no pairing yet, "Sync now" means "connect a PC".
    if (!settings) {
      setPairing(true)
      return
    }
    setBusy(true)
    setMessage('Syncing your collection…')
    try {
      const result = await syncCollection(collection, fetch.bind(window), (progress) => {
        if (progress.phase === 'records') setMessage(`Syncing records · ${progress.completed} accepted · ${progress.pending} local changes remain · cursor ${progress.cursor}.${progress.remoteChangesPending ? ' More PC records are queued.' : ''}`)
        else if (progress.phase === 'upload') setMessage(`Uploading media · ${progress.completed} sent · ${progress.pending} waiting.`)
        else setMessage(`Downloading media · ${progress.completed} saved · ${progress.pending} waiting.`)
      })
      if (result.state === 'complete') {
        if (settings) void listPcBackups(settings).then(({ backups: latest }) => setBackups(latest)).catch(() => {})
        const conflicts = await collection.syncConflicts.count()
        setMessage(syncOutcomeMessage({ ...result, conflicts }))
      } else setMessage(syncOutcomeMessage(result))
    } catch (error) {
      setMessage(error instanceof Error ? `Sync stopped safely. ${error.message} Your local changes remain on this device; reconnect and retry.` : 'Sync stopped safely. Your local changes remain on this device; reconnect and retry.')
    } finally { setBusy(false) }
  }

  async function backupPcCollection() {
    if (!settings) return
    setBusy(true)
    try {
      const { manifest, bytes } = await createAndDownloadPcBackup(settings)
      const url = URL.createObjectURL(bytes)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `kiroku-backup-${manifest.createdAt.slice(0, 10)}.zip`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setBackups((current) => [manifest, ...current.filter((backup) => backup.id !== manifest.id)])
      const mediaBytes = manifest.media.reduce((total, item) => total + item.byteLength, 0)
      setMessage(`Verified backup downloaded · ${manifest.changeCount} sync changes · ${manifest.media.length} media files (${(mediaBytes / 1024 / 1024).toFixed(1)} MiB) · ${new Date(manifest.createdAt).toLocaleString()}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'PC backup failed. The active collection was left unchanged.')
    } finally { setBusy(false) }
  }

  async function previewPcRestore(backup: PcBackup) {
    if (!settings) return
    setBusy(true)
    try {
      const preview = await previewPcBackupRestore(settings, backup.id)
      const mediaMiB = (preview.mediaBytes / 1024 / 1024).toFixed(1)
      setRestorePreview(`${new Date(preview.manifest.createdAt).toLocaleString()} · ${preview.changeCount} sync changes through cursor ${preview.latestCursor} · ${preview.manifest.media.length} verified media files (${mediaMiB} MiB). ${preview.restoreBlocker}`)
    } catch (error) { setRestorePreview(error instanceof Error ? error.message : 'Restore preview could not be verified.') }
    finally { setBusy(false) }
  }

  async function rotateDeviceCredential() {
    if (!settings) return
    setBusy(true)
    const result = await rotateCredential(settings)
    if (result.state === 'rotated') {
      try {
        await collection.configureSync({ ...settings, token: result.token })
        setMessage('Device key rotated. The previous key can no longer sync this collection.')
      } catch {
        setMessage('The PC rotated this device key, but it could not be saved here. Pair this device again to reconnect.')
      }
    } else if (result.state === 'authentication-required') {
      setMessage('This device key has expired or was already rotated. Pair this device again to reconnect.')
    } else if (result.state === 'indeterminate') {
      setMessage('The PC may have rotated this device key, but confirmation was lost. Create a new pairing code on the PC and pair this device again before syncing.')
    } else {
      setMessage('This PC address is not safe for key rotation. Check its HTTPS address; no request was sent.')
    }
    setBusy(false)
  }

  return (
    <section className="sync-controls" aria-label="PC sync">
      <div><span className="section-code">SYNC // {settings ? 'PAIRED' : 'LOCAL ONLY'}</span><p aria-live="polite">{settings && !offlineSyncAvailable ? 'Sync is paused until Kiroku confirms its offline app shell is ready.' : message}</p></div>
      <div className="sync-actions">
        {settings && <button className="text-button" type="button" disabled={busy || !offlineSyncAvailable || !offlineShellSupported} onClick={() => void sync()}>{busy ? 'Syncing…' : 'Sync now'}</button>}
        {settings && <button className="text-button" type="button" disabled={busy} onClick={() => void backupPcCollection()}>{busy ? 'Working…' : 'Download PC backup'}</button>}
        {settings && <button className="text-button" type="button" disabled={busy} title="Invalidates this device’s previous key immediately" onClick={() => void rotateDeviceCredential()}>{busy ? 'Working…' : 'Rotate device key'}</button>}
        <button className="primary-action" type="button" disabled={busy} onClick={() => setPairing(true)}>{settings ? 'Pair another device' : 'Connect a PC'}</button>
      </div>
      {settings && backups[0] && <p className="sync-help">Latest verified PC backup: {new Date(backups[0].createdAt).toLocaleString()} · {backups[0].changeCount} sync changes · {backups[0].media.length} media files · {backups[0].reason === 'manual' ? 'manual' : 'before sync'}.</p>}
      {settings && backups[0] && <p className="sync-help"><button className="text-button" type="button" disabled={busy} onClick={() => void previewPcRestore(backups[0])}>Preview latest backup</button>{restorePreview && <span role="status"> {restorePreview}</span>}</p>}
      {pairing && (
        <div className="dialog-backdrop">
          <section {...pairingKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title">
            <span className="section-code">SYNC // PAIR DEVICE</span>
            <h2 id="sync-dialog-title">Connect to your PC</h2>
            <form onSubmit={pair}>
              <label>
                PC service address
                <input inputMode="url" placeholder="https://pc.example.net:4174" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required />
              </label>
              <label>
                One-time pairing code
                <input autoCapitalize="characters" value={code} onChange={(event) => setCode(event.target.value)} required />
              </label>
              <p className="sync-help">On the PC, run <code>npm run server:pair</code> to create a one-time code.</p>
              <div className="dialog-actions">
                <button className="text-button" type="button" disabled={busy} onClick={() => setPairing(false)}>Cancel</button>
                <button className="primary-action" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect device'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const [prepared, setPrepared] = useState<PreparedAnkiImport>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function selectPackage(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    setError('')
    setPrepared(undefined)
    try {
      setPrepared(await prepareAnkiImport(file, collection))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to preview package')
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    if (!prepared) return
    setBusy(true)
    setError('')
    try {
      await prepared.commit()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import package')
    } finally {
      setBusy(false)
    }
  }

  const count = (value: number, singular: string, plural = `${singular}s`) => `${value} ${value === 1 ? singular : plural}`
  return <div className="dialog-backdrop">
    <section {...dialogKeyboard} className="dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <span className="section-code">ANKI // PACKAGE IMPORT</span>
      <h2 id="import-dialog-title">Import Anki package</h2>
      <p className="dialog-intro">Preview a local .apkg or .colpkg before making one atomic change to this collection.</p>
      <label>Anki package
        <input type="file" accept=".apkg,.colpkg,application/octet-stream" disabled={busy} onChange={(event) => void selectPackage(event.target.files)} />
      </label>
      {busy && !prepared && <p className="media-pending" role="status">Reading package…</p>}
      {prepared && <>
        <section className="import-summary" aria-label="Package summary">
          <h3>{prepared.filename}</h3>
          <ul>
            <li>{count(prepared.summary.decks, 'deck')}</li>
            <li>{count(prepared.summary.noteTypes, 'note type')}</li>
            <li>{count(prepared.summary.notes, 'note')}</li>
            <li>{count(prepared.summary.cards, 'card')}</li>
            <li>{count(prepared.summary.reviews, 'review')}</li>
            <li>{count(prepared.summary.media, 'media file')}</li>
          </ul>
        </section>
        <section className="import-policy" aria-label="Duplicate policy">
          <h3>Duplicate policy</h3>
          <p>Stable Anki note identities are created once. A newer package updates its note; a newer local edit is kept. Review entries are added once.</p>
          <dl>
            <div><dt>Create</dt><dd>{prepared.duplicates.create}</dd></div>
            <div><dt>Update</dt><dd>{prepared.duplicates.update}</dd></div>
            <div><dt>Keep local</dt><dd>{prepared.duplicates.keepLocal}</dd></div>
            <div><dt>Unchanged</dt><dd>{prepared.duplicates.unchanged}</dd></div>
          </dl>
        </section>
        {prepared.issues.length > 0 && <section className="import-report" aria-label="Import report">
          <h3>Import report</h3>
          <ul>{prepared.issues.map((issue, index) => <li className={`import-${issue.severity}`} key={`${issue.code}-${issue.subject}-${index}`}><strong>{issue.subject}</strong><span>{issue.detail}</span></li>)}</ul>
        </section>}
      </>}
      {prepared?.plan.blocksImport && <p className="form-error" role="alert">This package has unsupported content. Nothing will be imported until the reported errors are resolved.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="text-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary-action" type="button" disabled={!prepared || busy || prepared.plan.blocksImport} onClick={() => void commit()}>{busy && prepared ? 'Importing…' : 'Import package'}</button>
      </div>
    </section>
  </div>
}

function EmptyCollection({ onNewDeck, onImport }: { onNewDeck: () => void; onImport: () => void }) {
  const [loadingSample, setLoadingSample] = useState(false)
  const [sampleError, setSampleError] = useState('')
  async function loadSample() {
    setLoadingSample(true)
    setSampleError('')
    try { await loadSampleDeck() }
    catch (reason) { setSampleError(reason instanceof Error ? reason.message : 'Unable to load the sample deck.') }
    finally { setLoadingSample(false) }
  }
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="section-code">01 // HOME</div>
          <h1>Your Japanese <br /><em>study system</em></h1>
          <p>A calm, local-first workspace for deliberate practice. Your collection lives on your device—not behind a subscription.</p>
        </div>
        <div className="kana-field" aria-hidden="true">
          <span>あ</span><span>記</span><span>学</span>
          <div className="orbit one" /><div className="orbit two" />
        </div>
      </section>
      <section className="workspace-grid single">
        <article className="empty-panel">
          <div className="panel-heading">
            <div><span className="section-code">DECKS // 00</span><h2>Start with one deck</h2></div>
            <span className="keycap">N</span>
          </div>
          <div className="empty-card">
            <span className="empty-glyph" lang="ja">一</span>
            <div><h3>Your collection is clear.</h3><p>Create a focused deck, add a Japanese card, and begin your first offline review.</p></div>
            <div className="empty-actions"><button className="primary-action" type="button" onClick={onNewDeck}>New deck</button><button className="primary-action" type="button" disabled={loadingSample} onClick={() => void loadSample()}>{loadingSample ? 'Loading sample…' : 'Load sample deck'}</button><button className="text-button" type="button" onClick={onImport}>Import Anki package</button></div>
            {sampleError && <p className="form-error" role="alert">{sampleError}</p>}
            <small>Your decks and reviews stay in this browser.</small>
          </div>
        </article>
      </section>
    </>
  )
}

function DeckList({ decks, onNewDeck, onImport, onOpen }: { decks: DeckSummary[]; onNewDeck: () => void; onImport: () => void; onOpen: (id: string) => void }) {
  const children = new Map<string | null, DeckSummary[]>()
  for (const deck of decks) children.set(deck.parentId, [...(children.get(deck.parentId) ?? []), deck])
  const ordered: Array<{ deck: DeckSummary; depth: number }> = []
  const visit = (parentId: string | null, depth: number) => {
    for (const deck of (children.get(parentId) ?? []).sort((left, right) => left.name.localeCompare(right.name))) {
      ordered.push({ deck, depth })
      visit(deck.id, depth + 1)
    }
  }
  visit(null, 1)
  return (
    <>
      <section className="compact-hero">
        <div><span className="section-code">01 // COLLECTION</span><h1>Choose what to <em>remember</em></h1><p>Everything here is stored locally and ready whenever you are.</p></div>
        <div className="collection-actions"><button className="text-button" type="button" onClick={onImport}>Import Anki package</button><button className="primary-action" type="button" onClick={onNewDeck}>New deck</button></div>
      </section>
      <TodayWorkload />
      <section className="deck-grid deck-tree" role="tree" aria-label="Deck hierarchy">
        {ordered.map(({ deck, depth }) => (
          <article className="deck-tile" role="treeitem" aria-level={depth} style={{ '--deck-depth': depth - 1 } as CSSProperties} key={deck.id}>
            <span className="deck-index">{deck.name === SAMPLE_DECK_NAME ? 'SAMPLE DECK' : 'DECK'} // {String(deck.noteCount).padStart(2, '0')} NOTES</span>
            <h2>{deck.name}</h2>
            <CountStrip counts={deck.counts} reviews={deck.reviewCount} />{deck.sessionCount > 0 && <p className="temporary-membership">{deck.sessionCount} home cards temporarily reserved for custom study</p>}
            <button className="tile-action" type="button" aria-label={`Open ${deck.name}`} onClick={() => onOpen(deck.id)}>Open deck <span>→</span></button>
          </article>
        ))}
      </section>
    </>
  )
}

function settingsFromGroup(group: DeckOptionGroup): DeckOptionSettings {
  return {
    dailyNewLimit: group.dailyNewLimit,
    dailyReviewLimit: group.dailyReviewLimit,
    desiredRetention: group.desiredRetention,
    learningSteps: group.learningSteps,
    relearningSteps: group.relearningSteps,
    newCardOrder: group.newCardOrder,
    newCardGatherOrder: group.newCardGatherOrder,
    newCardSortOrder: group.newCardSortOrder,
    reviewCardOrder: group.reviewCardOrder,
    newReviewOrder: group.newReviewOrder,
    interdayLearningOrder: group.interdayLearningOrder,
    buryNewSiblings: group.buryNewSiblings,
    buryReviewSiblings: group.buryReviewSiblings,
    buryInterdayLearningSiblings: group.buryInterdayLearningSiblings,
    leechThreshold: group.leechThreshold,
    leechAction: group.leechAction,
    leechTag: group.leechTag,
  }
}

function MoveDeckDialog({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const decks = useLiveQuery(() => collection.decks.orderBy('name').toArray(), [], [])
  const [parentId, setParentId] = useState(deck.parentId ?? '')
  const [error, setError] = useState('')
  const blocked = new Set([deck.id])
  for (let changed = true; changed;) {
    changed = false
    for (const candidate of decks) if (candidate.parentId && blocked.has(candidate.parentId) && !blocked.has(candidate.id)) { blocked.add(candidate.id); changed = true }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await collection.moveDeck(deck.id, parentId || null)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to move deck')
    }
  }

  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="move-deck-title">
    <span className="section-code">DECK // MOVE</span><h2 id="move-deck-title">Move deck</h2>
    <form onSubmit={submit}><label>New parent deck<select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">Top level</option>{decks.filter((candidate) => !blocked.has(candidate.id)).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}</select></label>
      <p className="options-note">Child decks stay with this deck.</p>{error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Move deck</button></div>
    </form>
  </section></div>
}

function DeleteDeckDialog({ deck, onClose, onDeleted }: { deck: Deck; onClose: () => void; onDeleted: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const decks = useLiveQuery(() => collection.decks.orderBy('name').toArray(), [], [])
  const [mode, setMode] = useState<'delete-subtree' | 'relocate'>('delete-subtree')
  const [destinationId, setDestinationId] = useState('')
  const [error, setError] = useState('')
  const blocked = new Set([deck.id])
  for (let changed = true; changed;) {
    changed = false
    for (const candidate of decks) if (candidate.parentId && blocked.has(candidate.parentId) && !blocked.has(candidate.id)) { blocked.add(candidate.id); changed = true }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      if (deck.name === SAMPLE_DECK_NAME) await removeSampleDeck(deck.id)
      else if (mode === 'relocate') await collection.deleteDeck(deck.id, { mode, destinationDeckId: destinationId })
      else await collection.deleteDeck(deck.id, { mode })
      onDeleted()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to delete deck')
    }
  }

  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-deck-title">
    <span className="section-code">{deck.name === SAMPLE_DECK_NAME ? 'SAMPLE // REMOVE' : 'DECK // DELETE'}</span><h2 id="delete-deck-title">{deck.name === SAMPLE_DECK_NAME ? 'Remove sample deck?' : 'Delete deck'}</h2>
    <form onSubmit={submit}>{deck.name === SAMPLE_DECK_NAME ? <p>This removes the sample deck, its notes, cards, review history, and attachments. Your other decks stay as they are.</p> : <fieldset className="delete-mode"><legend>How should this deck be removed?</legend><label className="choice"><input name="delete-mode" type="radio" checked={mode === 'relocate'} onChange={() => setMode('relocate')} />Relocate contents and child decks</label>
      <p className="options-note">Moves this deck’s notes and direct child decks to the destination, then deletes only this deck.</p>
      {mode === 'relocate' && <label>Destination deck<select value={destinationId} onChange={(event) => setDestinationId(event.target.value)} required><option value="" disabled>Choose a destination</option>{decks.filter((candidate) => !blocked.has(candidate.id)).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}</select></label>}
      <label className="choice"><input name="delete-mode" type="radio" checked={mode === 'delete-subtree'} onChange={() => setMode('delete-subtree')} />Delete this deck and its subtree</label>
      <p className="options-note">Permanently deletes this deck, child decks, notes, cards, and their review entries.</p></fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" data-dialog-initial-focus type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">{deck.name === SAMPLE_DECK_NAME ? 'Remove sample deck' : mode === 'relocate' ? 'Relocate and delete deck' : 'Delete deck subtree'}</button></div>
    </form>
  </section></div>
}

function MoveNoteDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const decks = useLiveQuery(() => collection.decks.orderBy('name').toArray(), [], [])
  const [destinationId, setDestinationId] = useState('')
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await collection.moveNote(note.id, destinationId)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to move note')
    }
  }
  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="move-note-title">
    <span className="section-code">NOTE // MOVE</span><h2 id="move-note-title">Move note</h2><form onSubmit={submit}>
      <label>Destination deck<select value={destinationId} onChange={(event) => setDestinationId(event.target.value)} required><option value="" disabled>Choose a destination</option>{decks.filter((deck) => deck.id !== note.deckId).map((deck) => <option value={deck.id} key={deck.id}>{deck.name}</option>)}</select></label>
      <p className="options-note">The note, generated cards, and review history keep their identities.</p>{error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Move note</button></div>
    </form>
  </section></div>
}

function DeckOptionsDialog({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const groups = useLiveQuery(() => collection.deckOptionGroups.orderBy('name').toArray(), [], [])
  const decks = useLiveQuery(() => collection.decks.orderBy('name').toArray(), [], [])
  const [groupId, setGroupId] = useState(deck.optionGroupId)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const group = groups.find((candidate) => candidate.id === groupId) ?? groups.find((candidate) => candidate.id === deck.optionGroupId)
  const [settings, setSettings] = useState<DeckOptionSettings | null>(null)
  const [error, setError] = useState('')

  if (!group) return null

  const selectedGroup: DeckOptionGroup = group
  const selectedSettings: DeckOptionSettings = settings ?? settingsFromGroup(group)
  const affected = decks.filter((candidate) => candidate.optionGroupId === (creating ? undefined : group.id))
  const update = <K extends keyof DeckOptionSettings>(key: K, value: DeckOptionSettings[K]) => setSettings({ ...selectedSettings, [key]: value })
  const stepList = (value: string) => value.split(/[\s,]+/).filter(Boolean)

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      let target: DeckOptionGroup = selectedGroup
      if (creating) target = await collection.createDeckOptionGroup(name)
      await collection.updateDeckOptionGroup(target.id, selectedSettings)
      await collection.assignDeckOptionGroup(deck.id, target.id)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save scheduling options')
    }
  }

  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog options-dialog" role="dialog" aria-modal="true" aria-labelledby="options-dialog-title">
    <span className="section-code">DECK // SCHEDULING</span><h2 id="options-dialog-title">Scheduling options</h2>
    <form onSubmit={submit}>
      <label>Scheduling option group<select aria-label="Scheduling option group" value={creating ? '' : group.id} onChange={(event) => { const next = groups.find((candidate) => candidate.id === event.target.value); setCreating(false); setGroupId(event.target.value); setSettings(next ? settingsFromGroup(next) : null); setError('') }}>
        {groups.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}{candidate.protected ? ' (Default)' : ''}</option>)}
      </select></label>
      <button className="text-button" type="button" onClick={() => { setCreating(true); setName(''); setSettings(settingsFromGroup(group)); setError('') }}>Create option group</button>
      {creating && <label>Option group name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} /></label>}
      <div className="options-fields">
        <label>Daily new limit<input aria-label="Daily new limit" type="number" min="0" max="9999" value={selectedSettings.dailyNewLimit} onChange={(event) => update('dailyNewLimit', Number(event.target.value))} /></label>
        <label>Daily review limit<input aria-label="Daily review limit" type="number" min="0" max="9999" value={selectedSettings.dailyReviewLimit} onChange={(event) => update('dailyReviewLimit', Number(event.target.value))} /></label>
        <label>Desired retention<input aria-label="Desired retention" type="number" min="0.01" max="1" step="0.01" value={selectedSettings.desiredRetention} onChange={(event) => update('desiredRetention', Number(event.target.value))} /></label>
        <label>Learning steps<input aria-label="Learning steps" value={selectedSettings.learningSteps.join(', ')} onChange={(event) => update('learningSteps', stepList(event.target.value))} /><small>Comma-separated minutes, hours, or days (for example: 1m, 10m).</small></label>
        <label>Relearning steps<input aria-label="Relearning steps" value={selectedSettings.relearningSteps.join(', ')} onChange={(event) => update('relearningSteps', stepList(event.target.value))} /></label>
        <label>New card gather order<select aria-label="New card gather order" data-testid="new-card-gather-order" value={selectedSettings.newCardGatherOrder ?? 'deck'} onChange={(event) => update('newCardGatherOrder', event.target.value as DeckOptionSettings['newCardGatherOrder'])}><option value="deck">Deck</option><option value="deck-random-notes">Deck, then random notes</option><option value="ascending-position">Ascending position</option><option value="descending-position">Descending position</option><option value="random-notes">Random notes</option><option value="random-cards">Random cards</option></select></label>
        <label>New card sort order<select aria-label="New card sort order" data-testid="new-card-sort-order" value={selectedSettings.newCardSortOrder ?? 'template'} onChange={(event) => update('newCardSortOrder', event.target.value as DeckOptionSettings['newCardSortOrder'])}><option value="template">Card type, then order gathered</option><option value="gathered">Order gathered</option><option value="template-random">Card type, then random</option><option value="random-note-template">Random note, then card type</option><option value="random">Random</option></select></label>
        <label>Review card order<select aria-label="Review card order" data-testid="review-card-order" value={selectedSettings.reviewCardOrder} onChange={(event) => update('reviewCardOrder', event.target.value as DeckOptionSettings['reviewCardOrder'])}><option value="due">Due date, then random</option><option value="due-then-deck">Due date, then deck</option><option value="deck-then-due">Deck, then due date</option><option value="interval-ascending">Ascending intervals</option><option value="interval-descending">Descending intervals</option><option value="retrievability-ascending">Ascending retrievability</option><option value="retrievability-descending">Descending retrievability</option><option value="random">Random</option></select></label>
        <label>New/review order<select aria-label="New/review order" value={selectedSettings.newReviewOrder} onChange={(event) => update('newReviewOrder', event.target.value as DeckOptionSettings['newReviewOrder'])}><option value="mix">Mix with reviews</option><option value="before-reviews">Before reviews</option><option value="after-reviews">After reviews</option></select></label>
        <label>Interday learning order<select aria-label="Interday learning order" value={selectedSettings.interdayLearningOrder} onChange={(event) => update('interdayLearningOrder', event.target.value as DeckOptionSettings['interdayLearningOrder'])}><option value="mix">Mix with reviews</option><option value="before-reviews">Before reviews</option><option value="after-reviews">After reviews</option></select></label>
        <fieldset className="policy-settings"><legend>Sibling burial</legend>
          <label className="choice"><input aria-label="Bury new siblings" type="checkbox" checked={Boolean(selectedSettings.buryNewSiblings)} onChange={(event) => update('buryNewSiblings', event.target.checked)} />Bury new siblings</label>
          <label className="choice"><input aria-label="Bury review siblings" type="checkbox" checked={Boolean(selectedSettings.buryReviewSiblings)} onChange={(event) => update('buryReviewSiblings', event.target.checked)} />Bury review siblings</label>
          <label className="choice"><input aria-label="Bury interday learning siblings" type="checkbox" checked={Boolean(selectedSettings.buryInterdayLearningSiblings)} onChange={(event) => update('buryInterdayLearningSiblings', event.target.checked)} />Bury interday learning siblings</label>
          <p className="options-note">Later siblings stay out of the queue until the next local study day. Intraday learning steps keep their place.</p>
        </fieldset>
        <fieldset className="policy-settings"><legend>Leeches</legend>
          <label>Leech threshold<input aria-label="Leech threshold" type="number" min="1" max="9999" value={selectedSettings.leechThreshold} onChange={(event) => update('leechThreshold', Number(event.target.value))} /></label>
          <label>Leech action<select aria-label="Leech action" value={selectedSettings.leechAction} onChange={(event) => update('leechAction', event.target.value as DeckOptionSettings['leechAction'])}><option value="suspend">Tag and suspend</option><option value="tag-only">Tag only</option></select></label>
          <label>Leech tag<input aria-label="Leech tag" value={selectedSettings.leechTag} onChange={(event) => update('leechTag', event.target.value)} maxLength={120} /></label>
        </fieldset>
      </div>
      <section className="affected-decks" aria-label="Decks using this option group"><h3>Decks using this option group</h3><p>{creating ? 'This new group will be assigned to this deck.' : affected.length ? affected.map((candidate) => candidate.name).join(', ') : 'No decks use this group yet.'}</p></section>
      <p className="options-note">Changes apply to future scheduling. Existing review history remains unchanged.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Save options</button></div>
    </form>
  </section></div>
}

function localDateTimeValue(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function cardStatus(card: CardRecord) {
  const reason = unavailableReason(card, new Date())
  if (reason === 'template') return 'Template content unavailable'
  if (reason === 'manual') return 'Suspended manually'
  if (reason === 'buried') return `Buried until ${new Date(card.buriedUntil!).toLocaleString()}`
  return 'Available for scheduling'
}

function CardManagementDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const cards = useLiveQuery(() => collection.cards.where('noteId').equals(note.id).sortBy('templateId'), [note.id], [])
  const [dueByCard, setDueByCard] = useState<Record<string, string>>({})
  const [busyCardId, setBusyCardId] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function perform(cardId: string, action: () => Promise<void>) {
    setBusyCardId(cardId)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update card')
    } finally {
      setBusyCardId(null)
    }
  }

  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog card-management-dialog" role="dialog" aria-modal="true" aria-labelledby="card-management-title">
    <span className="section-code">NOTE // CARDS</span><h2 id="card-management-title">Manage cards</h2>
    <p className="options-note">Suspend or bury a card temporarily. Rescheduling keeps its review history and scheduling data.</p>
    <div className="card-management-list">
      {cards.map((card, index) => {
        const due = dueByCard[card.id] ?? localDateTimeValue(card.due)
        const busy = busyCardId === card.id
        const cardName = `card ${index + 1}, template ${card.templateId}`
        return <article className="card-management-row" key={card.id}>
          <div><span className="section-code">CARD // {String(index + 1).padStart(2, '0')}</span><p aria-live="polite">{cardStatus(card)}</p></div>
          <div className="card-management-actions">
            {card.manualSuspended
              ? <button aria-label={`Resume ${cardName}`} className="text-button" type="button" disabled={busy} onClick={() => void perform(card.id, () => collection.unsuspendCard(card.id))}>Resume card</button>
              : <button aria-label={`Suspend ${cardName}`} className="text-button" type="button" disabled={busy || Boolean(card.templateSuspended || card.suspended)} onClick={() => void perform(card.id, () => collection.suspendCard(card.id))}>Suspend card</button>}
            {card.buriedUntil
              ? <button aria-label={`Unbury ${cardName}`} className="text-button" type="button" disabled={busy} onClick={() => void perform(card.id, () => collection.unburyCard(card.id))}>Unbury card</button>
              : <button aria-label={`Bury ${cardName}`} className="text-button" type="button" disabled={busy} onClick={() => void perform(card.id, () => collection.buryCard(card.id))}>Bury card</button>}
          </div>
          <label>Reschedule due<input aria-label={`Reschedule due for ${cardName}`} type="datetime-local" value={due} onChange={(event) => setDueByCard((current) => ({ ...current, [card.id]: event.target.value }))} /></label>
          <button aria-label={`Reschedule ${cardName}`} className="text-button" type="button" disabled={busy || !due} onClick={() => void perform(card.id, () => collection.rescheduleCard(card.id, new Date(due)))}>Reschedule card</button>
        </article>
      })}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="primary-action" type="button" onClick={onClose}>Done</button></div>
  </section></div>
}

function DeckDetail({ deckId, onBack, onStudy }: { deckId: string; onBack: () => void; onStudy: () => void }) {
  const deck = useLiveQuery(() => collection.decks.get(deckId), [deckId])
  const notes = useLiveQuery(() => collection.notes.where('deckId').equals(deckId).sortBy('createdAt'), [deckId], [])
  const noteTypes = useLiveQuery(() => collection.noteTypes.toArray(), [], [])
  const summary = useLiveQuery(async () => (await collection.summaries()).find((item) => item.id === deckId), [deckId])
  const due = useLiveQuery(() => collection.dueCards(deckId, new Date()), [deckId], [])
  const [deckDialog, setDeckDialog] = useState(false)
  const [childDialog, setChildDialog] = useState(false)
  const [moveDialog, setMoveDialog] = useState(false)
  const [deleteDialog, setDeleteDialog] = useState(false)
  const [optionsDialog, setOptionsDialog] = useState(false)
  const [moveNote, setMoveNote] = useState<Note | null>(null)
  const [manageCardsNote, setManageCardsNote] = useState<Note | null>(null)
  const [noteDialog, setNoteDialog] = useState<{ note?: Note } | null>(null)

  if (deck === undefined || summary === undefined) return <div className="loading-state" role="status">Loading local deck…</div>
  if (!deck || !summary) return <div className="loading-state"><h1>Deck not found</h1><button className="text-button" onClick={onBack}>Back to decks</button></div>

  const hasDueCards = due.length > 0

  return (
    <>
      <section className="deck-detail-header">
        <button className="text-button back-button" type="button" onClick={onBack}>← All decks</button>
        <span className="section-code">{deck.name === SAMPLE_DECK_NAME ? 'SAMPLE // STARTER DECK' : 'DECK // LOCAL'}</span>
        <h1>{deck.name}</h1>
        <CountStrip counts={summary.counts} reviews={summary.reviewCount} />{deck.name === SAMPLE_DECK_NAME ? <p className="temporary-membership">A small sample collection for trying Japanese review. Remove it any time from this page.</p> : <p className="temporary-membership">{summary.sessionCount} home cards reserved for custom study. Home totals include them; today’s normal queue excludes them.</p>}
        <div className="deck-actions">
          <button className="primary-action" type="button" onClick={() => setNoteDialog({})}>Add note</button>
          <button className="primary-action study-action" type="button" disabled={!hasDueCards} onClick={onStudy}>Study now</button>
          <button className="text-button" type="button" onClick={() => setChildDialog(true)}>Create child deck</button>
          <button className="text-button" type="button" onClick={() => setMoveDialog(true)}>Move deck</button>
          <button className="text-button" type="button" onClick={() => setOptionsDialog(true)}>Scheduling options</button>
          <button className="text-button" type="button" onClick={() => setDeckDialog(true)}>Rename deck</button>
          <button className="text-button danger" type="button" onClick={() => setDeleteDialog(true)}>{deck.name === SAMPLE_DECK_NAME ? 'Remove sample deck' : 'Delete deck'}</button>
        </div>
      </section>
      <section className="note-list" aria-label="Notes">
        <div className="panel-heading"><div><span className="section-code">NOTES // {String(notes.length).padStart(2, '0')}</span><h2>Notes</h2></div></div>
        {notes.length === 0 ? (
          <div className="note-empty"><span lang="ja">書</span><p>Add a front and back to generate your first card.</p></div>
        ) : notes.map((note) => {
          const type = noteTypes.find((candidate) => candidate.id === note.typeId)
          return <article className="note-row" key={note.id}>
            <div><span>{type?.fields[0]?.name.toUpperCase() ?? 'FIELD'}</span><strong data-testid="note-front" lang="ja">{note.fields[type?.fields[0]?.id ?? 'front']}</strong></div>
            <div><span>{type?.fields[1]?.name.toUpperCase() ?? type?.name.toUpperCase() ?? 'NOTE'}</span><p data-testid="note-back" lang="ja">{note.fields[type?.fields[1]?.id ?? 'back']}</p></div>
            <div className="note-row-actions"><button className="text-button" type="button" onClick={() => setNoteDialog({ note })}>Edit note</button><button className="text-button" type="button" onClick={() => setMoveNote(note)}>Move note</button><button className="text-button" type="button" onClick={() => setManageCardsNote(note)}>Manage cards</button></div>
          </article>
        })}
      </section>
      {deckDialog && <DeckDialog deck={deck} onClose={() => setDeckDialog(false)} />}
      {childDialog && <DeckDialog parentId={deck.id} onClose={() => setChildDialog(false)} />}
      {moveDialog && <MoveDeckDialog deck={deck} onClose={() => setMoveDialog(false)} />}
      {deleteDialog && <DeleteDeckDialog deck={deck} onClose={() => setDeleteDialog(false)} onDeleted={onBack} />}
      {optionsDialog && <DeckOptionsDialog deck={deck} onClose={() => setOptionsDialog(false)} />}
      {moveNote && <MoveNoteDialog note={moveNote} onClose={() => setMoveNote(null)} />}
      {manageCardsNote && <CardManagementDialog note={manageCardsNote} onClose={() => setManageCardsNote(null)} />}
      {noteDialog && <NoteDialog deckId={deckId} note={noteDialog.note} onClose={() => setNoteDialog(null)} />}
    </>
  )
}

function ReviewSession({ deckId = '', sessionId, onBack }: { deckId?: string; sessionId?: string; onBack: () => void }) {
  const [skippedCardIds, setSkippedCardIds] = useState<ReadonlySet<string>>(() => new Set())
  const [shownAnswerCardId, setShownAnswerCardId] = useState<string | null>(null)
  const [reviewsRecorded, setReviewsRecorded] = useState(0)
  const [isAnswering, setIsAnswering] = useState(false)
  const [actionError, setActionError] = useState('')
  /*
   * Rating a card moves it out of view without moving focus, so a learner
   * driving the reviewer from the keyboard or a screen reader gets no sign
   * that anything happened. Every outcome of a card action is announced here.
   */
  const [reviewAnnouncement, setReviewAnnouncement] = useState('')
  const [typedDraft, setTypedDraft] = useState<{ cardId?: string; value: string }>({ value: '' })
  const [editingNote, setEditingNote] = useState(false)
  const [movingNote, setMovingNote] = useState(false)
  const [editingTags, setEditingTags] = useState(false)
  const [deletingNote, setDeletingNote] = useState(false)
  const [showCardInfo, setShowCardInfo] = useState(false)
  const deleteDialogKeyboard = useDialogKeyboard(() => setDeletingNote(false), deletingNote)
  const cardInfoDialogKeyboard = useDialogKeyboard(() => setShowCardInfo(false), showCardInfo)
  const [audioMessage, setAudioMessage] = useState('')
  const typedResultRef = useRef<HTMLDivElement>(null)
  const reviewCardRef = useRef<HTMLElement>(null)
  const customSession = useLiveQuery(async () => sessionId ? (await customStudySessions(collection)).find((session) => session.id === sessionId) : undefined, [sessionId])
  const dueQueue = useLiveQuery(() => sessionId ? customStudyQueue(collection, sessionId, new Date()) : collection.reviewQueue(deckId, new Date()), [deckId, sessionId])
  const queue = dueQueue?.filter((candidate) => !skippedCardIds.has(candidate.id))
  const cardId = queue?.[0]?.id
  const showAnswer = shownAnswerCardId === cardId
  const typedInput = typedDraft.cardId === cardId ? typedDraft.value : ''
  const card = useLiveQuery(async () => cardId ? await collection.cards.get(cardId) ?? null : undefined, [cardId])
  const note = useLiveQuery(async () => card ? await collection.notes.get(card.noteId) ?? null : undefined, [card?.noteId])
  const noteType = useLiveQuery(async () => note ? await collection.noteTypes.get(note.typeId) ?? null : undefined, [note?.typeId])
  const mediaQuery = useLiveQuery(() => card ? collection.mediaForNote(card.noteId) : [], [card?.noteId])
  // A live query returns a new array identity on ordinary reviewer renders. Stable
  // identities keep the review timer effect and prepared media sources from restarting.
  const media = useMemo(() => mediaQuery ?? [], [mediaQuery])
  const reviewCount = useLiveQuery(() => card ? collection.reviewEntries.where('cardId').equals(card.id).count() : 0, [card?.id], 0)
  // One subscription for one undo. A review belonging to another custom session
  // is not this session's to offer.
  const pendingUndo = useLiveQuery(async () => {
    const record = await collection.pendingUndo()
    return sessionId && record?.kind === 'review' && record.customSession?.after.id !== sessionId ? null : record
  }, [sessionId])
  const choices = useLiveQuery(() => card ? sessionId && customSession?.reschedule === false ? practiceChoices : collection.reviewChoices(card.id, new Date(), Boolean(sessionId)) : [], [card?.id, sessionId, customSession?.reschedule], [])
  const template = noteType?.templates.find((candidate) => candidate.id === card?.templateId)
  const imageOcclusion = noteType?.kind === 'image-occlusion'
  // Only prepare media once the live query has actually resolved for the active card,
  // so a pending read cannot be mistaken for a card that has no attachments. Prepared
  // sources are keyed by this list inside the hook, so no extra memoization is needed.
  const activeCard = card?.id === cardId ? card : undefined
  const activeMedia = activeCard
    ? media.filter((reference) => (!reference.templateId || reference.templateId === activeCard.templateId))
    : []
  const preparedMedia = useReviewMedia(activeMedia, cardId)
  const attachments = activeMedia.filter((reference) => !reference.inline).map((reference) => describeCardMedia(
    reference,
    preparedMedia.sources.byReference[reference.id]?.url,
  ))
  const renderedCard = template && noteType && note && card
    ? renderNoteCard(noteType, template, note.fields, card.clozeOrdinal, preparedMedia.sources.byName, attachments, note.renderedHtmlFields)
    : undefined
  const typedAnswer = renderedCard?.typedAnswer
  const renderError = renderedCard?.error
  // A media failure is reported but never blocks the card: a single corrupt or
  // unsupported attachment must not make the card permanently unanswerable.
  const mediaBlocked = !mediaQuery || preparedMedia.pending
  // Answering already refuses a suspended or buried card, so the reviewer asks the
  // scheduler for the same reason rather than restating a weaker suspension test.
  const unavailable = card === null || note === null || noteType === null ||
    Boolean(card && unavailableReason(card, new Date()) !== null) ||
    (Boolean(noteType && card) && !template) ||
    Boolean(renderedCard && !isRenderedCardDisplayable(renderedCard, noteType?.kind))

  useEffect(() => {
    if (showAnswer && typedAnswer !== undefined) typedResultRef.current?.focus()
  }, [cardId, showAnswer, typedAnswer])

  const activeTime = useRef<{ cardId?: string; elapsed: number; started: number | null }>({ elapsed: 0, started: null })
  useEffect(() => {
    if (activeTime.current.cardId !== cardId) activeTime.current = { cardId, elapsed: 0, started: null }
    const timer = activeTime.current
    const blocked = editingNote || movingNote || editingTags || deletingNote || showCardInfo || unavailable || !note || mediaBlocked
    const update = () => {
      if (timer.started !== null) timer.elapsed += performance.now() - timer.started
      timer.started = !blocked && document.visibilityState === 'visible' ? performance.now() : null
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      if (timer.started !== null) timer.elapsed += performance.now() - timer.started
      timer.started = null
    }
  }, [cardId, editingNote, movingNote, editingTags, deletingNote, showCardInfo, unavailable, note, mediaBlocked])

  const answer = useCallback(async (rating: Grade) => {
    if (!cardId || isAnswering || mediaBlocked) return
    setIsAnswering(true)
    setActionError('')
    try {
      const duration = activeTime.current.elapsed + (activeTime.current.started === null ? 0 : performance.now() - activeTime.current.started)
      if (sessionId) await answerCustomStudy(collection, sessionId, cardId, rating, new Date(), duration)
      else await collection.answer(cardId, rating, new Date(), duration)
      setReviewsRecorded((count) => count + 1)
      setReviewAnnouncement(`Recorded ${Rating[rating]}. ${reviewsRecorded + 1} rated this session.`)
      setShownAnswerCardId(null)
    } catch (reason) {
      setActionError(reason instanceof Error && reason.message ? reason.message : 'Unable to update card')
    } finally {
      setIsAnswering(false)
    }
  }, [cardId, isAnswering, mediaBlocked, sessionId, reviewsRecorded])

  const updateCurrentCard = useCallback(async (action: (id: string) => Promise<void>, message: string) => {
    if (!cardId || isAnswering) return
    setIsAnswering(true)
    setActionError('')
    try {
      await action(cardId)
      setReviewAnnouncement(message)
      setShownAnswerCardId(null)
    } catch (reason) {
      setActionError(reason instanceof Error && reason.message ? reason.message : 'Unable to update card')
    } finally {
      setIsAnswering(false)
    }
  }, [cardId, isAnswering])

  const replayAudio = useCallback(async () => {
    const surface = reviewCardRef.current
    if (!surface) return
    const audio = [
      ...surface.querySelectorAll('audio'),
      ...[...surface.querySelectorAll('iframe')].flatMap((frame) => [...(frame.contentDocument?.querySelectorAll('audio') ?? [])]),
    ]
    if (!audio.length) { setAudioMessage('Audio is still loading. Try again in a moment.'); return }
    setAudioMessage(await replayAudioElements(audio) ? 'Audio replayed.' : 'Audio could not play on this device.')
  }, [])

  const deleteCurrentNote = useCallback(async () => {
    if (!note || isAnswering) return
    setIsAnswering(true)
    setActionError('')
    try {
      await collection.deleteNote(note.id)
      setReviewAnnouncement('Note and its cards deleted.')
      setDeletingNote(false)
      setShownAnswerCardId(null)
    } catch (reason) {
      setActionError(reason instanceof Error && reason.message ? reason.message : 'Unable to delete note')
    } finally {
      setIsAnswering(false)
    }
  }, [note, isAnswering])

  /** One affordance for the one undo record, whatever produced it. */
  const undoLastAction = useCallback(async () => {
    if (isAnswering) return
    setIsAnswering(true)
    setActionError('')
    try {
      if (pendingUndo?.kind === 'review' && sessionId) await undoCustomStudy(collection, sessionId)
      else await collection.undo()
      setReviewAnnouncement(undoAnnouncement(pendingUndo ?? null))
      setShownAnswerCardId(null)
      setReviewsRecorded((count) => (pendingUndo?.kind === 'review' ? Math.max(0, count - 1) : count))
    } catch (reason) {
      setActionError(reason instanceof Error && reason.message ? reason.message : 'Unable to undo')
    } finally {
      setIsAnswering(false)
    }
  }, [isAnswering, pendingUndo, sessionId])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isAnswering || editingNote || movingNote || editingTags || deletingNote || showCardInfo) return
      if (isShortcutBlocked(event)) return
      const key = event.key.toLowerCase()
      const buttonFocused = event.target instanceof Element && Boolean(event.target.closest('button'))
      if ((key === 'u' || key === 'v' || key === 'x') && pendingUndo) { event.preventDefault(); void undoLastAction(); return }
      if (!cardId) return
      if ((key === ' ' || key === 'spacebar') && !showAnswer && !buttonFocused) {
        // Media that is still loading, or that failed to prepare, must not be
        // revealed early: the question would render without its own content.
        if (mediaBlocked) return
        event.preventDefault()
        setReviewAnnouncement('Answer shown. Rate the card with 1 to 4.')
        setShownAnswerCardId(cardId)
      } else if (showAnswer && /^[1-4]$/.test(key)) {
        const choice = choices[Number(key) - 1]
        if (choice) { event.preventDefault(); void answer(choice.rating) }
      } else if (key === 'e') { event.preventDefault(); setEditingNote(true) }
      else if (key === 'm') { event.preventDefault(); setMovingNote(true) }
      else if (key === 't') { event.preventDefault(); setEditingTags(true) }
      else if (key === 'k' && note) { event.preventDefault(); void updateCurrentCard(async () => collection.updateNoteTags(note.id, note.tags?.includes('marked') ? (note.tags ?? []).filter((tag) => tag !== 'marked') : [...(note.tags ?? []), 'marked']), note.tags?.includes('marked') ? 'Mark removed.' : 'Marked.') }
      else if (key === 'd') { event.preventDefault(); setDeletingNote(true) }
      else if (key === 'i') { event.preventDefault(); setShowCardInfo(true) }
      else if (key === 'r' && media.some((reference) => reference.kind === 'audio')) { event.preventDefault(); void replayAudio() }
      else if (key === 's') { event.preventDefault(); void updateCurrentCard((id) => collection.suspendCard(id), 'Card suspended.') }
      else if (key === 'b') { event.preventDefault(); void updateCurrentCard((id) => collection.buryCard(id), 'Card buried.') }
      else if (key === 'f') { event.preventDefault(); void updateCurrentCard((id) => collection.setCardFlag(id, ((card?.flag ?? 0) + 1) % 8), `Flag set to ${((card?.flag ?? 0) + 1) % 8}.`) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cardId, card?.flag, note, isAnswering, editingNote, movingNote, editingTags, deletingNote, showCardInfo, showAnswer, choices, media, answer, replayAudio, updateCurrentCard, pendingUndo, undoLastAction, mediaBlocked])

  /*
   * Card actions move the card out of view without moving focus, so a learner
   * driving the reviewer from the keyboard or a screen reader gets no sign
   * that anything happened. Declared once here because the reviewer returns
   * early for a completed session and for an unrenderable card, and the last
   * action is usually the one that emptied the queue.
   */
  const announcementRegion = <p className="visually-hidden" role="status">{reviewAnnouncement}</p>

  if (queue === undefined || (cardId && (card === undefined || note === undefined || noteType === undefined || unavailable))) return <div className="loading-state" role="status">Preparing review…</div>
  if (!cardId || !card || !note || !noteType || !template) {
    return (
      <section className="session-complete">
        <span className="completion-mark">✓</span>
        <span className="section-code">SESSION // COMPLETE</span>
        <h1>Session complete</h1>
        <p>{reviewsRecorded} {reviewsRecorded === 1 ? 'review' : 'reviews'} recorded</p>
        {pendingUndo && <button className="text-button" type="button" disabled={isAnswering} onClick={() => void undoLastAction()}>{undoLabel(pendingUndo)}</button>}
        {actionError && <p className="form-error" role="alert">{actionError}</p>}
        {/* The last action is usually the one that emptied the queue, so its
            announcement has to outlive the card it was about. */}
        {announcementRegion}
        <button className="primary-action" type="button" onClick={onBack}>{sessionId ? 'Back to custom study' : 'Back to deck'}</button>
      </section>
    )
  }

  function skipCard() {
    if (!cardId) return
    setShownAnswerCardId(null)
    setSkippedCardIds((current) => new Set(current).add(cardId))
    setReviewAnnouncement('Card skipped. It stays scheduled and comes back later.')
  }

  const reviewActions = <div className="review-session-actions">
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => setEditingNote(true)}>Edit note</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => setMovingNote(true)}>Move note</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => setEditingTags(true)}>Edit tags</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => void updateCurrentCard(async () => collection.updateNoteTags(note.id, note.tags?.includes('marked') ? (note.tags ?? []).filter((tag) => tag !== 'marked') : [...(note.tags ?? []), 'marked']), note.tags?.includes('marked') ? 'Mark removed.' : 'Marked.')}>{note.tags?.includes('marked') ? 'Unmark note' : 'Mark note'}</button>
    <button className="text-button" type="button" onClick={() => setShowCardInfo(true)}>Card info</button>
    {pendingUndo && <button className="text-button" type="button" disabled={isAnswering} onClick={() => void undoLastAction()}>{undoLabel(pendingUndo)}</button>}
    <label className="review-flag-control">Flag <select aria-label="Card flag" value={card.flag ?? 0} disabled={isAnswering} onChange={(event) => void updateCurrentCard((id) => collection.setCardFlag(id, Number(event.target.value)), `Flag set to ${event.target.value}.`)}>
      <option value={0}>None</option><option value={1}>Red</option><option value={2}>Orange</option><option value={3}>Green</option><option value={4}>Blue</option><option value={5}>Pink</option><option value={6}>Turquoise</option><option value={7}>Purple</option>
    </select></label>
    {media.some((reference) => reference.kind === 'audio') && <button className="text-button" type="button" onClick={() => void replayAudio()}>Replay audio</button>}
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => void updateCurrentCard((id) => collection.suspendCard(id), 'Card suspended.')}>Suspend card</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => void updateCurrentCard((id) => collection.buryCard(id), 'Card buried.')}>Bury card</button>
    <button className="text-button" type="button" disabled={isAnswering} onClick={() => setDeletingNote(true)}>Delete note</button>
    <button className="text-button" type="button" onClick={onBack}>End session</button>
  </div>
  const reviewerDialogs = <>
    {editingNote && <NoteDialog key={note.id} deckId={note.deckId} note={note} onClose={() => setEditingNote(false)} />}
    {movingNote && <MoveNoteDialog note={note} onClose={() => setMovingNote(false)} />}
    {editingTags && <NoteTagsDialog key={note.id} note={note} onClose={() => setEditingTags(false)} />}
    {deletingNote && <div className="dialog-backdrop"><section {...deleteDialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="review-delete-note-title">
      <span className="section-code">NOTE // DELETE</span><h2 id="review-delete-note-title">Delete note</h2>
      <p>This removes the note and all its cards, review history, and media references. You can undo it until the next sync attempt.</p>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      <div className="dialog-actions"><button className="text-button" data-dialog-initial-focus type="button" onClick={() => setDeletingNote(false)}>Cancel</button><button className="primary-action" type="button" disabled={isAnswering} onClick={() => void deleteCurrentNote()}>Delete note and cards</button></div>
    </section></div>}
    {showCardInfo && <div className="dialog-backdrop"><section {...cardInfoDialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="review-card-info-title">
      <span className="section-code">CARD // DETAILS</span><h2 id="review-card-info-title">Card info</h2>
      <dl className="review-card-info"><div><dt>Note type</dt><dd>{noteType.name}</dd></div><div><dt>Card template</dt><dd>{template.name}</dd></div><div><dt>Due</dt><dd>{new Date(card.due).toLocaleString()}</dd></div><div><dt>Reviews</dt><dd>{reviewCount}</dd></div><div><dt>Lapses</dt><dd>{card.lapses}</dd></div><div><dt>Flag</dt><dd>{['None', 'Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple'][card.flag ?? 0]}</dd></div><div><dt>Tags</dt><dd>{note.tags?.join(', ') || 'None'}</dd></div></dl>
      <CardHistory key={card.id} card={card} />
      <div className="dialog-actions"><button className="primary-action" type="button" onClick={() => setShowCardInfo(false)}>Done</button></div>
    </section></div>}
  </>

  if (renderError) return <><section className="review-session">
    {sessionId && <p className="custom-review-mode">{customSession?.name ?? 'Custom session'} · {customSession?.reschedule ? 'Ratings reschedule the home card' : 'Practice: original schedule stays unchanged'}. Each rated card returns to its home deck.</p>}
    <div className="review-progress"><span>REVIEW // {String(reviewsRecorded + 1).padStart(2, '0')}</span>{reviewActions}</div>
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {announcementRegion}
    <article className="review-card"><p className="form-error" role="alert">Unable to render card: {renderError}</p></article>
    <button className="primary-action" type="button" onClick={skipCard}>Skip card</button>
  </section>{reviewerDialogs}</>

  const answerDiff = showAnswer && typedAnswer !== undefined ? compareTypedAnswer(typedAnswer, typedInput) : []

  return (
    <>
    <section className="review-session">
      {sessionId && <p className="custom-review-mode">{customSession?.name ?? 'Custom session'} · {customSession?.reschedule ? 'Ratings reschedule the home card' : 'Practice: original schedule stays unchanged'}. Each rated card returns to its home deck.</p>}
    <div className="review-progress"><span>REVIEW // {String(reviewsRecorded + 1).padStart(2, '0')}</span>{reviewActions}</div>
      <p className="review-shortcuts">Space reveal · 1–4 rate · E edit · M move · T tags · K mark · I info · F flag · R replay · S suspend · B bury · D delete · U undo review · V undo card action · X undo deletion. Undo is available until the next sync attempt or affected edit.</p>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {announcementRegion}
      {audioMessage && <p className="review-feedback" role="status">{audioMessage}</p>}
      <article className="review-card" ref={reviewCardRef}>
        <span className="card-side">{showAnswer ? 'ANSWER' : 'QUESTION'}</span>
        {mediaBlocked ? <p role="status">Preparing card media…</p> : imageOcclusion
          ? <ImageOcclusionReview note={note} card={card} showAnswer={showAnswer} imageUrl={preparedMedia.sources.byReference[note.imageOcclusion?.sourceMediaId ?? '']?.url} />
          : <TemplatePreview title="Review card" key={card.id} rendering={renderedCard!} templateOrdinal={Math.max(1, noteType.templates.findIndex((candidate) => candidate.id === template.id) + 1)} side={showAnswer ? 'back' : 'front'} />}
        {preparedMedia.error && <p className="form-error" role="alert">Some attachments could not be shown: {preparedMedia.error}</p>}
        {!mediaBlocked && noteType.kind !== 'image-occlusion' && renderedCard?.media.filter((description) => description.side === 'front').map((description) => <MediaRenderer key={description.id} description={description} />)}
        {!mediaBlocked && noteType.kind !== 'image-occlusion' && showAnswer && renderedCard?.media.filter((description) => description.side === 'back').map((description) => <MediaRenderer key={description.id} description={description} />)}
        {typedAnswer !== undefined && !showAnswer && <label className="typed-answer">Type your answer
          <input autoComplete="off" value={typedInput} onChange={(event) => setTypedDraft({ cardId, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!mediaBlocked) setShownAnswerCardId(cardId) } }} />
        </label>}
        {typedAnswer !== undefined && showAnswer && <div ref={typedResultRef} className="typed-answer-result" role="status" aria-live="polite" aria-label="Typed answer comparison" tabIndex={-1}>
          <span className="section-code">YOUR ANSWER</span>
          <div className="answer-diff">{answerDiff.map((part, index) => <span key={index} className={`answer-${part.kind}`} aria-label={`${part.kind === 'good' ? 'Correct' : part.kind === 'bad' ? 'Incorrect' : 'Missing'}: ${part.text}`}>{part.text}</span>)}</div>
          <p>Expected: <strong>{typedAnswer}</strong></p>
        </div>}
      </article>
      {!showAnswer ? (
        <button className="primary-action reveal-action" type="button" disabled={isAnswering || mediaBlocked} onClick={() => { setReviewAnnouncement('Answer shown. Rate the card with 1 to 4.'); setShownAnswerCardId(cardId) }}>Show answer</button>
      ) : (
        <div className="rating-grid" role="group" aria-label="Rate answer">
          {choices.map((choice) => (
            <button aria-label={`${choice.label} · ${choice.interval}`} className={`rating rating-${Rating[choice.rating].toLowerCase()}`} type="button" disabled={isAnswering || mediaBlocked} key={choice.rating} onClick={() => void answer(choice.rating)}>
              <strong>{choice.label}</strong><span aria-hidden="true">·</span><small>{choice.interval}</small>
            </button>
          ))}
        </div>
      )}
    </section>
    {reviewerDialogs}
    </>
  )
}

function NoteTagsDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const [tags, setTags] = useState((note.tags ?? []).join(', '))
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await collection.updateNoteTags(note.id, tags.split(','))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save tags')
    }
  }
  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="note-tags-title">
    <span className="section-code">NOTE // TAGS</span><h2 id="note-tags-title">Edit tags</h2>
    <form onSubmit={submit}><label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
      <p className="options-note">Separate tags with commas. Tags apply to every card generated from this note.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Save tags</button></div>
    </form>
  </section></div>
}

export function CollectionWorkspace({ offlineSyncAvailable = true }: { offlineSyncAvailable?: boolean }) {
  const [route, navigate] = useRoute()
  const decks = useLiveQuery(() => collection.summaries(), [], [])
  const [newDeck, setNewDeck] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [textTransfer, setTextTransfer] = useState(false)

  // The deck panel advertises N beside its heading, so the key has to work.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'n' || newDeck || importing || exporting) return
      if (isShortcutBlocked(event)) return
      event.preventDefault()
      setNewDeck(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newDeck, importing, exporting])

  const content = useMemo(() => {
    if (route.view === 'review') return <ReviewSession deckId={route.deckId} onBack={() => navigate({ view: 'deck', deckId: route.deckId })} />
    if (route.view === 'deck') return <DeckDetail deckId={route.deckId} onBack={() => navigate({ view: 'decks' })} onStudy={() => navigate({ view: 'review', deckId: route.deckId })} />
    if (route.view === 'custom-review') return <ReviewSession sessionId={route.sessionId} onBack={() => navigate({ view: 'study' })} />
    if (route.view === 'study') return <CustomStudy onStudy={(sessionId) => navigate({ view: 'custom-review', sessionId })} />
    if (route.view === 'statistics') return <Statistics />
    if (route.view === 'note-types') return <NoteTypeManager onNewDeck={() => { navigate({ view: 'decks' }); setNewDeck(true) }} />
    if (route.view === 'browse') return <CollectionBrowser />
    if (decks.length === 0) return <EmptyCollection onNewDeck={() => setNewDeck(true)} onImport={() => setImporting(true)} />
    return <DeckList decks={decks} onNewDeck={() => setNewDeck(true)} onImport={() => setImporting(true)} onOpen={(deckId) => navigate({ view: 'deck', deckId })} />
  }, [decks, navigate, route])

  return (
    <>
      <SyncControls offlineSyncAvailable={offlineSyncAvailable} />
      <SyncConflicts />
      <button className="text-button" onClick={() => setExporting(true)}>Export Anki package</button>
      <button className="text-button" onClick={() => setTextTransfer(true)}>Import / export text</button>
      {content}
      {newDeck && <DeckDialog onClose={() => setNewDeck(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {textTransfer && <TextCollectionDialog onClose={() => setTextTransfer(false)} />}
    </>
  )
}


