import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { SyncSettings } from './collection.js'
import { NativeSyncError } from './native-anki-sync.js'
import { collection } from './collection.js'
import { connectNativeAnkiAccount, prepareNativeAccountImport, type NativeAnkiAccountSession, type PreparedNativeAccountImport } from './native-anki-account-session.js'
import { ImportSkipReport } from './ImportSkipReport.js'
import { isSafeServiceEndpoint } from './sync-client.js'
import { useDialogKeyboard } from './use-dialog-keyboard.js'

async function pcServiceIsReachable(endpoint: string) {
  try {
    await fetch(`${endpoint.replace(/\/$/, '')}/api/health`, { mode: 'no-cors', credentials: 'omit', signal: AbortSignal.timeout(5000) })
    return true
  } catch { return false }
}

function connectionError(error: unknown) {
  if (error instanceof NativeSyncError) {
    if (error.code === 'authentication') return 'AnkiWeb rejected the username or password. Check them and try again.'
    if (error.code === 'service-authentication') return 'This device is no longer paired with the PC service. Reconnect it, then try again.'
    if (error.code === 'transfer' && /unavailable|interrupted/i.test(error.message)) return 'The PC relay could not reach AnkiWeb or the transfer was interrupted. Check connectivity and retry.'
    return error.message
  }
  return 'The AnkiWeb connection could not be completed.'
}

export function AnkiWebAccountDialog({ settings, onClose }: { settings: SyncSettings; onClose: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [session, setSession] = useState<NativeAnkiAccountSession>()
  const [accountPlan, setAccountPlan] = useState<PreparedNativeAccountImport>()
  const [importRepresentableOnly, setImportRepresentableOnly] = useState(false)
  const [importCommitted, setImportCommitted] = useState(false)
  const sessionRef = useRef<NativeAnkiAccountSession | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const dialogKeyboard = useDialogKeyboard(onClose, true)

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
      setMessage('Account connected. No notes, cards, or study history were uploaded.')
    } catch (error) {
      if (error instanceof TypeError) {
        const reachable = await pcServiceIsReachable(settings.endpoint)
        setMessage(reachable
          ? 'The PC service is reachable but rejected this app origin. Check its trusted application origin setting.'
          : 'The PC service could not be reached. Check the private network and make sure the PC service is running.')
      } else setMessage(connectionError(error))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  function disconnect() {
    sessionRef.current?.disconnect()
    sessionRef.current = undefined
    setSession(undefined)
    setAccountPlan(undefined)
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
