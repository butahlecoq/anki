import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { collection, type SyncConflict } from './collection'

function Version({ value }: { value: unknown }) {
  if (value === null) return <p>Deleted on another device.</p>
  if (!value || typeof value !== 'object') return <p>{String(value ?? '')}</p>
  const record = value as Record<string, unknown>
  const visible = Object.entries(record).filter(([key]) => !['id', 'typeId', 'deckId', 'noteId', 'templateId', 'createdAt', 'updatedAt'].includes(key))
  return <dl>{visible.map(([key, item]) => <div key={key}><dt>{key === 'fields' ? 'Note content' : key.replace(/([A-Z])/g, ' $1')}</dt><dd>{typeof item === 'object' && item !== null ? Object.entries(item).map(([name, text]) => <p key={name}>{typeof text === 'string' ? text : JSON.stringify(text)}</p>) : String(item ?? 'None')}</dd></div>)}</dl>
}

export function SyncConflicts() {
  const conflicts = useLiveQuery(() => collection.syncConflicts.toArray(), [], [])
  const [selected, setSelected] = useState<SyncConflict | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
      <p>{selected.deleted ? 'This record was deleted. Its other content remains saved for reference. Keeping the deletion prevents an older device from restoring it.' : 'Compare the changes below. Your choice will be sent to your other devices on the next sync.'}</p>
      {selected.versions.map((version, index) => <fieldset key={version.opId}><legend>Version {index + 1}</legend><Version value={version.value} />
        {(!selected.deleted || version.value === null) && <label><input type="radio" name="conflict-choice" value={version.opId} checked={choice === version.opId} onChange={() => setChoice(version.opId)} />{selected.deleted ? 'Keep deletion' : `Use version ${index + 1}`}</label>}
      </fieldset>)}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" disabled={busy} onClick={() => setSelected(null)}>Decide later</button><button className="primary-action" disabled={busy || !choice} onClick={() => void resolve()}>{busy ? 'Saving…' : 'Save choice'}</button></div>
    </section></div>}
  </section>
}
