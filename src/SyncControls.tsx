import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { collection } from './collection'
import { formatStorageBytes, requestPersistentStorage, type PersistenceResult } from './offline-storage'
import { createAndDownloadPcBackup, listPcBackups, pairCollection, previewPcBackupRestore, restorePcBackup, syncCollection, type PcBackup, rotateCredential } from './sync-client'
import { supportsServiceWorkers } from './browser-capabilities'
import { useDialogKeyboard } from './use-dialog-keyboard'
import { AnkiWebAccountDialog } from './AnkiWebAccountDialog'
import { incomingDependencyMessage, pairOutcomeMessage, pairingClosesOn, SYNC_LOCAL_ONLY, syncOutcomeMessage } from './sync-messages'
import { readSyncProgressCounts, readSyncStatusSnapshot } from './collection-queries'
export function SyncControls({ offlineSyncAvailable, collectionActions }: { offlineSyncAvailable: boolean; collectionActions?: ReactNode }) {
  const tools = useRef<HTMLDetailsElement>(null)
  const [toolsOpen, setToolsOpen] = useState(() => window.matchMedia?.('(min-width: 681px)').matches ?? true)
  useEffect(() => {
    const desktop = window.matchMedia?.('(min-width: 681px)')
    if (!desktop) return
    const resize = () => setToolsOpen(desktop.matches)
    desktop.addEventListener('change', resize)
    return () => desktop.removeEventListener('change', resize)
  }, [])
  const settings = useLiveQuery(() => collection.syncSettings(), [], undefined)
  const offlineInventory = useLiveQuery(async () => {
    const [status, missing, pending, backup] = await Promise.all([
      readSyncStatusSnapshot(collection),
      collection.missingReferencedMedia(),
      readSyncProgressCounts(collection),
      collection.lastVerifiedPcBackup(),
    ])
    return {
      notes: status.notes,
      cards: status.cards,
      mediaFiles: status.media.length,
      mediaBytes: status.media.reduce((total, item) => total + item.byteLength, 0),
      missingMedia: missing.length,
      pending: pending.pending,
      incomingPending: pending.incomingPending,
      backup,
    }
  }, [], undefined)
  const [pairing, setPairing] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [code, setCode] = useState('')
  const [message, setMessage] = useState(SYNC_LOCAL_ONLY)
  const [busy, setBusy] = useState(false)
  const offlineShellSupported = supportsServiceWorkers()
  const pairingKeyboard = useDialogKeyboard(() => setPairing(false), pairing)
  const [backups, setBackups] = useState<PcBackup[]>([])
  const [restorePreview, setRestorePreview] = useState<{ backupId: string; summary: string; available: boolean }>()
  const [restoreConfirmation, setRestoreConfirmation] = useState('')
  const [ankiWebOpen, setAnkiWebOpen] = useState(false)
  const [persistence, setPersistence] = useState<PersistenceResult>('unsupported')
  const [storageEstimate, setStorageEstimate] = useState<{ usage?: number; quota?: number }>()

  useEffect(() => {
    let active = true
    void requestPersistentStorage().then((result) => { if (active) setPersistence(result) })
    void navigator.storage?.estimate().then((estimate) => {
      if (active) setStorageEstimate({ usage: estimate.usage, quota: estimate.quota })
    }).catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!settings) return
    let active = true
    void listPcBackups(settings).then(({ backups: latest }) => { if (active) setBackups(latest) }).catch(() => { if (active) setBackups([]) })
    return () => { active = false }
  }, [settings])

  async function pair(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const result = await pairCollection(collection, endpoint, code)
      setMessage(pairOutcomeMessage(result.state))
      // Only a successful pairing closes the form; a rejection keeps the code the
      // learner just typed, which is the one thing that could still work.
      if (pairingClosesOn(result.state)) {
        setPairing(false)
        setCode('')
      }
    } catch (error) {
      setMessage(error instanceof Error ? `Pairing failed. ${error.message}` : 'Pairing failed. Check the PC address and pairing code, then retry.')
    } finally {
      setBusy(false)
    }
  }

  async function sync() {
    if (!offlineSyncAvailable || !offlineShellSupported) {
      setMessage('Sync is paused until Kiroku confirms its offline app shell is ready. Keep this page open and retry once it is ready.')
      return
    }
    // With no pairing yet, "Sync now" means "connect a PC".
    if (!settings) {
      setPairing(true)
      return
    }
    setBusy(true)
    setMessage('Syncing your collection…')
    try {
      const result = await syncCollection(collection, fetch.bind(window), (progress) => {
        switch (progress.phase) {
          case 'records': setMessage(`Syncing records · ${progress.completed} accepted · ${progress.pending} local changes remain · cursor ${progress.cursor}.${progress.pendingIncomingOperations ? ` ${progress.pendingIncomingOperations} received changes waiting for related records.` : ''}${progress.remoteChangesPending ? ' More PC records are queued.' : ''}`); break
          case 'upload': setMessage(`Uploading media · ${progress.completed} sent · ${progress.pending} waiting.`); break
          case 'download': setMessage(`Downloading media · ${progress.completed} saved · ${progress.pending} waiting.`); break
          case 'retry': {
            const task = progress.task === 'records' ? 'collection changes' : 'media files'
            setMessage(`Sync saved progress. ${progress.pending} ${task} remain for the next retry.`)
            break
          }
          case 'complete': setMessage(syncOutcomeMessage({ state: 'complete', accepted: progress.accepted, media: progress.media, conflicts: progress.conflicts })); break
        }
      })
      if (result.state === 'complete') {
        if (settings) void listPcBackups(settings).then(({ backups: latest }) => setBackups(latest)).catch(() => {})
        const { conflicts } = await readSyncProgressCounts(collection)
        setMessage(syncOutcomeMessage({ ...result, conflicts }))
      } else setMessage(syncOutcomeMessage(result))
    } catch (error) {
      setMessage(error instanceof Error ? `Sync stopped safely. ${error.message} Your local changes remain on this device; reconnect and retry.` : 'Sync stopped safely. Your local changes remain on this device; reconnect and retry.')
    } finally { setBusy(false) }
  }

  async function backupPcCollection() {
    if (!settings) return
    setBusy(true)
    try {
      const { manifest, bytes } = await createAndDownloadPcBackup(settings)
      const mediaBytes = manifest.media.reduce((total, item) => total + item.byteLength, 0)
      await collection.recordVerifiedPcBackup({
        backupId: manifest.id,
        createdAt: manifest.createdAt,
        verifiedAt: new Date().toISOString(),
        reason: manifest.reason,
        changeCount: manifest.changeCount,
        mediaFiles: manifest.media.length,
        mediaBytes,
        archiveBytes: manifest.archiveBytes,
        archiveSha256: manifest.archiveSha256,
      })
      const url = URL.createObjectURL(bytes)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `kiroku-backup-${manifest.createdAt.slice(0, 10)}.zip`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setBackups((current) => [manifest, ...current.filter((backup) => backup.id !== manifest.id)])
      setMessage(`Verified backup downloaded · ${manifest.changeCount} sync changes · ${manifest.media.length} media files (${(mediaBytes / 1024 / 1024).toFixed(1)} MiB) · ${new Date(manifest.createdAt).toLocaleString()}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'PC backup failed. The active collection was left unchanged.')
    } finally { setBusy(false) }
  }

  async function previewPcRestore(backup: PcBackup) {
    if (!settings) return
    setBusy(true)
    try {
      const preview = await previewPcBackupRestore(settings, backup.id)
      const mediaMiB = (preview.mediaBytes / 1024 / 1024).toFixed(1)
      setRestorePreview({ backupId: backup.id, summary: `${new Date(preview.manifest.createdAt).toLocaleString()} · ${preview.changeCount} sync changes through cursor ${preview.latestCursor} · ${preview.manifest.media.length} verified media files (${mediaMiB} MiB). ${preview.restoreBlocker}`, available: preview.restoreAvailable })
      setRestoreConfirmation('')
    } catch (error) { setRestorePreview({ backupId: backup.id, summary: error instanceof Error ? error.message : 'Restore preview could not be verified.', available: false }) }
    finally { setBusy(false) }
  }

  async function restorePcCollection() {
    if (!settings || !restorePreview?.available || restoreConfirmation !== 'RESTORE') return
    setBusy(true)
    try {
      const result = await restorePcBackup(settings, restorePreview.backupId)
      setBackups((current) => [result.before, ...current.filter((backup) => backup.id !== result.before.id)])
      setRestorePreview(undefined)
      setRestoreConfirmation('')
      setMessage(`PC collection restored from verified backup. Recovery backup ${result.before.id} was kept. The PC now has a new sync generation; this device’s local collection and queued changes were not changed and must be explicitly recovered or reset before syncing.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The PC collection was not replaced. Its current state was left unchanged.')
    } finally { setBusy(false) }
  }

  async function rotateDeviceCredential() {
    if (!settings) return
    setBusy(true)
    const result = await rotateCredential(settings)
    if (result.state === 'rotated') {
      try {
        await collection.configureSync({ ...settings, token: result.token })
        setMessage('Device key rotated. The previous key can no longer sync this collection.')
      } catch {
        setMessage('The PC rotated this device key, but it could not be saved here. Pair this device again to reconnect.')
      }
    } else if (result.state === 'authentication-required') {
      setMessage('This device key has expired or was already rotated. Pair this device again to reconnect.')
    } else if (result.state === 'indeterminate') {
      setMessage('The PC may have rotated this device key, but confirmation was lost. Create a new pairing code on the PC and pair this device again before syncing.')
    } else {
      setMessage('This PC address is not safe for key rotation. Check its HTTPS address; no request was sent.')
    }
    setBusy(false)
  }

  return (
    <section className="sync-controls" aria-label="PC sync">
      <div><span className="section-code">SYNC // {settings ? 'PAIRED' : 'LOCAL ONLY'}</span><p className={message === SYNC_LOCAL_ONLY && !offlineInventory?.incomingPending && (!settings || offlineSyncAvailable) ? 'sync-idle-message' : undefined} aria-live="polite">{settings && !offlineSyncAvailable ? 'Sync is paused until Kiroku confirms its offline app shell is ready.' : message === SYNC_LOCAL_ONLY && offlineInventory?.incomingPending ? incomingDependencyMessage(offlineInventory.incomingPending) : message}</p></div>
      <details ref={tools} className="collection-tools" open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)} onKeyDown={event => {
        if (event.key === 'Escape' && window.matchMedia?.('(max-width: 680px)').matches) {
          event.preventDefault()
          event.stopPropagation()
          setToolsOpen(false)
          tools.current?.querySelector('summary')?.focus()
        }
      }}>
      <summary>Collection tools</summary>
      <div className="collection-tools-body">
      <details className="offline-storage-status">
        <summary data-testid="offline-storage-summary">Offline storage and local collection</summary>
        <p>{persistence === 'granted' ? 'Persistent storage is enabled for this app.' : persistence === 'denied' ? 'The browser may clear this app’s local data to free space. Keep a verified backup.' : 'This browser cannot protect local storage from automatic cleanup.'}</p>
        {storageEstimate && <p>Browser storage estimate: {storageEstimate.usage === undefined ? 'unknown' : formatStorageBytes(storageEstimate.usage)} used of {storageEstimate.quota === undefined ? 'unknown' : formatStorageBytes(storageEstimate.quota)} available.</p>}
        {offlineInventory && <p>{offlineInventory.notes} notes · {offlineInventory.cards} cards · {offlineInventory.mediaFiles} media files ({formatStorageBytes(offlineInventory.mediaBytes)}) · {offlineInventory.missingMedia} media files missing · {offlineInventory.pending} changes waiting to sync.</p>}
        {offlineInventory?.missingMedia ? <p role="alert">Some referenced media is not stored on this device. Connect to the PC and sync before relying on offline access.</p> : offlineInventory && <p>All referenced media is available on this device.</p>}
        <p className="sync-help" data-testid="backup-receipt">{offlineInventory?.backup ? `Last PC backup received and verified on this device: ${new Date(offlineInventory.backup.verifiedAt).toLocaleString()} · ${offlineInventory.backup.changeCount} sync changes · ${offlineInventory.backup.mediaFiles} media files (${formatStorageBytes(offlineInventory.backup.mediaBytes)}).` : 'No PC backup has been received and verified on this device yet.'}</p>
      </details>
      <div className="sync-actions">
        {settings && <button className="text-button" type="button" disabled={busy} onClick={() => setAnkiWebOpen(true)}>Connect AnkiWeb account</button>}
        {settings && <button className="text-button" type="button" disabled={busy || !offlineSyncAvailable || !offlineShellSupported} onClick={() => void sync()}>{busy ? 'Syncing…' : 'Sync now'}</button>}
        {settings && <button className="text-button" type="button" disabled={busy} onClick={() => void backupPcCollection()}>{busy ? 'Working…' : 'Download PC backup'}</button>}
        {settings && <button className="text-button" type="button" disabled={busy} title="Invalidates this device’s previous key immediately" onClick={() => void rotateDeviceCredential()}>{busy ? 'Working…' : 'Rotate device key'}</button>}
        <button className="primary-action" type="button" disabled={busy} onClick={() => setPairing(true)}>{settings ? 'Pair another device' : 'Connect a PC'}</button>
      </div>
      {settings && backups[0] && <p className="sync-help">Latest backup currently listed by the PC: {new Date(backups[0].createdAt).toLocaleString()} · {backups[0].changeCount} sync changes · {backups[0].media.length} media files · {backups[0].reason === 'manual' ? 'manual' : 'before sync'}.</p>}
      {settings && backups[0] && <div className="sync-help"><button className="text-button" type="button" disabled={busy} onClick={() => void previewPcRestore(backups[0])}>Preview latest backup</button>{restorePreview && <><p role="status">{restorePreview.summary}</p>{restorePreview.available && <><label>Type RESTORE to replace the active PC collection<input value={restoreConfirmation} onChange={(event) => setRestoreConfirmation(event.target.value)} autoComplete="off" /></label><button className="text-button" type="button" disabled={busy || restoreConfirmation !== 'RESTORE'} onClick={() => void restorePcCollection()}>Restore this PC collection</button></>}</>}</div>}
      {collectionActions && <div className="collection-export-actions">{collectionActions}</div>}
      </div>
      </details>
      {ankiWebOpen && settings && <AnkiWebAccountDialog settings={settings} onClose={() => setAnkiWebOpen(false)} />}
      {pairing && (
        <div className="dialog-backdrop">
          <section {...pairingKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title">
            <span className="section-code">SYNC // PAIR DEVICE</span>
            <h2 id="sync-dialog-title">Connect to your PC</h2>
            <form onSubmit={pair}>
              <label>
                PC service address
                <input inputMode="url" placeholder="https://pc.example.net:4174" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required />
              </label>
              <label>
                One-time pairing code
                <input autoCapitalize="characters" value={code} onChange={(event) => setCode(event.target.value)} required />
              </label>
              <p className="sync-help">On the PC, run <code>npm run server:pair</code> to create a one-time code.</p>
              <div className="dialog-actions">
                <button className="text-button" type="button" disabled={busy} onClick={() => setPairing(false)}>Cancel</button>
                <button className="primary-action" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect device'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  )
}
