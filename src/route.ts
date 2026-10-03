/**
 * Hash routing, in one module with one parser.
 *
 * The shell used to parse the hash itself, so a second reader of the location -
 * a keyboard shortcut, a test, a future deep link - had no shared definition
 * of what a hash means and could disagree with it. Every route the app can show
 * is listed here.
 */
import { useEffect, useState } from 'react'

export type Route =
  | { view: 'decks' }
  | { view: 'note-types' }
  | { view: 'statistics' }
  | { view: 'browse' }
  | { view: 'study' }
  | { view: 'custom-review'; sessionId: string }
  | { view: 'deck'; deckId: string }
  | { view: 'review'; deckId: string }

/** The hash that reaches a route. Every route has one. */
export function hashForRoute(route: Route): string {
  if (route.view === 'deck') return `#deck/${encodeURIComponent(route.deckId)}`
  if (route.view === 'review') return `#review/${encodeURIComponent(route.deckId)}`
  if (route.view === 'custom-review') return `#custom-review/${encodeURIComponent(route.sessionId)}`
  return `#${route.view}`
}

/**
 * The one parser. Anything unrecognised falls back to the deck list rather than
 * rendering nothing: a stale or hand-edited hash should land somewhere usable.
 */
export function routeFromHash(hash: string): Route {
  if (hash === '#note-types') return { view: 'note-types' }
  if (hash === '#statistics') return { view: 'statistics' }
  if (hash === '#study') return { view: 'study' }
  if (hash === '#browse') return { view: 'browse' }
  const custom = hash.match(/^#custom-review\/([^/]+)$/)
  if (custom) return { view: 'custom-review', sessionId: decodeURIComponent(custom[1]) }
  const match = hash.match(/^#(deck|review)\/([^/]+)$/)
  if (!match) return { view: 'decks' }
  return { view: match[1] as 'deck' | 'review', deckId: decodeURIComponent(match[2]) }
}

/**
 * The current route, following the hash, and a way to change it.
 *
 * Navigation goes through the hash so a route is always a link a learner can
 * copy, bookmark or reopen in a fresh document.
 */
export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash))
  useEffect(() => {
    const update = () => setRoute(routeFromHash(window.location.hash))
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  const navigate = (next: Route) => {
    const hash = hashForRoute(next)
    // Setting the same hash fires no event, so the route is set directly.
    if (window.location.hash === hash) setRoute(next)
    else window.location.hash = hash
  }
  return [route, navigate]
}