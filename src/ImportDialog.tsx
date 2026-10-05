import { useState } from 'react'
import { collection } from './collection'
import { prepareAnkiImport, type PreparedAnkiImport } from './anki-import'
import { useDialogKeyboard } from './use-dialog-keyboard'
export function ImportDialog({ onClose }: { onClose: () => void }) {
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
