import { useEffect, useRef, useState, type FormEvent } from 'react'
import { mediaTypeForFilename } from '../anki-interchange'
import type { SyncSettings } from './collection.js'
import { nativeAnkiAccountErrorMessage } from './native-anki-account-message.js'
import { collection } from './collection.js'
import { connectNativeAnkiAccount, prepareNativeAccountImport, type NativeAnkiAccountSession, type PreparedNativeAccountImport } from './native-anki-account-session.js'
import { ImportSkipReport } from './ImportSkipReport.js'
import { isSafeServiceEndpoint } from './sync-client.js'
import { useDialogKeyboard } from './use-dialog-keyboard.js'

function AccountMediaVersion({ label, name, bytes }: { label: string; name: string; bytes: Uint8Array | null }) {
  const host = useRef<HTMLSpanElement>(null)
  const mime = mediaTypeForFilename(name)
  useEffect(() => {
    if (!bytes || !mime) return
    const objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }))
    host.current?.querySelector('img, audio')?.setAttribute('src', objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [bytes, mime])
  if (!bytes || !mime) return <span>{label}: content unavailable for preview</span>
  return mime.startsWith('image/')
    ? <span ref={host}>{label}: <img className="account-media-conflict-image" alt={`${label} ${name}`} /></span>
    : <span ref={host}>{label}: <audio controls preload="metadata">{name}</audio></span>
}

export function AnkiWebAccountDialog({ settings, onClose }: { settings: SyncSettings; onClose: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [session, setSession] = useState<NativeAnkiAccountSession>()
  const [accountMediaFiles, setAccountMediaFiles] = useState(0)
  const [accountMediaCursor, setAccountMediaCursor] = useState(0)
  const [mediaRecoveryRequired, setMediaRecoveryRequired] = useState(false)
  const [mediaConflicts, setMediaConflicts] = useState<Awaited<ReturnType<NativeAnkiAccountSession['media']['unresolvedConflicts']>>>([])
  const [accountPlan, setAccountPlan] = useState<PreparedNativeAccountImport>()
  const [importRepresentableOnly, setImportRepresentableOnly] = useState(false)
  const [importCommitted, setImportCommitted] = useState(false)
  const sessionRef = useRef<NativeAnkiAccountSession | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const dialogKeyboard = useDialogKeyboard(onClose, true)

  async function refreshAccountMedia(account: NativeAnkiAccountSession) {
    const [files, cursor, attempt, conflicts] = await Promise.all([
      account.media.files.filter((file) => file.bytes !== null).count(),
      account.media.cursor(),
      account.media.attempts.get('active'),
      account.media.unresolvedConflicts(),
    ])
    setAccountMediaFiles(files)
    setAccountMediaCursor(cursor)
    setMediaRecoveryRequired(Boolean(attempt))
    setMediaConflicts(conflicts)
  }

  useEffect(() => () => {
    sessionRef.current?.disconnect()
    sessionRef.current = undefined
  }, [])

  async function connect(event: FormEvent) {
    event.preventDefault()
    if (!isSafeServiceEndpoint(settings.endpoint)) {
      setMessage('The paired PC address is not a safe private-service URL. No AnkiWeb request was sent.')
      return
    }
    setBusy(true)
    setMessage('Connecting through your PC service…')
    try {
      const account = await connectNativeAnkiAccount(settings, username, password)
      sessionRef.current = account
      setSession(account)
      await refreshAccountMedia(account)
      setMessage('Account connected. No notes, cards, or study history were uploaded.')
    } catch (error) {
      setMessage(nativeAnkiAccountErrorMessage(error))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  async function downloadAccountMedia() {
    if (!session) return
    setBusy(true)
    setMessage(mediaRecoveryRequired ? 'Resuming account media synchronization…' : 'Downloading and verifying account media…')
    try {
      const recovery = Boolean(await session.media.attempts.get('active'))
      const result = await session.media.synchronize(session.client, recovery)
      setAccountPlan(undefined)
      await refreshAccountMedia(session)
      setMessage(`${result.files} verified account media files are stored on this device. Preview the account collection again to include them.`)
    } catch (error) {
      await refreshAccountMedia(session)
      setMessage(error instanceof Error ? error.message : 'Account media could not be verified. Existing verified files remain available.')
    } finally { setBusy(false) }
  }

  async function chooseMediaConflict(name: string, choice: 'local' | 'remote') {
    if (!session) return
    setBusy(true)
    try {
      await session.media.resolve(name, choice)
      await refreshAccountMedia(session)
      setMessage(`${name}: ${choice === 'local' ? 'device' : 'AnkiWeb'} media version selected. Continue synchronization to converge the account copies.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The media version could not be selected.')
    } finally { setBusy(false) }
  }

  function disconnect() {
    sessionRef.current?.disconnect()
    sessionRef.current = undefined
    setSession(undefined)
    setAccountPlan(undefined)
    setAccountMediaFiles(0)
    setAccountMediaCursor(0)
    setMediaRecoveryRequired(false)
    setMediaConflicts([])
    setImportRepresentableOnly(false)
    setImportCommitted(false)
    setUsername('')
    setPassword('')
    setMessage('Disconnected. The downloaded account collection remains on this device.')
  }

  async function previewAccountCollection() {
    if (!session) return
    setBusy(true)
    setMessage('Preparing an Import Plan from the downloaded account snapshot…')
    try {
      const prepared = await prepareNativeAccountImport(session, collection)
      setAccountPlan(prepared)
      setImportRepresentableOnly(false)
      setImportCommitted(false)
      setMessage('Review the account snapshot before copying it to this device.')
    } catch (error) {
      setAccountPlan(undefined)
      setMessage(error instanceof Error ? error.message : 'The account collection could not be prepared. No local collection rows were changed.')
    } finally { setBusy(false) }
  }

  async function importAccountCollection() {
    if (!accountPlan) return
    setBusy(true)
    try {
      await accountPlan.commit({ importRepresentableOnly })
      setImportCommitted(true)
      setMessage('The reviewed account snapshot is now available in this device’s offline collection. The AnkiWeb account remains authoritative; no changes were uploaded.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The account collection was not copied. The local collection was left unchanged.')
    } finally { setBusy(false) }
  }

  return (
    <div className="dialog-backdrop">
      <section {...dialogKeyboard} className="dialog ankiweb-account-dialog" role="dialog" aria-modal="true" aria-labelledby="ankiweb-dialog-title">
        <span className="section-code">ACCOUNT // ANKIWEB</span>
        <h2 id="ankiweb-dialog-title">Connect AnkiWeb</h2>
        <p>AnkiWeb credentials are held in memory only and sent through your paired PC service. Account data is kept in a separate local store and is not part of Kiroku exports or PC backups.</p>
        {!session ? (
          <form onSubmit={(event) => void connect(event)}>
            <label>AnkiWeb username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={256} /></label>
            <label>AnkiWeb password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {message && <p role="status" aria-live="polite">{message}</p>}
            <div className="dialog-actions">
              <button className="text-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="primary-action" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect account'}</button>
            </div>
          </form>
        ) : (
          <section aria-label="AnkiWeb account decks">
            <p role="status" aria-live="polite">Connected as {session.username}. {message}</p>
            <h3>Decks</h3>
            {session.decks.length ? <ul className="ankiweb-deck-list">{session.decks.map((deck) => <li key={deck.id}><strong>{deck.name}</strong><span>{deck.path}</span></li>)}</ul> : <p>This account has no decks.</p>}
            <section className="account-media-status" aria-label="Account media">
              <h3>Account media</h3>
              <p>{accountMediaFiles} verified files stored on this device · media revision {accountMediaCursor}.</p>
              <button className="text-button" type="button" disabled={busy || mediaConflicts.length > 0} onClick={() => void downloadAccountMedia()}>{busy ? 'Synchronizing media…' : mediaRecoveryRequired ? 'Continue account media sync' : 'Download and verify account media'}</button>
              {mediaConflicts.length > 0 && <section className="import-report" aria-label="Account media choices">
                <h4>Choose which verified version to keep</h4>
                <ul>{mediaConflicts.map((conflict) => <li key={conflict.name}>
                  <strong>{conflict.name}</strong>
                  <AccountMediaVersion label="Device" name={conflict.name} bytes={conflict.local.bytes} />
                  <span>Device SHA-256: {conflict.local.sha256}</span>
                  <AccountMediaVersion label="AnkiWeb" name={conflict.name} bytes={conflict.remote.bytes} />
                  <span>AnkiWeb SHA-256: {conflict.remote.sha256}</span>
                  <button className="text-button" type="button" disabled={busy} onClick={() => void chooseMediaConflict(conflict.name, 'local')}>Use device version</button>
                  <button className="text-button" type="button" disabled={busy} onClick={() => void chooseMediaConflict(conflict.name, 'remote')}>Use AnkiWeb version</button>
                </li>)}</ul>
              </section>}
            </section>
            <button className="text-button" type="button" disabled={busy} onClick={() => void previewAccountCollection()}>{busy && !accountPlan ? 'Preparing…' : 'Preview account collection'}</button>
            {accountPlan && <section className="import-summary" aria-label="Account Import Plan">
              <h3>Account Import Plan · revision {accountPlan.revision}</h3>
              <p>The downloaded snapshot remains the authoritative account copy. This plan copies its representable rows into this device’s separate offline collection; it does not write to AnkiWeb.</p>
              <ul>
                <li>{accountPlan.prepared.summary.decks} Decks</li>
                <li>{accountPlan.prepared.summary.noteTypes} note types</li>
                <li>{accountPlan.prepared.summary.notes} notes</li>
                <li>{accountPlan.prepared.summary.cards} cards</li>
                <li>{accountPlan.prepared.summary.reviews} review entries</li>
                <li>{accountPlan.prepared.summary.media} media files</li>
              </ul>
              <p>Snapshot hash: <code>{accountPlan.snapshotHash}</code></p>
              {accountPlan.prepared.issues.length > 0 && <section className="import-report" aria-label="Account import findings"><h4>Import findings</h4><ul>{accountPlan.prepared.issues.map((issue, index) => <li key={`${issue.code}-${issue.subject}-${index}`} className={`import-${issue.severity}`}><strong>{issue.subject}</strong><span>{issue.detail}</span></li>)}</ul></section>}
              <details>
                <summary>Review all {accountPlan.prepared.plan.decisions.length} planned row changes</summary>
                <ul>{accountPlan.prepared.plan.decisions.map((decision, index) => <li key={`${decision.entity}:${decision.id}:${index}`}>{decision.entity} · {decision.action} · {decision.id}</li>)}</ul>
              </details>
              {accountPlan.prepared.plan.blocksImport && !accountPlan.prepared.plan.canImportRepresentable && <p className="form-error" role="alert">Some unsupported rows cannot be isolated safely. Nothing will be copied.</p>}
              {accountPlan.prepared.plan.canImportRepresentable && accountPlan.prepared.plan.requiresPartialChoice && <label className="export-option import-partial-choice">
                <input type="checkbox" checked={importRepresentableOnly} disabled={busy || importCommitted} onChange={(event) => setImportRepresentableOnly(event.target.checked)} />
                Import {accountPlan.prepared.summary.notes} representable notes and skip {accountPlan.prepared.skipped.length} unsupported notes with {accountPlan.prepared.skipped.reduce((sum, note) => sum + note.cardIds.length, 0)} cards. Save this choice for later account refreshes.
              </label>}
              {accountPlan.prepared.plan.savedPartialChoice && <p className="import-warning" role="status">The saved representable-only choice remains active. These same notes stay omitted on later account refreshes.</p>}
              <ImportSkipReport skipped={accountPlan.prepared.skipped} />
              {importCommitted && <p className="import-complete" role="status">The representable portion is available in this device’s offline collection. Listed notes remain omitted; no changes were uploaded.</p>}
              <button className="primary-action" type="button" disabled={busy || importCommitted || (accountPlan.prepared.plan.blocksImport && !importRepresentableOnly)} onClick={() => void importAccountCollection()}>{busy ? 'Importing…' : importRepresentableOnly ? 'Import representable notes to this device' : 'Import reviewed collection to this device'}</button>
            </section>}
            <p>Closing this dialog ends the in-memory session. Your downloaded collection remains available for offline study.</p>
            <div className="dialog-actions">
              <button className="text-button" type="button" disabled={busy} onClick={disconnect}>Disconnect</button>
              <button className="primary-action" type="button" onClick={onClose}>Done</button>
            </div>
          </section>
        )}
      </section>
    </div>
  )
}
