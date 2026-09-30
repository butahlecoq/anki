import { useEffect, useState } from 'react'
import { UPDATE_READY_EVENT } from './appEvents'

type IconName = 'decks' | 'study' | 'browse' | 'stats' | 'settings' | 'arrow' | 'spark'

const navItems: Array<{ label: string; icon: IconName; href: string; available: boolean }> = [
  { label: 'Decks', icon: 'decks', href: '#decks', available: true },
  { label: 'Study', icon: 'study', href: '#study', available: false },
  { label: 'Browse', icon: 'browse', href: '#browse', available: false },
  { label: 'Statistics', icon: 'stats', href: '#statistics', available: false },
]

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    decks: <><path d="m5 7 7-3 7 3-7 3-7-3Z"/><path d="m5 12 7 3 7-3M5 17l7 3 7-3"/></>,
    study: <><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M8 20a3 3 0 0 1 0-6h11"/></>,
    browse: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
    stats: <><path d="M5 20V10M12 20V4M19 20v-7"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.13.36.34.7.6 1 .3.3.68.43 1.1.4h.09v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
    spark: <><path d="m12 3 1.25 4.75L18 9l-4.75 1.25L12 15l-1.25-4.75L6 9l4.75-1.25L12 3ZM5 16l.65 2.35L8 19l-2.35.65L5 22l-.65-2.35L2 19l2.35-.65L5 16Z"/></>,
  }

  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  )
}

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

export function App() {
  const online = useOnlineStatus()
  const [updateReady, setUpdateReady] = useState(false)

  useEffect(() => {
    const showUpdate = () => setUpdateReady(true)
    window.addEventListener(UPDATE_READY_EVENT, showUpdate)
    return () => window.removeEventListener(UPDATE_READY_EVENT, showUpdate)
  }, [])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#decks" aria-label="Kiroku home">
          <span className="brand-mark" lang="ja">記</span>
          <span className="brand-copy">
            <strong>KIROKU</strong>
            <small>日本語 // STUDY</small>
          </span>
        </a>

        <nav className="primary-nav" aria-label="Primary navigation">
          <span className="nav-label">Workspace</span>
          {navItems.map((item, index) => (
            <a
              className={index === 0 ? 'nav-item active' : 'nav-item planned'}
              href={item.href}
              key={item.label}
              aria-current={index === 0 ? 'page' : undefined}
              aria-disabled={!item.available}
              onClick={(event) => { if (!item.available) event.preventDefault() }}
              title={item.available ? undefined : 'Planned feature'}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {index === 0 ? <span className="nav-count" aria-hidden="true">0</span> : <span className="nav-state" aria-hidden="true">SOON</span>}
            </a>
          ))}
        </nav>

        <div className="sidebar-footer">
          <a className="nav-item planned" href="#settings" aria-disabled="true" onClick={(event) => event.preventDefault()} title="Planned feature">
            <Icon name="settings" />
            <span>Settings</span>
            <span className="nav-state" aria-hidden="true">SOON</span>
          </a>
          <div className="local-profile">
            <span className="avatar">私</span>
            <span><strong>Local profile</strong><small>Private on this device</small></span>
          </div>
        </div>
      </aside>

      <main className="main" id="decks">
        <header className="topbar">
          <div className="eyebrow"><span>COLLECTION</span><span>/</span><span>LOCAL</span></div>
          <div className={`connection ${online ? 'online' : 'offline'}`} role="status">
            <span className="pulse" />
            {online ? 'App shell cached for offline' : 'Offline shell active'}
          </div>
        </header>

        <section className="hero">
          <div className="hero-copy">
            <div className="section-code">01 // HOME</div>
            <h1>Your Japanese <br /><em>study system</em></h1>
            <p>A calm, local-first workspace for deliberate practice. Your collection will live on your devices—not behind a subscription.</p>
          </div>
          <div className="kana-field" aria-hidden="true">
            <span>あ</span><span>記</span><span>学</span>
            <div className="orbit one" /><div className="orbit two" />
          </div>
        </section>

        <section className="workspace-grid">
          <article className="empty-panel">
            <div className="panel-heading">
              <div>
                <span className="section-code">DECKS // 00</span>
                <h2>Start with one deck</h2>
              </div>
              <span className="keycap">N</span>
            </div>
            <div className="empty-card">
              <span className="empty-glyph" lang="ja">一</span>
              <div>
                <h3>Your collection is clear.</h3>
                <p>Card creation arrives in the next slice. The offline workspace is ready now.</p>
              </div>
              <button className="primary-action" type="button" disabled aria-describedby="next-slice-note">
                New deck <Icon name="arrow" />
              </button>
              <small id="next-slice-note">Available when the first-card workflow lands</small>
            </div>
          </article>

          <aside className="system-panel">
            <div className="panel-heading compact">
              <div>
                <span className="section-code">SYSTEM // STATUS</span>
                <h2>Workspace</h2>
              </div>
              <Icon name="spark" />
            </div>
            <dl className="status-list">
              <div><dt>App shell</dt><dd><span className="status-dot ok" />Cached</dd></div>
              <div><dt>Collection</dt><dd><span className="status-dot idle" />Empty</dd></div>
              <div><dt>Sync peer</dt><dd><span className="status-dot idle" />Not configured</dd></div>
              <div><dt>Connection</dt><dd><span className={`status-dot ${online ? 'ok' : 'warn'}`} />{online ? 'Online' : 'Offline'}</dd></div>
            </dl>
            <div className="system-note">
              <span>LOCAL-FIRST</span>
              <p>Once downloaded, study sessions will not depend on this PC or the internet.</p>
            </div>
          </aside>
        </section>

        <footer className="footer-line">
          <span>KIROKU / PRIVATE WORKSPACE</span>
          <span>BUILD 0001</span>
        </footer>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map((item, index) => (
          <a
            className={index === 0 ? 'active' : 'planned'}
            href={item.href}
            key={item.label}
            aria-label={`${item.label}${item.available ? '' : ' (planned)'}`}
            aria-disabled={!item.available}
            onClick={(event) => { if (!item.available) event.preventDefault() }}
          >
            <Icon name={item.icon} /><span>{item.label === 'Statistics' ? 'Stats' : item.label}</span>
          </a>
        ))}
      </nav>

      {updateReady && (
        <div className="update-toast" role="status">
          <span>A new version is ready.</span>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
    </div>
  )
}
