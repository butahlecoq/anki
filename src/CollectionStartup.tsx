import { useEffect, useState, type ReactNode } from 'react'
import { collection } from './collection'
import { requestPersistentStorage } from './offline-storage'
import { snapshotBeforeCollectionUpgrade } from './upgrade-recovery'

type StartupState = { status: 'opening' } | { status: 'ready' } | { status: 'failed'; reason: string; blocked?: boolean }
const openCollectionByDefault = async () => {
  await requestPersistentStorage()
  await snapshotBeforeCollectionUpgrade(collection.name, collection.verno)
  return collection.open()
}

export function CollectionStartup({
  children,
  openCollection = openCollectionByDefault,
}: {
  children: ReactNode
  openCollection?: () => Promise<unknown>
}) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<StartupState>({ status: 'opening' })

  useEffect(() => {
    let active = true
    const onBlocked = () => {
      if (active) setState({ status: 'failed', reason: 'Another Kiroku tab is using the collection database.', blocked: true })
    }
    if (openCollection === openCollectionByDefault) collection.on('blocked', onBlocked)
    void openCollection().then(
      () => { if (active) setState({ status: 'ready' }) },
      (error: unknown) => {
        if (active) setState({ status: 'failed', reason: error instanceof Error ? error.message : 'Unknown local database error.' })
      },
    )
    return () => {
      active = false
      if (openCollection === openCollectionByDefault) collection.on('blocked').unsubscribe(onBlocked)
    }
  }, [attempt, openCollection])

  if (state.status === 'opening') return <main className="startup-state" role="status">Opening your local collection…</main>
  if (state.status === 'failed') return <main className="startup-state startup-failure" role="alert">
    <span className="section-code">LOCAL COLLECTION // UPDATE INCOMPLETE</span>
    <h1>Your collection could not be opened</h1>
    <p>Kiroku stopped before opening the workspace, so it cannot mistake a failed database upgrade for an empty collection.</p>
    {state.blocked
      ? <p>Close the other Kiroku tabs using this collection, then try again. Keep this browser profile and its site data intact.</p>
      : <p>Keep this browser profile and its site data intact. Free device storage, then try again. If the problem continues, use the previous app version to export your collection before taking further action.</p>}
    <details><summary>Technical details</summary><p>{state.reason}</p></details>
    <button className="primary-action" type="button" onClick={() => { setState({ status: 'opening' }); setAttempt((current) => current + 1) }}>Try opening the collection again</button>
  </main>
  return children
}
