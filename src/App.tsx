import { useEffect, useState } from 'react'
import { OFFLINE_READY_EVENT, OFFLINE_UNAVAILABLE_EVENT, UPDATE_READY_EVENT } from './appEvents'
import { CollectionWorkspace } from './CollectionWorkspace'

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
  const [status, setStatus] = useState<'checking' | 'ready' | 'unavailable'>(() => 'serviceWorker' in navigator ? 'checking' : 'unavailable')
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
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

export function App() {
  const online = useOnlineStatus()
  const offlineStatus = useOfflineShellStatus()
  const [updateReady, setUpdateReady] = useState(false)
  const [hash, setHash] = useState(() => window.location.hash)
  const onStatistics = hash === '#statistics'
  const onNoteTypes = hash === '#note-types'
  const onBrowse = hash === '#browse'
  const onStudy = hash === '#study' || hash.startsWith('#custom-review/')
  const connection = online
    ? offlineStatus === 'ready' ? 'Offline shell ready' : offlineStatus === 'checking' ? 'Preparing offline shell' : 'Offline cache unavailable'
    : offlineStatus === 'ready' ? 'Offline shell active' : 'Offline shell unavailable'

  useEffect(() => {
    const show = () => setUpdateReady(true)
    window.addEventListener(UPDATE_READY_EVENT, show)
    return () => window.removeEventListener(UPDATE_READY_EVENT, show)
  }, [])

  useEffect(() => {
    const update = () => setHash(window.location.hash)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  return (
    <div className="app-shell">
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
      <main className="main" id="decks">
        <header className="topbar"><div className="eyebrow"><span>COLLECTION</span><span>/</span><span>LOCAL</span></div><div className={`connection ${online ? 'online' : 'offline'}`} role="status"><span className="pulse" />{connection}</div></header>
        <CollectionWorkspace />
        <footer className="footer-line"><span>KIROKU / PRIVATE WORKSPACE</span><span>BUILD 0002</span></footer>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <a className={onNoteTypes || onBrowse || onStatistics || onStudy ? '' : 'active'} href="#decks" aria-label="Decks"><span>Decks</span></a>
        <a className={onNoteTypes ? 'active' : ''} href="#note-types" aria-label="Note types"><span>Note types</span></a>
        <a className={onStudy ? 'active' : ''} href="#study" aria-label="Study"><span>Study</span></a>
        <a className={onBrowse ? 'active' : ''} href="#browse" aria-label="Browse"><span>Browse</span></a>
        <a className={onStatistics ? 'active' : ''} href="#statistics" aria-label="Statistics"><span>Stats</span></a>
      </nav>
      {updateReady && <div className="update-toast" role="status"><span>A new version is ready.</span><button type="button" onClick={() => window.location.reload()}>Reload</button></div>}
    </div>
  )
}
