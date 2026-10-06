import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { collection } from './collection'
import { collectionDeckPaths, SearchSyntaxError } from './collection-search'
import { changeCustomStudy, createCustomStudy, customPreset, customStudyQueue, previewCustomStudy, type CustomStudyDefinition } from './custom-study'
import { customStudySessions, type CustomStudyOrder, type CustomStudySession } from './custom-study-state'
import { useDialogKeyboard } from './use-dialog-keyboard'
import { userFacingStorageError } from './offline-storage'
import { readCardIds, readDeckList } from './collection-queries'

export function CustomStudy({ onStudy, onChooseActivity }: { onStudy: (id: string) => void; onChooseActivity: (id: string) => void }) {
  const [preset, setPreset] = useState('catch-up')
  const [definition, setDefinition] = useState<CustomStudyDefinition>(() => ({ name: '', ...customPreset('catch-up'), limit: 20, reschedule: false }))
  const [focusDeck, setFocusDeck] = useState('')
  const [focusTag, setFocusTag] = useState('')
  const [preview, setPreview] = useState<{ definition: string; matching: number; selected: number; expressions: string[] } | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<{ session: CustomStudySession; action: 'rebuild' | 'empty' | 'delete' } | null>(null)
  const confirmationKeyboard = useDialogKeyboard(() => setConfirmation(null), Boolean(confirmation))
  const data = useLiveQuery(async () => {
    const sessions = await customStudySessions(collection)
    const cards = new Set(await readCardIds(collection))
    return { decks: await readDeckList(collection), sessions: await Promise.all(sessions.map(async (session) => ({ session, remaining: session.cardIds.filter((id) => cards.has(id)).length, available: (await customStudyQueue(collection, session.id)).length }))) }
  }, [])
  function update<K extends keyof CustomStudyDefinition>(key: K, value: CustomStudyDefinition[K]) { setDefinition((current) => ({ ...current, [key]: value })); setPreview(null); setError('') }
  function focusQuery(deck: string, tag: string) {
    const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    update('search', [deck ? `deck:${quote(deck)}` : '', tag.trim() ? `tag:${quote(tag.trim())}` : ''].filter(Boolean).join(' ') || 'deck:*')
  }
  async function inspect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const value = await previewCustomStudy(collection, definition)
      setPreview({ definition: JSON.stringify(definition), matching: value.matching, selected: value.cards.length, expressions: value.expressions })
    } catch (reason) { setPreview(null); setError(reason instanceof SearchSyntaxError ? `Search error at character ${reason.position + 1}: ${reason.message}` : reason instanceof Error ? reason.message : 'Unable to preview this session.') }
    finally { setBusy(false) }
  }
  async function create() {
    setBusy(true); setError('')
    try { const session = await createCustomStudy(collection, definition); setMessage(`Created ${session.name} with ${session.cardIds.length} temporary cards.`); setPreview(null); setDefinition((current) => ({ ...current, name: '' })) }
    catch (reason) { setError(userFacingStorageError(reason, 'Unable to create this session.')) }
    finally { setBusy(false) }
  }
  async function apply() {
    if (!confirmation) return
    setBusy(true); setError('')
    try { await changeCustomStudy(collection, confirmation.session.id, confirmation.action); setMessage(`${confirmation.session.name}: ${confirmation.action === 'rebuild' ? 'rebuilt from its search' : confirmation.action === 'empty' ? 'emptied; cards available in their home decks' : 'deleted; cards available in their home decks'}. Scheduling and review history were preserved.`); setConfirmation(null) }
    catch (reason) { setError(userFacingStorageError(reason, 'Unable to update this session.')) }
    finally { setBusy(false) }
  }
  const paths = collectionDeckPaths(data?.decks ?? [])
  return <div className="custom-study"><section className="compact-hero"><div><span className="section-code">CUSTOM STUDY // TEMPORARY FOCUS</span><h1>Choose your <em>next focus</em></h1><p>Cards keep their home decks. Custom sessions live on this device; their reviews sync with your collection.</p></div></section>
    <section className="custom-study-create" aria-label="Create a custom session"><h2>Create a custom session</h2><form onSubmit={(event) => void inspect(event)}>
      <label>Session name<input value={definition.name} maxLength={100} required onChange={(event) => update('name', event.target.value)} /></label>
      <label>Study preset<select value={preset} onChange={(event) => { const value = event.target.value; setPreset(value); setDefinition((current) => ({ ...current, ...customPreset(value) })); setPreview(null); setError('') }}><option value="catch-up">Catch up · cards due now</option><option value="ahead">Study ahead · future reviews</option><option value="forgotten">Forgotten · Again in the last seven days</option><option value="focus">Focus on a tag or home deck</option></select></label>
      {preset === 'focus' && <><label>Focus home deck<select value={focusDeck} onChange={(event) => { setFocusDeck(event.target.value); focusQuery(event.target.value, focusTag) }}><option value="">All home decks</option>{[...paths.values()].map((path) => <option key={path} value={path}>{path}</option>)}</select></label><label>Focus tag<input value={focusTag} onChange={(event) => { setFocusTag(event.target.value); focusQuery(focusDeck, event.target.value) }} placeholder="jlpt::n5" /></label></>}
      <label>Session search<input value={definition.search} maxLength={4000} onChange={(event) => update('search', event.target.value)} /></label><p className="custom-study-help">Uses the browser search syntax. Suspended, buried, empty, and missing-template cards are excluded. Cards already reserved by another session are excluded. Custom limits replace normal daily queue limits.</p>
      <label>Card limit<input type="number" min={1} max={5000} step={1} value={definition.limit} onChange={(event) => update('limit', Number(event.target.value))} /></label>
      <label>Session order<select value={definition.order} onChange={(event) => update('order', event.target.value as CustomStudyOrder)}><option value="due">Oldest due first</option><option value="added">Oldest added first</option><option value="random">Stable shuffled order</option><option value="forgotten">Most recently forgotten first</option></select></label>
      <label>Review scheduling<select value={definition.reschedule ? 'reschedule' : 'practice'} onChange={(event) => update('reschedule', event.target.value === 'reschedule')}><option value="practice">Practice once · keep the original schedule</option><option value="reschedule">Reschedule with the home deck's FSRS options</option></select></label>
      <p className="custom-study-help">{definition.reschedule ? 'Every rating updates the home card, even ahead of its due date, and counts toward daily limits. Each rated card returns home; learning steps continue in the normal queue.' : 'Every rating is recorded as practice. Due dates, FSRS state, sibling burial, leech state, and daily scheduling limits stay unchanged. Each rated card returns home.'}</p>
      <button className="text-button" type="submit" disabled={busy}>Preview session</button>
      {preview && <section className="custom-study-preview" aria-label="Session preview"><h3>{preview.selected} cards selected from {preview.matching} matches</h3><ul>{preview.expressions.map((expression, index) => <li key={index}>{expression.replace(/<[^>]*>/g, '').slice(0, 100)}</li>)}</ul>{preview.selected > 10 && <p>Showing the first ten selected cards.</p>}<button className="primary-action" type="button" disabled={busy || preview.definition !== JSON.stringify(definition)} onClick={() => void create()}>Create session</button></section>}
    </form></section>
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <section aria-label="Custom sessions" className="custom-session-list"><h2>Your custom sessions</h2>{!data ? <p role="status">Loading custom sessions…</p> : !data.sessions.length ? <p>No custom sessions yet. Preview a search above to begin.</p> : data.sessions.map(({ session, remaining, available }) => <article className="custom-session" key={session.id}><h3>{session.name}</h3><p>{remaining} temporary cards · {available} available now · {session.completed.length} answered in this build</p><p>{session.reschedule ? 'Reviews reschedule home cards' : 'Practice keeps original scheduling'} · {session.search || 'All matching cards'} · limit {session.limit}</p><div className="custom-session-actions"><button className="primary-action" type="button" disabled={!available} onClick={() => onStudy(session.id)}>Study {session.name}</button><button className="text-button" type="button" disabled={!available} onClick={() => onChooseActivity(session.id)}>Choose activity</button>{(['rebuild', 'empty', 'delete'] as const).map((action) => <button className={`text-button${action === 'delete' ? ' danger' : ''}`} key={action} type="button" onClick={() => setConfirmation({ session, action })}>{action === 'rebuild' ? 'Rebuild' : action === 'empty' ? 'Empty' : 'Delete'} {session.name}</button>)}</div></article>)}</section>
    {confirmation && <div className="dialog-backdrop"><section {...confirmationKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="custom-study-confirmation"><h2 id="custom-study-confirmation">{confirmation.action === 'rebuild' ? 'Rebuild' : confirmation.action === 'empty' ? 'Empty' : 'Delete'} custom session</h2><p>{confirmation.session.name}: {confirmation.session.cardIds.length} remaining temporary memberships.</p><p>{confirmation.action === 'rebuild' ? 'Re-run the saved search and replace this session’s membership. Previously answered cards may match again.' : 'Return all remaining cards to normal study in their existing home decks.'} No cards or notes are deleted. Review history and scheduling remain intact.</p>{error && <p role="alert">{error}</p>}<div className="dialog-actions"><button className="text-button" data-dialog-initial-focus type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button className="primary-action" type="button" disabled={busy} onClick={() => void apply()}>Confirm {confirmation.action}</button></div></section></div>}
  </div>
}
