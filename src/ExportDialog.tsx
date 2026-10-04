import { useState } from 'react'
import { useDialogKeyboard } from './use-dialog-keyboard'
import { useLiveQuery } from 'dexie-react-hooks'
import { collection } from './collection'
import { exportAnkiPackage } from './anki-export'

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const decks = useLiveQuery(() => collection.summaries(), [], [])
  const [deckId, setDeckId] = useState('')
  const [scheduling, setScheduling] = useState(true)
  const [history, setHistory] = useState(true)
  const [media, setMedia] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  async function download() {
    setBusy(true); setError(''); setResult('')
    try {
      const output = await exportAnkiPackage(collection, { deckId: deckId || undefined, scheduling, history, media })
      const url = URL.createObjectURL(new Blob([output.bytes.slice().buffer], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url; link.download = output.filename; document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setResult(`Package ready: ${output.notes} notes, ${output.cards} cards, ${output.reviews} reviews, ${output.media} media files. Save the download in Files or another location you control.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to export the package.') }
    finally { setBusy(false) }
  }
  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
    <button className="text-button" aria-label="Close export" disabled={busy} onClick={onClose}>Close</button>
    <span className="eyebrow">PORTABLE BACKUP</span><h2 id="export-title">Export Anki package</h2>
    <p>Save an independent .apkg file. Export works offline and includes the selected deck’s descendants.</p>
    <label>Export scope<select value={deckId} disabled={busy} onChange={(event) => setDeckId(event.target.value)}><option value="">Whole collection</option>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label>
    <label className="export-option"><input type="checkbox" checked={scheduling} disabled={busy} onChange={(event) => setScheduling(event.target.checked)} />Include scheduling and card suspension</label>
    <label className="export-option"><input type="checkbox" checked={history} disabled={busy} onChange={(event) => setHistory(event.target.checked)} />Include review history</label>
    <label className="export-option"><input type="checkbox" checked={media} disabled={busy} onChange={(event) => setMedia(event.target.checked)} />Include images and audio</label>
    {!scheduling && <p>Cards start as new when imported. Review history can be included independently.</p>}
    {!media && <p>Images and audio are omitted. Image occlusion requires media and will report an error.</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {result && <p role="status">{result}</p>}
    <button className="primary-action" disabled={busy} onClick={() => void download()}>{busy ? 'Preparing package…' : 'Download package'}</button>
  </section></div>
}
