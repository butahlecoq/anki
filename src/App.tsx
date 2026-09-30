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
  const connection = online
    ? offlineStatus === 'ready' ? 'Offline shell ready' : offlineStatus === 'checking' ? 'Preparing offline shell' : 'Offline cache unavailable'
    : offlineStatus === 'ready' ? 'Offline shell active' : 'Offline shell unavailable'

  useEffect(() => {
    const show = () => setUpdateReady(true)
    window.addEventListener(UPDATE_READY_EVENT, show)
    return () => window.removeEventListener(UPDATE_READY_EVENT, show)
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
          <a className="nav-item active" href="#decks" aria-current="page"><span>Decks</span></a>
          <a className="nav-item planned" href="#study" aria-disabled="true" onClick={(event) => event.preventDefault()}>Study</a>
          <a className="nav-item planned" href="#browse" aria-disabled="true" onClick={(event) => event.preventDefault()}>Browse</a>
          <a className="nav-item planned" href="#statistics" aria-disabled="true" onClick={(event) => event.preventDefault()}>Statistics</a>
        </nav>
        <div className="sidebar-footer"><div className="local-profile"><span className="avatar">私</span><span><strong>Local profile</strong><small>Private on this device</small></span></div></div>
      </aside>
      <main className="main" id="decks">
        <header className="topbar"><div className="eyebrow"><span>COLLECTION</span><span>/</span><span>LOCAL</span></div><div className={`connection ${online ? 'online' : 'offline'}`} role="status"><span className="pulse" />{connection}</div></header>
        <CollectionWorkspace />
        <footer className="footer-line"><span>KIROKU / PRIVATE WORKSPACE</span><span>BUILD 0002</span></footer>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <a className="active" href="#decks" aria-label="Decks"><span>Decks</span></a>
        <a className="planned" href="#study" aria-label="Study (planned)" aria-disabled="true" onClick={(event) => event.preventDefault()}><span>Study</span></a>
        <a className="planned" href="#browse" aria-label="Browse (planned)" aria-disabled="true" onClick={(event) => event.preventDefault()}><span>Browse</span></a>
        <a className="planned" href="#statistics" aria-label="Statistics (planned)" aria-disabled="true" onClick={(event) => event.preventDefault()}><span>Stats</span></a>
      </nav>
      {updateReady && <div className="update-toast" role="status"><span>A new version is ready.</span><button type="button" onClick={() => window.location.reload()}>Reload</button></div>}
    </div>
  )
}
