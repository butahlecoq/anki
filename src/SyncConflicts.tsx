import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { collection, type SyncConflict } from './collection'

const recordValue = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function Version({ value, fieldNames }: { value: unknown; fieldNames: Record<string, string> }) {
  if (value === null) return <p>Deleted on another device.</p>
  if (!value || typeof value !== 'object') return <p>{String(value ?? '')}</p>
  const record = value as Record<string, unknown>
  const visible = Object.entries(record).filter(([key]) => !['id', 'typeId', 'deckId', 'noteId', 'templateId', 'createdAt', 'updatedAt'].includes(key))
  const updated = typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt)) ? record.updatedAt : undefined
  return <div className="sync-conflict-version">{updated && <p>Last edited <time dateTime={updated}>{new Date(updated).toLocaleString()}</time></p>}<dl>{visible.map(([key, item]) => <div key={key}><dt>{key === 'fields' ? 'Note content' : key.replace(/([A-Z])/g, ' $1')}</dt><dd>{typeof item === 'object' && item !== null ? Object.entries(item).map(([name, text]) => <p key={name}><strong>{fieldNames[name] ?? name}: </strong>{typeof text === 'string' ? text : JSON.stringify(text)}</p>) : String(item ?? 'None')}</dd></div>)}</dl></div>
}

export function SyncConflicts() {
  const conflicts = useLiveQuery(() => collection.syncConflicts.toArray(), [], [])
  const [selected, setSelected] = useState<SyncConflict | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const context = useLiveQuery(async () => {
    if (!selected) return undefined
    const version = selected.versions.map((version) => recordValue(version.value)).find(Boolean)
    const note = selected.entityType === 'note' ? version : typeof version?.noteId === 'string' ? await collection.notes.get(version.noteId) : undefined
    const type = typeof note?.typeId === 'string' ? await collection.noteTypes.get(note.typeId) : undefined
    const deckId = typeof version?.deckId === 'string' ? version.deckId : typeof note?.deckId === 'string' ? note.deckId : undefined
    const deck = deckId ? await collection.decks.get(deckId) : undefined
    const fields = recordValue(note?.fields)
    const expression = type && fields ? fields[type.fields[0]?.id] : undefined
    return { name: typeof expression === 'string' ? expression.slice(0, 100) : typeof version?.name === 'string' ? version.name : selected.entityId, type: type?.name, deck: deck?.name, fieldNames: Object.fromEntries(type?.fields.map((field) => [field.id, field.name]) ?? []) }
  }, [selected])
  if (!conflicts.length && !selected) return null
  async function resolve() {
    if (!selected || !choice) return
    setBusy(true); setError('')
    try {
      await collection.resolveSyncConflict(selected.key, choice, selected.heads)
      setSelected(null); setChoice('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save your choice.') }
    finally { setBusy(false) }
  }
  return <section aria-label="Sync conflicts" className="sync-controls">
    <div><h2>Review conflicting changes</h2><p>{conflicts.length} record{conflicts.length === 1 ? '' : 's'} need a choice. Both versions are saved on this device.</p></div>
    {conflicts.map((conflict) => <button className="text-button" key={conflict.key} onClick={() => { setSelected(conflict); setChoice(''); setError('') }}>Review {conflict.entityType === 'noteMedia' ? 'attachment' : conflict.entityType === 'deckOptionGroup' ? 'deck options' : conflict.entityType} conflict</button>)}
    {selected && <div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <h2 id="conflict-title">Choose the saved version</h2>
      {context && <p>Record: <strong>{context.name}</strong>{context.type && <> · {context.type}</>}{context.deck && <> · Deck: {context.deck}</>}</p>}
      <p>Conflicting properties: {selected.conflicts.map((path) => path.startsWith('fields.') ? context?.fieldNames[path.slice(7)] ?? path.slice(7) : path === '$deleted' ? 'Deletion' : path === '$' ? 'Whole record' : path.replace(/^\$schedule\.?/, 'Schedule ')).join(', ')}.</p>
      <p>{selected.deleted ? 'This record was deleted. Its other content remains saved for reference. Keeping the deletion prevents an older device from restoring it.' : 'Compare the changes below. Your choice will be sent to your other devices on the next sync.'}</p>
      {selected.versions.map((version, index) => <fieldset key={version.opId}><legend>Version {index + 1}</legend><Version value={version.value} fieldNames={context?.fieldNames ?? {}} />
        {(!selected.deleted || version.value === null) && <label><input type="radio" name="conflict-choice" value={version.opId} checked={choice === version.opId} onChange={() => setChoice(version.opId)} />{selected.deleted ? 'Keep deletion' : `Use version ${index + 1}`}</label>}
      </fieldset>)}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" disabled={busy} onClick={() => setSelected(null)}>Decide later</button><button className="primary-action" disabled={busy || !choice} onClick={() => void resolve()}>{busy ? 'Saving…' : 'Save choice'}</button></div>
    </section></div>}
  </section>
}
