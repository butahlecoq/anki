import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { collection, State, type Note } from './collection'
import { collectionDeckPaths, collectionSearchRows, compileCollectionSearch, plainField, SearchSyntaxError, type SearchRow } from './collection-search'
import { applyBulkAction, applyFieldChanges, previewFieldChanges, selectionSummary, type BrowserSelection, type BulkAction, type FieldChange, type FieldOperation } from './browser-maintenance'
import { customStudyMembership } from './custom-study-state'
import { unavailableReason } from './scheduler'
import { ImageOcclusionEditor } from './ImageOcclusion'
import { isRenderedCardEmpty, renderNoteCard } from './card-rendering'

type View = 'cards' | 'notes'
type Sort = { key: string; descending: boolean }
interface BrowserPreferences { view: View; query: string; sort: Sort; selected: { cards: string[]; notes: string[] } }
const preferenceKey = 'kiroku.collectionBrowser.v1'
const defaultPreferences: BrowserPreferences = { view: 'cards', query: '', sort: { key: 'front', descending: false }, selected: { cards: [], notes: [] } }
function savedPreferences(): BrowserPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null') as BrowserPreferences | null
    if (!saved || !['cards', 'notes'].includes(saved.view) || typeof saved.query !== 'string' || !saved.sort || typeof saved.sort.key !== 'string' || typeof saved.sort.descending !== 'boolean' || !Array.isArray(saved.selected?.cards) || !Array.isArray(saved.selected?.notes)) return defaultPreferences
    compileCollectionSearch(saved.query)
    return { ...saved, selected: { cards: saved.selected.cards.filter((id) => typeof id === 'string'), notes: saved.selected.notes.filter((id) => typeof id === 'string') } }
  } catch { return defaultPreferences }
}

const frontText = (row: SearchRow) => plainField(Object.values(row.note.fields).find(Boolean) ?? '(empty note)')
const rowId = (row: SearchRow, view: View) => view === 'cards' ? row.card!.id : row.note.id

function NoteEditor({ note, onClose }: { note: Note; onClose: () => void }) {
  const type = useLiveQuery(() => collection.noteTypes.get(note.typeId), [note.typeId])
  const [fields, setFields] = useState(note.fields)
  const [error, setError] = useState('')
  if (type?.kind === 'image-occlusion') return <ImageOcclusionEditor note={note} deckId={note.deckId} onClose={onClose} />
  return <div className="dialog-backdrop"><section className="dialog note-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-note-title"><h2 id="browser-note-title">Edit note fields</h2><form onSubmit={(event) => { event.preventDefault(); if (!type) return; const changes = type.fields.filter((field) => (fields[field.id] ?? '') !== (note.fields[field.id] ?? '')).map((field) => ({ noteId: note.id, typeId: type.id, fieldId: field.id, before: note.fields[field.id] ?? '', after: fields[field.id] ?? '', expectedNote: note, expectedType: type })); if (!changes.length) { onClose(); return } void applyFieldChanges(collection, changes).then(onClose).catch((reason) => setError(String(reason.message ?? reason))) }}>
    {type?.fields.map((field, index) => <label key={field.id}>{field.name}<textarea aria-label={field.name} autoFocus={index === 0} lang="ja" value={fields[field.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [field.id]: event.target.value }))} rows={3} /></label>)}
    <p>Generated cards keep their identities and review history. Empty or removed templates can suspend cards.</p>{error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit" disabled={!type}>Save fields</button></div>
  </form></section></div>
}

function BulkDialog({ selection, kind, onClose, onApplied }: { selection: BrowserSelection; kind: BulkAction['kind']; onClose: () => void; onApplied: (message: string) => void }) {
  const summary = useLiveQuery(() => selectionSummary(collection, selection).catch(() => null), [selection])
  const decks = useLiveQuery(() => collection.decks.orderBy('name').toArray(), [], [])
  const deckPaths = collectionDeckPaths(decks)
  const [tags, setTags] = useState('')
  const [tagMode, setTagMode] = useState<'add' | 'remove'>('add')
  const [destination, setDestination] = useState('')
  const [flag, setFlag] = useState(0)
  const [suspended, setSuspended] = useState(true)
  const [confirmed, setConfirmed] = useState('')
  const confirmationValid = Boolean(summary) && confirmed === JSON.stringify(summary)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function apply(event: FormEvent) {
    event.preventDefault()
    if (!summary || (kind === 'delete' && !confirmationValid)) return
    setBusy(true); setError('')
    const action: BulkAction = kind === 'tags' ? { kind, mode: tagMode, tags: tags.split(',') } : kind === 'move' ? { kind, deckId: destination } : kind === 'flag' ? { kind, flag } : kind === 'suspend' ? { kind, suspended } : { kind: 'delete' }
    try { const result = await applyBulkAction(collection, selection, action, new Date(), summary ?? undefined); onApplied(`Applied ${kind} to ${kind === 'flag' || kind === 'suspend' ? `${result.cards} cards` : `${result.notes} notes`}.`); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to apply this action.') }
    finally { setBusy(false) }
  }
  return <div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="browser-bulk-title"><span className="section-code">BROWSER // SELECTED RECORDS</span><h2 id="browser-bulk-title">{kind === 'delete' ? 'Delete selected notes' : kind === 'tags' ? 'Bulk tags' : kind === 'move' ? 'Move selected notes' : kind === 'flag' ? 'Flag selected cards' : 'Suspend selected cards'}</h2>
    {summary ? <p>{summary.notes} notes · {summary.selectedCards} selected cards · {summary.generatedCards} total generated cards.</p> : <p role="status">{summary === null ? 'The selection changed. Close this dialog and refresh your selection.' : 'Checking selection…'}</p>}
    <form onSubmit={apply}>
      {kind === 'tags' && <><label>Tag operation<select aria-label="Tag operation" value={tagMode} onChange={(event) => setTagMode(event.target.value as 'add' | 'remove')}><option value="add">Add tags</option><option value="remove">Remove tags</option></select></label><label>Tags<input aria-label="Tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="jlpt::n5, animal" /></label></>}
      {kind === 'move' && <label>Destination deck<select aria-label="Destination deck" value={destination} onChange={(event) => setDestination(event.target.value)}><option value="">Choose a deck</option>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deckPaths.get(deck.id)}</option>)}</select></label>}
      {kind === 'flag' && <label>Card flag<select aria-label="Card flag" value={flag} onChange={(event) => setFlag(Number(event.target.value))}>{['None', 'Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple'].map((label, index) => <option key={index} value={index}>{index} · {label}</option>)}</select></label>}
      {kind === 'suspend' && <label>Suspension<select aria-label="Suspension" value={suspended ? 'suspend' : 'restore'} onChange={(event) => setSuspended(event.target.value === 'suspend')}><option value="suspend">Suspend</option><option value="restore">Restore manual suspension</option></select></label>}
      {kind !== 'flag' && kind !== 'suspend' && <p>Note actions affect every card generated from those notes, including unselected siblings.</p>}
      {kind === 'delete' && <><p>This deletes the notes, all their cards, review history, and media references. Multi-note deletion has no partial undo.</p><label className="checkbox-label"><input type="checkbox" checked={confirmationValid} onChange={(event) => setConfirmed(event.target.checked ? JSON.stringify(summary) : '')} />I reviewed the affected counts and want to delete these notes.</label></>}
      {error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="text-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-action" type="submit" disabled={busy || !summary || (kind === 'delete' && !confirmationValid) || (kind === 'move' && !destination) || (kind === 'tags' && !tags.trim())}>{busy ? 'Applying…' : kind === 'delete' ? 'Delete notes and cards' : 'Apply to selection'}</button></div>
    </form>
  </section></div>
}

function FieldDialog({ selection, onClose, onApplied }: { selection: BrowserSelection; onClose: () => void; onApplied: (message: string) => void }) {
  const data = useLiveQuery(async () => {
    const cards = selection.view === 'cards' ? await collection.cards.bulkGet(selection.ids) : []
    const ids = selection.view === 'cards' ? [...new Set(cards.filter((card) => !!card).map((card) => card!.noteId))] : selection.ids
    const notes = (await collection.notes.bulkGet(ids)).filter((note): note is Note => Boolean(note))
    const types = await collection.noteTypes.bulkGet([...new Set(notes.map((note) => note.typeId))])
    return { notes, types: types.filter((type) => Boolean(type) && type!.kind !== 'image-occlusion').map((type) => type!) }
  }, [selection])
  const [fieldKey, setFieldKey] = useState('')
  const [mode, setMode] = useState<FieldOperation['mode']>('literal')
  const [find, setFind] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(true)
  const [preview, setPreview] = useState<FieldChange[] | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const invalidate = () => { setPreview(null); setConfirmed(false); setError('') }
  async function generate() {
    if (!data || !fieldKey) return
    setBusy(true); invalidate()
    try { const [typeId, fieldId] = JSON.parse(fieldKey) as [string, string]; setPreview(await previewFieldChanges(data.notes, data.types, { typeId, fieldId, mode, find, replacement, caseSensitive })) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to generate a preview.') }
    finally { setBusy(false) }
  }
  async function apply() {
    if (!preview?.length || !confirmed) return
    setBusy(true); setError('')
    try { const count = await applyFieldChanges(collection, preview); onApplied(`Updated fields in ${count} notes.`); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to apply the preview.'); setPreview(null); setConfirmed(false) }
    finally { setBusy(false) }
  }
  return <div className="dialog-backdrop"><section className="dialog type-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-field-title"><h2 id="browser-field-title">Find, replace, or edit fields</h2><p>{data?.notes.length ?? '…'} selected notes. Choose one note type and field; other types remain unchanged. Image occlusion uses its own editor.</p>
    <label>Field<select aria-label="Field" value={fieldKey} disabled={busy} onChange={(event) => { setFieldKey(event.target.value); invalidate() }}><option value="">Choose a field</option>{data?.types.flatMap((type) => type.fields.map((field) => <option key={JSON.stringify([type.id, field.id])} value={JSON.stringify([type.id, field.id])}>{type.name} · {field.name}</option>))}</select></label>
    <label>Replacement mode<select aria-label="Replacement mode" value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value as FieldOperation['mode']); invalidate() }}><option value="literal">Literal find/replace</option><option value="regex">Regular expression</option><option value="set">Set entire field</option></select></label>
    {mode !== 'set' && <label>Find<input aria-label="Find" value={find} disabled={busy} onChange={(event) => { setFind(event.target.value); invalidate() }} /></label>}
    <label>Replacement<textarea aria-label="Replacement" rows={3} value={replacement} disabled={busy} onChange={(event) => { setReplacement(event.target.value); invalidate() }} /></label>
    {mode !== 'set' && <label className="checkbox-label"><input type="checkbox" checked={caseSensitive} disabled={busy} onChange={(event) => { setCaseSensitive(event.target.checked); invalidate() }} />Case sensitive</label>}
    <p>Preview up to 5,000 notes or 8 MiB. Regex uses JavaScript Unicode matching and capture replacements; expensive patterns stop after two seconds without changing data.</p>
    <button className="text-button" type="button" disabled={busy || !fieldKey || (mode !== 'set' && !find)} onClick={() => void generate()}>{busy ? 'Working…' : 'Preview changes'}</button>
    {preview !== null && <section className="field-change-preview" aria-label="Field change preview"><h3>{preview.length} notes will change</h3>{preview.slice(0, 30).map((change) => <div key={change.noteId}><strong>{change.noteId}</strong><label>Before<textarea readOnly value={change.before} rows={2} /></label><label>After<textarea readOnly value={change.after} rows={2} /></label></div>)}{preview.length > 30 && <p>Showing the first 30 of {preview.length} changes.</p>}<label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed this preview and want to apply these field changes.</label></section>}
    {error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button className="text-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-action" type="button" disabled={busy || !preview?.length || !confirmed} onClick={() => void apply()}>Apply field changes</button></div>
  </section></div>
}

export function CollectionBrowser() {
  const [preferences, setPreferences] = useState(savedPreferences)
  const { view, query, sort } = preferences
  const [draft, setDraft] = useState(query)
  const [error, setError] = useState<SearchSyntaxError | null>(null)
  const [report, setReport] = useState<'all' | 'duplicates' | 'empty'>('all')
  const [page, setPage] = useState(0)
  const [message, setMessage] = useState('')
  const [bulk, setBulk] = useState<{ selection: BrowserSelection; kind: BulkAction['kind'] } | null>(null)
  const [fields, setFields] = useState<BrowserSelection | null>(null)
  const [editing, setEditing] = useState<Note | null>(null)
  const [now, setNow] = useState(() => new Date())
  const data = useLiveQuery(() => collection.transaction('r', [collection.decks, collection.notes, collection.cards, collection.noteTypes, collection.reviewEntries, collection.settings], async () => ({ temporary: await customStudyMembership(collection), decks: await collection.decks.toArray(), notes: await collection.notes.toArray(), cards: await collection.cards.toArray(), noteTypes: await collection.noteTypes.toArray(), reviews: await collection.reviewEntries.toArray() })), [])
  useEffect(() => {
    if (!data) return
    const cards = new Set(data.cards.map((card) => card.id)), notes = new Set(data.notes.map((note) => note.id))
    const persisted = { ...preferences, selected: { cards: preferences.selected.cards.filter((id) => cards.has(id)), notes: preferences.selected.notes.filter((id) => notes.has(id)) } }
    try { localStorage.setItem(preferenceKey, JSON.stringify(persisted)) } catch { /* Selection remains available for this open session. */ }
  }, [preferences, data])
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer) }, [])
  const allRows = useMemo(() => data ? collectionSearchRows(data) : [], [data])
  const duplicateIds = useMemo(() => {
    const groups = new Map<string, string[]>()
    for (const note of data?.notes ?? []) {
      const first = plainField(Object.values(note.fields)[0] ?? '').normalize('NFKC').trim().toLocaleLowerCase()
      if (!first) continue
      const key = JSON.stringify([note.typeId, first]), group = groups.get(key) ?? []
      group.push(note.id); groups.set(key, group)
    }
    return new Set([...groups.values()].filter((group) => group.length > 1).flat())
  }, [data])
  const rows = useMemo(() => {
    const predicate = compileCollectionSearch(query, now)
    let matches = allRows.filter(predicate).filter((row) => view === 'notes' || row.card)
    if (report === 'duplicates') matches = matches.filter((row) => duplicateIds.has(row.note.id))
    if (report === 'empty') matches = matches.filter((row) => {
      if (!row.card) return true
      const template = row.noteType?.templates.find((candidate) => candidate.id === row.card?.templateId)
      if (!template || !row.noteType) return true
      if (row.noteType.kind === 'image-occlusion') return false
      return isRenderedCardEmpty(renderNoteCard(row.noteType, template, row.note.fields, row.card.clozeOrdinal))
    })
    if (view === 'notes') matches = [...new Map(matches.map((row) => [row.note.id, row])).values()]
    const cardCounts = new Map<string, number>()
    for (const card of data?.cards ?? []) cardCounts.set(card.noteId, (cardCounts.get(card.noteId) ?? 0) + 1)
    const value = (row: SearchRow): string | number => sort.key === 'deck' ? row.deckPath : sort.key === 'type' ? row.noteType?.name ?? '' : sort.key === 'state' ? row.card?.state ?? 0 : sort.key === 'due' ? row.card?.state === State.New ? '' : row.card?.due ?? '' : sort.key === 'flag' ? row.card?.flag ?? 0 : sort.key === 'template' ? row.noteType?.templates.find((template) => template.id === row.card?.templateId)?.name ?? '' : sort.key === 'reviews' ? row.reviews.length : sort.key === 'cards' ? cardCounts.get(row.note.id) ?? 0 : sort.key === 'tags' ? (row.note.tags ?? []).join(' ') : sort.key === 'updated' ? row.note.updatedAt : frontText(row)
    const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })
    return matches.sort((left, right) => { const a = value(left), b = value(right); const order = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b)); return (sort.descending ? -order : order) || rowId(left, view).localeCompare(rowId(right, view)) })
  }, [allRows, query, now, view, report, duplicateIds, sort, data])
  const availableIds = new Set(view === 'cards' ? data?.cards.map((card) => card.id) : data?.notes.map((note) => note.id))
  const selected = new Set(preferences.selected[view].filter((id) => availableIds.has(id)))
  const selection: BrowserSelection = { view, ids: [...selected] }
  const pages = Math.max(1, Math.ceil(rows.length / 50)), currentPage = Math.min(page, pages - 1)
  const visible = rows.slice(currentPage * 50, currentPage * 50 + 50)
  const columns = view === 'cards' ? [['front', 'Expression'], ['deck', 'Deck'], ['type', 'Note type'], ['state', 'State'], ['due', 'Due'], ['flag', 'Flag'], ['template', 'Template'], ['reviews', 'Reviews']] : [['front', 'Expression'], ['deck', 'Deck'], ['type', 'Note type'], ['cards', 'Cards'], ['tags', 'Tags'], ['updated', 'Updated']]
  function select(ids: string[], checked: boolean) {
    setPreferences((current) => { const next = new Set(current.selected[view]); for (const id of ids) { if (checked) next.add(id); else next.delete(id) } return { ...current, selected: { ...current.selected, [view]: [...next] } } })
  }
  function search(event: FormEvent) {
    event.preventDefault()
    try { compileCollectionSearch(draft, now); setPreferences((current) => ({ ...current, query: draft })); setError(null); setPage(0) }
    catch (reason) { setError(reason instanceof SearchSyntaxError ? reason : new SearchSyntaxError(0, 'Unable to parse this search.')) }
  }
  if (!data) return <p role="status">Loading collection browser…</p>
  return <div className="collection-browser"><section className="compact-hero"><div><span className="section-code">03 // COLLECTION BROWSER</span><h1>Find what <em>needs attention</em></h1><p>Search and maintain your collection, including while offline.</p></div></section>
    <form className="browser-search" onSubmit={search}><label>Collection search<input aria-label="Collection search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={'deck:Japanese (猫 OR 犬) -is:suspended'} maxLength={4000} /></label><button className="primary-action" type="submit">Search</button></form>
    {error && <div className="form-error" role="alert">Search error at character {error.position + 1}: {error.message} Showing the last valid search: {query || '(all records)'}.<pre>{draft}{'\n'}{' '.repeat(error.position)}^</pre></div>}
    <details className="browser-search-help"><summary>Search syntax</summary><p>Text matches note fields. Combine terms with spaces (AND), OR, parentheses, and a leading - to exclude. Quote values with spaces. Operators: deck, tag, is, due, note, flag, card, rated, reviewed. Deck names include children. Field filters accept * and ? wildcards. Dates use local YYYY-MM-DD with optional &lt;, &lt;=, &gt;, &gt;=, or =.</p><p>Examples: tag:jlpt::* · note:"Basic reversed" · flag:3 · card:Recognition · is:due · due:&lt;2026-10-01 · rated:7:1 (Again in the last seven local days) · reviewed:2026-10-01. States: new, learn, learning, relearning, review, suspended, buried, due.</p></details>
    <div className="browser-controls"><label>Result view<select aria-label="Result view" value={view} onChange={(event) => { setPreferences((current) => ({ ...current, view: event.target.value as View, sort: { key: 'front', descending: false } })); setPage(0) }}><option value="cards">Cards</option><option value="notes">Notes</option></select></label><label>Report<select aria-label="Report" value={report} onChange={(event) => { setReport(event.target.value as typeof report); setPage(0) }}><option value="all">All matching records</option><option value="duplicates">Duplicate notes</option><option value="empty">Empty cards / notes without cards</option></select></label><span aria-live="polite">{rows.length} {view} · {selected.size} selected</span></div>
    {report === 'duplicates' && <p>Duplicates share a note type and normalized first field. Review the records before deleting.</p>}{report === 'empty' && <p>Empty fronts and missing templates appear here. Switch to Notes to include notes without generated cards. Template errors are reported in the editor.</p>}
    <div className="browser-bulk-actions"><button className="text-button" type="button" onClick={() => select(rows.map((row) => rowId(row, view)), true)}>Select all results</button><button className="text-button" type="button" onClick={() => select([...selected], false)} disabled={!selected.size}>Clear selection</button>{(['tags', 'move', 'suspend', 'flag', 'delete'] as const).map((kind) => <button className={`text-button${kind === 'delete' ? ' danger' : ''}`} key={kind} type="button" disabled={!selected.size} onClick={() => setBulk({ selection, kind })}>{kind === 'tags' ? 'Tag selection' : kind === 'move' ? 'Move selection' : kind === 'suspend' ? 'Suspend / restore' : kind === 'flag' ? 'Flag selection' : 'Delete selection'}</button>)}<button className="text-button" type="button" disabled={!selected.size} onClick={() => setFields(selection)}>Find / replace / edit</button></div>
    <p className="browser-selection-note">Selection follows stable record IDs across sorting and reload. Selected records outside this search remain selected. Note actions affect all sibling cards.</p>
    {message && <p role="status">{message}</p>}
    <div className="browser-table-scroll"><table className="browser-table"><caption>{view === 'cards' ? 'Card results' : 'Note results'} · page {currentPage + 1} of {pages}</caption><thead><tr><th><input type="checkbox" aria-label="Select this page" checked={visible.length > 0 && visible.every((row) => selected.has(rowId(row, view)))} onChange={(event) => select(visible.map((row) => rowId(row, view)), event.target.checked)} /></th>{columns.map(([key, label]) => <th key={key} aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : 'none'}><button className="text-button" type="button" onClick={() => setPreferences((current) => ({ ...current, sort: { key, descending: current.sort.key === key && !current.sort.descending } }))}>{label}{sort.key === key ? sort.descending ? ' ↓' : ' ↑' : ''}</button></th>)}</tr></thead><tbody>{visible.map((row) => <tr key={rowId(row, view)} className={selected.has(rowId(row, view)) ? 'selected' : ''}><td><input type="checkbox" aria-label={`Select ${view === 'cards' ? 'card' : 'note'} ${rowId(row, view)}`} checked={selected.has(rowId(row, view))} onChange={(event) => select([rowId(row, view)], event.target.checked)} /></td><td><button className="text-button browser-expression" type="button" onClick={() => setEditing(row.note)}>{frontText(row).slice(0, 100)}</button></td><td>{row.deckPath}{row.card && data.temporary.has(row.card.id) && <small className="temporary-membership">Custom session: {data.temporary.get(row.card.id)} (home deck unchanged)</small>}</td><td>{row.noteType?.name ?? 'Missing type'}</td>{view === 'cards' ? <><td>{unavailableReason(row.card!, now) ? 'Suspended' : State[row.card!.state]}</td><td>{row.card!.state === State.New ? 'New' : new Date(row.card!.due).toLocaleString()}</td><td>{row.card!.flag ?? 0}</td><td>{row.noteType?.templates.find((template) => template.id === row.card!.templateId)?.name ?? 'Missing template'}</td><td>{row.reviews.length}</td></> : <><td>{data.cards.filter((card) => card.noteId === row.note.id).length}</td><td>{(row.note.tags ?? []).join(', ') || '—'}</td><td>{new Date(row.note.updatedAt).toLocaleString()}</td></>}</tr>)}</tbody></table></div>
    {!rows.length && <p>No records match. Adjust the search or report, or add notes to begin.</p>}
    <div className="browser-pagination"><button className="text-button" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous page</button><span>Page {currentPage + 1} of {pages}</span><button className="text-button" type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next page</button></div>
    {bulk && <BulkDialog {...bulk} onClose={() => setBulk(null)} onApplied={setMessage} />}{fields && <FieldDialog selection={fields} onClose={() => setFields(null)} onApplied={setMessage} />}{editing && <NoteEditor key={editing.id} note={editing} onClose={() => setEditing(null)} />}
  </div>
}
