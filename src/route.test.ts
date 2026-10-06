import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hashForRoute, routeFromHash, type Route } from './route'

/**
 * The shell must not parse the hash a second time. These cases are the routing
 * contract: anything that reaches a screen by deep link, bookmark or a stale
 * history entry lands through this parser.
 */

const cases: Array<[string, Route]> = [
  ['#', { view: 'decks' }],
  ['', { view: 'decks' }],
  ['#note-types', { view: 'note-types' }],
  ['#statistics', { view: 'statistics' }],
  ['#study', { view: 'study' }],
  ['#activity/deck/abc', { view: 'activity-selection', target: { kind: 'deck', deckId: 'abc' } }],
  ['#activity/session/session-1', { view: 'activity-selection', target: { kind: 'session', sessionId: 'session-1' } }],
  ['#browse', { view: 'browse' }],
  ['#deck/abc', { view: 'deck', deckId: 'abc' }],
  ['#review/abc', { view: 'review', deckId: 'abc' }],
  ['#review/abc/review', { view: 'review', deckId: 'abc', activityId: 'review' }],
  ['#custom-review/session-1', { view: 'custom-review', sessionId: 'session-1' }],
  ['#custom-review/session-1/review', { view: 'custom-review', sessionId: 'session-1', activityId: 'review' }],
]

describe('the hash parser', () => {
  test('App delegates hash changes to the route module', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')
    expect(app).toContain('useRoute')
    expect(app).not.toMatch(/location\.hash|hashchange/)
  })
  test('each route the app can show is reachable from its hash', () => {
    for (const [hash, route] of cases) expect(`${hash} -> ${JSON.stringify(routeFromHash(hash))}`).toBe(`${hash} -> ${JSON.stringify(route)}`)
  })

  test('an unrecognised hash lands somewhere usable rather than nowhere', () => {
    for (const hash of ['#nonsense', '#deck', '#deck/', '#review/a/b/c', '#custom-review/', '#activity/unknown/a', '#DECK/abc', 'deck/abc']) {
      expect(`${hash} -> ${JSON.stringify(routeFromHash(hash))}`).toBe(`${hash} -> ${JSON.stringify({ view: 'decks' })}`)
    }
  })

  test('an identifier needing escaping survives the round trip', () => {
    const awkward = '日本語::Nested deck/with slash'
    const hash = hashForRoute({ view: 'deck', deckId: awkward })
    expect(hash).not.toContain('/deck//')
    expect(routeFromHash(hash)).toEqual({ view: 'deck', deckId: awkward })
    const session = hashForRoute({ view: 'custom-review', sessionId: 'a b&c' })
    expect(routeFromHash(session)).toEqual({ view: 'custom-review', sessionId: 'a b&c' })
    const selectedActivity = hashForRoute({ view: 'review', deckId: awkward, activityId: 'review/activity' })
    expect(routeFromHash(selectedActivity)).toEqual({ view: 'review', deckId: awkward, activityId: 'review/activity' })
    const customSelection = hashForRoute({ view: 'activity-selection', target: { kind: 'session', sessionId: 'a b&c' } })
    expect(routeFromHash(customSelection)).toEqual({ view: 'activity-selection', target: { kind: 'session', sessionId: 'a b&c' } })
  })

  test('every route has a hash that parses back to it', () => {
    const routes: Route[] = [
      { view: 'decks' }, { view: 'note-types' }, { view: 'statistics' },
      { view: 'browse' }, { view: 'study' },
      { view: 'activity-selection', target: { kind: 'deck', deckId: 'd' } },
      { view: 'activity-selection', target: { kind: 'session', sessionId: 's' } },
      { view: 'deck', deckId: 'd' }, { view: 'review', deckId: 'd' },
      { view: 'custom-review', sessionId: 's' },
      { view: 'custom-review', sessionId: 's', activityId: 'review' },
    ]
    for (const route of routes) {
      const hash = hashForRoute(route)
      // The deck list is the fallback, so its own hash must not be an empty one.
      if (route.view !== 'decks') expect(`${JSON.stringify(route)} -> ${hash} -> ${JSON.stringify(routeFromHash(hash))}`).toBe(`${JSON.stringify(route)} -> ${hash} -> ${JSON.stringify(route)}`)
    }
  })

  test('deck and review are distinct routes for the same deck', () => {
    expect(routeFromHash('#deck/d')).toEqual({ view: 'deck', deckId: 'd' })
    expect(routeFromHash('#review/d')).toEqual({ view: 'review', deckId: 'd' })
    expect(hashForRoute({ view: 'deck', deckId: 'd' })).not.toBe(hashForRoute({ view: 'review', deckId: 'd' }))
  })

  test('a percent-encoded identifier is decoded exactly once', () => {
    expect(routeFromHash('#deck/a%2Fb')).toEqual({ view: 'deck', deckId: 'a/b' })
    expect(routeFromHash('#deck/a%252Fb')).toEqual({ view: 'deck', deckId: 'a%2Fb' })
  })
})
