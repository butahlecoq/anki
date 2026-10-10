import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  collection,
  type Deck,
  type DeckCounts,
  type DeckOptionGroup,
  type DeckOptionSettings,
  type DeckSummary,
  type CardRecord,
  type Note,
} from './collection'
import { NoteTypeManager } from './NoteTypeManager'
import { Statistics, TodayWorkload } from './Statistics'
import { CollectionBrowser } from './CollectionBrowser'
import { unavailableReason } from './scheduler'
import { ExportDialog } from './ExportDialog'
import { CustomStudy } from './CustomStudy'
import { isShortcutBlocked } from './keyboard-shortcuts'
import { SyncConflicts } from './SyncConflicts'
import { loadSampleDeck, removeSampleDeck, SAMPLE_DECK_NAME } from './sample-deck'
import { useRoute } from './route'
import { useDialogKeyboard } from './use-dialog-keyboard'
import { useDialogSubmit } from './use-dialog-submit'
import { readCardsForNote, readDeckList, readDeckMediaReferences, readDeckMediaSnapshot, readDeckOptionGroups, readDeckWorkspaceSnapshot } from './collection-queries'
import { SyncControls } from './SyncControls'
import { ImportDialog } from './ImportDialog'
import { MoveNoteDialog, NoteDialog, ReviewSession } from './ReviewSession'
import { ActivitySelection } from './ActivitySelection'
import { DEFAULT_LEARNING_ACTIVITY_ID } from './learning-activities'
import { syncCollection } from './sync-client'
import { digestMedia } from './media'
import { userFacingStorageError } from './offline-storage'

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
  const { error, submitting, submit: submitAction } = useDialogSubmit()
  const title = deck ? 'Rename deck' : parentId ? 'Create a child deck' : 'Create a deck'

  function submit(event: FormEvent) {
    event.preventDefault()
    void submitAction(async () => {
      if (deck) await collection.renameDeck(deck.id, name)
      else await collection.createDeck(name, { parentId })
    }, 'Unable to save deck', onClose)
  }

  return (
    <div className="dialog-backdrop">
      <section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="deck-dialog-title">
        <span className="section-code">DECK // {deck ? 'EDIT' : 'NEW'}</span>
        <h2 id="deck-dialog-title">{title}</h2>
        <form onSubmit={submit} aria-busy={submitting}>
          <label>
            Deck name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="text-button" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
            <button className="primary-action" type="submit" disabled={submitting}>{deck ? 'Save name' : parentId ? 'Create child deck' : 'Create deck'}</button>
          </div>
        </form>
      </section>
    </div>
  )
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
            {deck.sessionCount > 0 && <p className="temporary-membership">{deck.sessionCount} home cards temporarily reserved for custom study</p>}
            <CountStrip counts={deck.counts} reviews={deck.reviewCount} />
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
  const decks = useLiveQuery(() => readDeckList(collection), [], [])
  const [parentId, setParentId] = useState(deck.parentId ?? '')
  const { error, submitting, submit: submitAction } = useDialogSubmit()
  const blocked = new Set([deck.id])
  for (let changed = true; changed;) {
    changed = false
    for (const candidate of decks) if (candidate.parentId && blocked.has(candidate.parentId) && !blocked.has(candidate.id)) { blocked.add(candidate.id); changed = true }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void submitAction(async () => {
      await collection.moveDeck(deck.id, parentId || null)
    }, 'Unable to move deck', onClose)
  }

  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="move-deck-title">
    <span className="section-code">DECK // MOVE</span><h2 id="move-deck-title">Move deck</h2>
    <form onSubmit={submit} aria-busy={submitting}><label>New parent deck<select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">Top level</option>{decks.filter((candidate) => !blocked.has(candidate.id)).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}</select></label>
      <p className="options-note">Child decks stay with this deck.</p>{error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Move deck</button></div>
    </form>
  </section></div>
}

function DeleteDeckDialog({ deck, onClose, onDeleted }: { deck: Deck; onClose: () => void; onDeleted: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const decks = useLiveQuery(() => readDeckList(collection), [], [])
  const [mode, setMode] = useState<'delete-subtree' | 'relocate'>('delete-subtree')
  const [destinationId, setDestinationId] = useState('')
  const { error, submitting, submit: submitAction } = useDialogSubmit()
  const blocked = new Set([deck.id])
  for (let changed = true; changed;) {
    changed = false
    for (const candidate of decks) if (candidate.parentId && blocked.has(candidate.parentId) && !blocked.has(candidate.id)) { blocked.add(candidate.id); changed = true }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void submitAction(async () => {
      if (deck.name === SAMPLE_DECK_NAME) await removeSampleDeck(deck.id)
      else if (mode === 'relocate') await collection.deleteDeck(deck.id, { mode, destinationDeckId: destinationId })
      else await collection.deleteDeck(deck.id, { mode })
    }, 'Unable to delete deck', onDeleted)
  }

  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-deck-title">
    <span className="section-code">{deck.name === SAMPLE_DECK_NAME ? 'SAMPLE // REMOVE' : 'DECK // DELETE'}</span><h2 id="delete-deck-title">{deck.name === SAMPLE_DECK_NAME ? 'Remove sample deck?' : 'Delete deck'}</h2>
    <form onSubmit={submit} aria-busy={submitting}>{deck.name === SAMPLE_DECK_NAME ? <p>This removes the sample deck, its notes, cards, review history, and attachments. Your other decks stay as they are.</p> : <fieldset className="delete-mode"><legend>How should this deck be removed?</legend><label className="choice"><input name="delete-mode" type="radio" checked={mode === 'relocate'} onChange={() => setMode('relocate')} />Relocate contents and child decks</label>
      <p className="options-note">Moves this deck’s notes and direct child decks to the destination, then deletes only this deck.</p>
      {mode === 'relocate' && <label>Destination deck<select value={destinationId} onChange={(event) => setDestinationId(event.target.value)} required><option value="" disabled>Choose a destination</option>{decks.filter((candidate) => !blocked.has(candidate.id)).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}</select></label>}
      <label className="choice"><input name="delete-mode" type="radio" checked={mode === 'delete-subtree'} onChange={() => setMode('delete-subtree')} />Delete this deck and its subtree</label>
      <p className="options-note">Permanently deletes this deck, child decks, notes, cards, and their review entries.</p></fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" data-dialog-initial-focus type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">{deck.name === SAMPLE_DECK_NAME ? 'Remove sample deck' : mode === 'relocate' ? 'Relocate and delete deck' : 'Delete deck subtree'}</button></div>
    </form>
  </section></div>
}

function DeckOptionsDialog({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const groups = useLiveQuery(() => readDeckOptionGroups(collection), [], [])
  const decks = useLiveQuery(() => readDeckList(collection), [], [])
  const [groupId, setGroupId] = useState(deck.optionGroupId)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const group = groups.find((candidate) => candidate.id === groupId) ?? groups.find((candidate) => candidate.id === deck.optionGroupId)
  const [settings, setSettings] = useState<DeckOptionSettings | null>(null)
  const { error, setError, submitting, submit: submitAction } = useDialogSubmit()

  if (!group) return null

  const selectedGroup: DeckOptionGroup = group
  const selectedSettings: DeckOptionSettings = settings ?? settingsFromGroup(group)
  const affected = decks.filter((candidate) => candidate.optionGroupId === (creating ? undefined : group.id))
  const update = <K extends keyof DeckOptionSettings>(key: K, value: DeckOptionSettings[K]) => setSettings({ ...selectedSettings, [key]: value })
  const stepList = (value: string) => value.split(/[\s,]+/).filter(Boolean)

  function submit(event: FormEvent) {
    event.preventDefault()
    void submitAction(async () => {
      let target: DeckOptionGroup = selectedGroup
      if (creating) target = await collection.createDeckOptionGroup(name)
      await collection.updateDeckOptionGroup(target.id, selectedSettings)
      await collection.assignDeckOptionGroup(deck.id, target.id)
    }, 'Unable to save scheduling options', onClose)
  }

  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog options-dialog" role="dialog" aria-modal="true" aria-labelledby="options-dialog-title">
    <span className="section-code">DECK // SCHEDULING</span><h2 id="options-dialog-title">Scheduling options</h2>
    <form onSubmit={submit} aria-busy={submitting}>
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
  const cards = useLiveQuery(() => readCardsForNote(collection, note.id), [note.id], [])
  const [dueByCard, setDueByCard] = useState<Record<string, string>>({})
  const [busyCardId, setBusyCardId] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function perform(cardId: string, action: () => Promise<void>) {
    setBusyCardId(cardId)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(userFacingStorageError(reason, 'Unable to update card'))
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

function DeckDetail({ deckId, onBack, onStudy, onChooseActivity }: { deckId: string; onBack: () => void; onStudy: () => void; onChooseActivity: () => void }) {
  const workspace = useLiveQuery(() => readDeckWorkspaceSnapshot(collection, deckId), [deckId])
  const deck = workspace?.deck
  const notes = workspace?.notes ?? []
  const noteTypes = workspace?.noteTypes ?? []
  const summary = useLiveQuery(async () => (await collection.summaries()).find((item) => item.id === deckId), [deckId])
  const due = useLiveQuery(() => collection.reviewQueue(deckId, new Date()), [deckId], [])
  const offlineReadiness = useLiveQuery(async () => {
    const { references, blobs } = await readDeckMediaSnapshot(collection, deckId)
    const digests = [...new Set(references.map((reference) => reference.digest))]
    const available = await Promise.all(blobs.map(async (blob, index) => {
      return Boolean(blob && await digestMedia(blob.blob) === digests[index])
    }))
    return { required: digests.length, missing: available.filter((isAvailable) => !isAvailable).length }
  }, [deckId])
  const [deckDialog, setDeckDialog] = useState(false)
  const [childDialog, setChildDialog] = useState(false)
  const [moveDialog, setMoveDialog] = useState(false)
  const [deleteDialog, setDeleteDialog] = useState(false)
  const [optionsDialog, setOptionsDialog] = useState(false)
  const [moveNote, setMoveNote] = useState<Note | null>(null)
  const [manageCardsNote, setManageCardsNote] = useState<Note | null>(null)
  const [noteDialog, setNoteDialog] = useState<{ note?: Note } | null>(null)
  const [preparingOffline, setPreparingOffline] = useState(false)
  const [offlineMessage, setOfflineMessage] = useState('')

  if (deck === undefined || summary === undefined) return <div className="loading-state" role="status">Loading local deck…</div>
  if (!deck || !summary) return <div className="loading-state"><h1>Deck not found</h1><button className="text-button" onClick={onBack}>Back to decks</button></div>

  const hasDueCards = due.length > 0

  async function prepareDeckOffline() {
    if (!offlineReadiness) return
    setPreparingOffline(true)
    setOfflineMessage('Checking this deck’s media before offline review…')
    try {
      const references = await readDeckMediaReferences(collection, deckId)
      for (const digest of new Set(references.map((reference) => reference.digest))) {
        const blob = await collection.verifiedMediaBlob(digest)
        if (blob) await collection.discardCorruptMediaBlob(digest)
      }
      const initiallyMissing = new Set((await collection.missingReferencedMedia()).map((reference) => reference.digest))
      const initiallyMissingFromDeck = new Set(references.map((reference) => reference.digest).filter((digest) => initiallyMissing.has(digest))).size
      if (initiallyMissingFromDeck === 0) {
        setOfflineMessage('This deck is ready for offline review. All referenced media is stored on this device.')
        return
      }
      setOfflineMessage('Syncing the collection to download this deck’s missing media…')
      const result = await syncCollection(collection)
      const latestReferences = await readDeckMediaReferences(collection, deckId)
      const missing = new Set((await collection.missingReferencedMedia()).map((reference) => reference.digest))
      const deckMissing = new Set(latestReferences.map((reference) => reference.digest).filter((digest) => missing.has(digest))).size
      if (deckMissing === 0) setOfflineMessage('This deck is ready for offline review. All referenced media is stored on this device.')
      else if (result.state === 'authentication-required') setOfflineMessage(`This deck needs ${deckMissing} media file${deckMissing === 1 ? '' : 's'} from the paired PC. Connect to the PC, sync, and prepare the deck again.`)
      else if (result.state === 'complete') setOfflineMessage(`${deckMissing} media file${deckMissing === 1 ? '' : 's'} could not be downloaded. Keep the PC reachable and try again before going offline.`)
      else if (result.state === 'backup-failed') setOfflineMessage(result.message)
      else setOfflineMessage(`This deck still needs ${deckMissing} media file${deckMissing === 1 ? '' : 's'}. The collection could not sync; try again while the PC is reachable.`)
    } catch (error) {
      setOfflineMessage(userFacingStorageError(error, 'This deck could not be checked. Free device storage and try again.'))
    } finally { setPreparingOffline(false) }
  }

  return (
    <>
      <section className="deck-detail-header">
        <button className="text-button back-button" type="button" onClick={onBack}>← All decks</button>
        <span className="section-code">{deck.name === SAMPLE_DECK_NAME ? 'SAMPLE // STARTER DECK' : 'DECK // LOCAL'}</span>
        <h1>{deck.name}</h1>
        <CountStrip counts={summary.counts} reviews={summary.reviewCount} />{deck.name === SAMPLE_DECK_NAME ? <p className="temporary-membership">A small sample collection for trying Japanese review. Remove it any time from this page.</p> : <p className="temporary-membership">{summary.sessionCount} home cards reserved for custom study. Home totals include them; today’s normal queue excludes them.</p>}
        <div className="deck-actions">
          <button className="text-button" type="button" disabled={preparingOffline || !offlineReadiness} onClick={() => void prepareDeckOffline()}>{preparingOffline ? 'Preparing offline…' : 'Prepare this deck for offline use'}</button>
          <button className="primary-action" type="button" onClick={() => setNoteDialog({})}>Add note</button>
          <button className="primary-action study-action" type="button" disabled={!hasDueCards} onClick={onStudy}>Study now</button>
          <button className="text-button" type="button" disabled={!hasDueCards} onClick={onChooseActivity}>Choose activity</button>
          <button className="text-button" type="button" onClick={() => setChildDialog(true)}>Create child deck</button>
          <button className="text-button" type="button" onClick={() => setMoveDialog(true)}>Move deck</button>
          <button className="text-button" type="button" onClick={() => setOptionsDialog(true)}>Scheduling options</button>
          <button className="text-button" type="button" onClick={() => setDeckDialog(true)}>Rename deck</button>
          <button className="text-button danger" type="button" onClick={() => setDeleteDialog(true)}>{deck.name === SAMPLE_DECK_NAME ? 'Remove sample deck' : 'Delete deck'}</button>
        </div>
        {offlineReadiness && <p className="temporary-membership" aria-live="polite">{offlineMessage || (offlineReadiness.missing === 0 ? `Offline ready · ${offlineReadiness.required} referenced media file${offlineReadiness.required === 1 ? '' : 's'} available.` : `${offlineReadiness.missing} of ${offlineReadiness.required} referenced media files need to be downloaded.`)}</p>}
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

export function CollectionWorkspace({ offlineSyncAvailable = true }: { offlineSyncAvailable?: boolean }) {
  const [route, navigate] = useRoute()
  const decks = useLiveQuery(() => collection.summaries(), [], [])
  const [newDeck, setNewDeck] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)

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
    if (route.view === 'activity-selection') return <ActivitySelection
      onBack={() => navigate(route.target.kind === 'deck' ? { view: 'deck', deckId: route.target.deckId } : { view: 'study' })}
      onSelect={(activityId) => navigate(route.target.kind === 'deck'
        ? { view: 'review', deckId: route.target.deckId, activityId }
        : { view: 'custom-review', sessionId: route.target.sessionId, activityId })}
    />
    if (route.view === 'review') return <ReviewSession activityId={route.activityId} deckId={route.deckId} onBack={() => navigate({ view: 'deck', deckId: route.deckId })} onExport={() => setExporting(true)} />
    if (route.view === 'deck') return <DeckDetail
      deckId={route.deckId}
      onBack={() => navigate({ view: 'decks' })}
      onStudy={() => navigate({ view: 'review', deckId: route.deckId, activityId: DEFAULT_LEARNING_ACTIVITY_ID })}
      onChooseActivity={() => navigate({ view: 'activity-selection', target: { kind: 'deck', deckId: route.deckId } })}
    />
    if (route.view === 'custom-review') return <ReviewSession activityId={route.activityId} sessionId={route.sessionId} onBack={() => navigate({ view: 'study' })} onExport={() => setExporting(true)} />
    if (route.view === 'study') return <CustomStudy
      onStudy={(sessionId) => navigate({ view: 'custom-review', sessionId, activityId: DEFAULT_LEARNING_ACTIVITY_ID })}
      onChooseActivity={(sessionId) => navigate({ view: 'activity-selection', target: { kind: 'session', sessionId } })}
    />
    if (route.view === 'statistics') return <Statistics />
    if (route.view === 'note-types') return <NoteTypeManager onNewDeck={() => { navigate({ view: 'decks' }); setNewDeck(true) }} />
    if (route.view === 'browse') return <CollectionBrowser />
    if (decks.length === 0) return <EmptyCollection onNewDeck={() => setNewDeck(true)} onImport={() => setImporting(true)} />
    return <DeckList decks={decks} onNewDeck={() => setNewDeck(true)} onImport={() => setImporting(true)} onOpen={(deckId) => navigate({ view: 'deck', deckId })} />
  }, [decks, navigate, route])

  return (
    <>
      <SyncControls offlineSyncAvailable={offlineSyncAvailable} collectionActions={<>
        <button className="text-button" onClick={() => setExporting(true)}>Export Anki package</button>
      </>} />
      <SyncConflicts />
      {content}
      {newDeck && <DeckDialog onClose={() => setNewDeck(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </>
  )
}
