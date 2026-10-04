import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { SyncSettings } from './collection.js'
import { NativeSyncError } from './native-anki-sync.js'
import { connectNativeAnkiAccount, type NativeAnkiAccountSession } from './native-anki-account-session.js'
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
    setUsername('')
    setPassword('')
    setMessage('Disconnected. The downloaded account collection remains on this device.')
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
            <p>Closing this dialog ends the in-memory session. Your downloaded collection remains available for offline study.</p>
            <div className="dialog-actions">
              <button className="text-button" type="button" onClick={disconnect}>Disconnect</button>
              <button className="primary-action" type="button" onClick={onClose}>Done</button>
            </div>
          </section>
        )}
      </section>
    </div>
  )
}
