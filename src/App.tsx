import { useEffect, useState } from 'react'
import { clearUpdateWaiting, isUpdateWaiting, OFFLINE_READY_EVENT, OFFLINE_UNAVAILABLE_EVENT, UPDATE_READY_EVENT } from './appEvents'
import { chooseAppearance, readAppearance, watchAppearance, type Appearance } from './appearance'
import { CollectionWorkspace } from './CollectionWorkspace'
import { supportsServiceWorkers } from './browser-capabilities'
import { useRoute } from './route'
import { buildIdentity } from './build-identity'
import { activateAvailableUpdate } from './service-worker-update'

function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

function useOfflineShellStatus() {
  const [status, setStatus] = useState<'checking' | 'ready' | 'unavailable' | 'unsupported'>(() => supportsServiceWorkers() ? 'checking' : 'unsupported')
  useEffect(() => {
    if (!supportsServiceWorkers()) return
    const ready = () => setStatus('ready')
    const unavailable = () => setStatus('unavailable')
    window.addEventListener(OFFLINE_READY_EVENT, ready)
    window.addEventListener(OFFLINE_UNAVAILABLE_EVENT, unavailable)
    navigator.serviceWorker.ready.then(ready).catch(unavailable)
    return () => {
      window.removeEventListener(OFFLINE_READY_EVENT, ready)
      window.removeEventListener(OFFLINE_UNAVAILABLE_EVENT, unavailable)
    }
  }, [])
  return status
}

function useAppearance() {
  const [preference, setPreference] = useState<Appearance>(() => readAppearance())
  useEffect(() => watchAppearance(() => setPreference(readAppearance())), [])
  const select = (next: Appearance) => {
    chooseAppearance(next)
    setPreference(next)
  }
  return { preference, select }
}

export function App() {
  const online = useOnlineStatus()
  const appearance = useAppearance()
  const offlineStatus = useOfflineShellStatus()
  const [updateReady, setUpdateReady] = useState(isUpdateWaiting)
  const [updateError, setUpdateError] = useState('')
  const [activatingUpdate, setActivatingUpdate] = useState(false)
  const [route] = useRoute()
  const onStatistics = route.view === 'statistics'
  const onNoteTypes = route.view === 'note-types'
  const onBrowse = route.view === 'browse'
  const onStudy = route.view === 'study' || route.view === 'activity-selection' || route.view === 'review' || route.view === 'custom-review'
  const reviewing = route.view === 'review' || route.view === 'custom-review'

  async function activateUpdate() {
    setActivatingUpdate(true)
    setUpdateError('')
    try {
      const activated = await activateAvailableUpdate()
      if (!activated) {
        setUpdateError('This update is no longer waiting. Reload to check for the current version.')
        setActivatingUpdate(false)
      }
      clearUpdateWaiting()
    } catch {
      setUpdateError('The update could not be activated. Your saved collection remains on this device; try reloading when you are online.')
      setActivatingUpdate(false)
    }
  }
  const connection = online
    ? offlineStatus === 'ready' ? 'Offline shell ready' : offlineStatus === 'checking' ? 'Preparing offline shell' : 'Offline cache unavailable'
    : offlineStatus === 'ready' ? 'Offline shell active' : 'Offline shell unavailable'

  useEffect(() => {
    const show = () => setUpdateReady(true)
    window.addEventListener(UPDATE_READY_EVENT, show)
    return () => window.removeEventListener(UPDATE_READY_EVENT, show)
  }, [])

  return (
    <div className={`app-shell${reviewing ? ' is-reviewing' : ''}`}>
      {/* The sidebar precedes main content in the DOM, so a keyboard user would
          otherwise tab past the brand and five destinations on every view. */}
      <a className="skip-link" href="#decks">Skip to main content</a>
      <aside className="sidebar">
        <a className="brand" href="#decks" aria-label="Kiroku home">
          <span className="brand-mark" lang="ja">記</span>
          <span className="brand-copy"><strong>KIROKU</strong><small>日本語 // STUDY</small></span>
        </a>
        <nav className="primary-nav" aria-label="Primary navigation">
          <span className="nav-label">Workspace</span>
          <a className={`nav-item${onNoteTypes || onBrowse || onStatistics || onStudy ? '' : ' active'}`} href="#decks" aria-current={onNoteTypes || onBrowse || onStatistics || onStudy ? undefined : 'page'}><span>Decks</span></a>
          <a className={`nav-item${onNoteTypes ? ' active' : ''}`} href="#note-types" aria-current={onNoteTypes ? 'page' : undefined}><span>Note types</span></a>
          <a className={`nav-item${onStudy ? ' active' : ''}`} href="#study" aria-current={onStudy ? 'page' : undefined}>Study</a>
          <a className={`nav-item${onBrowse ? ' active' : ''}`} href="#browse" aria-current={onBrowse ? 'page' : undefined}>Browse</a>
          <a className={`nav-item${onStatistics ? ' active' : ''}`} href="#statistics" aria-current={onStatistics ? 'page' : undefined}>Statistics</a>
        </nav>
        <div className="sidebar-footer"><div className="local-profile"><span className="avatar">私</span><span><strong>Local profile</strong><small>Private on this device</small></span></div></div>
      </aside>
      <main className="main" id="decks" tabIndex={-1}>
        <header className="topbar">
          <div className="eyebrow"><span>COLLECTION</span><span>/</span><span>LOCAL</span></div>
          <div className="topbar-controls">
            <div className={`connection ${online ? 'online' : 'offline'}`} role="status"><span className="pulse" />{connection}</div>
            <details className="build-identity"><summary>Support</summary><dl><dt>Version</dt><dd>{buildIdentity.version}</dd><dt>Commit</dt><dd>{buildIdentity.commit}</dd><dt>Channel</dt><dd>{buildIdentity.release ? 'Release build' : 'Development build (not a release)'}</dd></dl>{buildIdentity.release && <a href="notices/index.html">Dependency notices</a>}</details>
            <label className="appearance-control">
              <span className="visually-hidden">Appearance</span>
              <select value={appearance.preference} onChange={(event) => appearance.select(event.target.value as Appearance)}>
                <option value="system">Auto</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </header>
        {(offlineStatus === 'unavailable' || offlineStatus === 'unsupported') && <aside className="system-note offline-capability-warning" role="alert" data-testid="offline-shell-warning">
          <span>OFFLINE MODE UNAVAILABLE</span>
          <p>{offlineStatus === 'unsupported'
            ? 'Offline review after closing or restarting needs the installed Home Screen app and a browser configuration with service-worker support. This browser does not expose that feature. iOS Lockdown Mode can disable it; Kiroku cannot detect that setting directly. Sync is paused here so you can finish your study session safely. Local review remains available while this page stays open.'
            : 'Kiroku could not prepare its offline app shell. Check the app installation and connection before relying on a cold offline launch. Sync is paused here so you can finish your study session safely. Local review remains available while this page stays open.'}</p>
        </aside>}
        <CollectionWorkspace offlineSyncAvailable={offlineStatus === 'ready'} />
        <footer className="footer-line"><span>KIROKU / PRIVATE WORKSPACE</span><span>BUILD {buildIdentity.commit}</span></footer>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <a className={onNoteTypes || onBrowse || onStatistics || onStudy ? '' : 'active'} href="#decks" aria-label="Decks"><span>Decks</span></a>
        <a className={onNoteTypes ? 'active' : ''} href="#note-types" aria-label="Note types"><span>Note types</span></a>
        <a className={onStudy ? 'active' : ''} href="#study" aria-label="Study"><span>Study</span></a>
        <a className={onBrowse ? 'active' : ''} href="#browse" aria-label="Browse"><span>Browse</span></a>
        <a className={onStatistics ? 'active' : ''} href="#statistics" aria-label="Statistics"><span>Stats</span></a>
      </nav>
      {updateReady && <div className="update-toast" role="status"><span>{updateError || (activatingUpdate ? 'Updating the app…' : 'A new version is ready.')}</span>{!activatingUpdate && <button type="button" onClick={() => updateError ? window.location.reload() : void activateUpdate()}>{updateError ? 'Reload to check' : 'Update app'}</button>}</div>}
    </div>
  )
}
