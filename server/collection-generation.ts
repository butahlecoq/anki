import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const GENERATION_KEY = 'collection_generation'
const FENCE_KEY = 'collection_generation_required'

export function collectionGeneration(database: DatabaseSync) {
  const row = database.prepare('SELECT value FROM collection_metadata WHERE key = ?').get(GENERATION_KEY) as { value: string } | undefined
  if (row && /^[a-f0-9-]{36}$/.test(row.value)) return row.value
  const generation = randomUUID()
  database.prepare('INSERT INTO collection_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(GENERATION_KEY, generation)
  return generation
}

export function startCollectionGeneration(database: DatabaseSync) {
  const generation = randomUUID()
  database.prepare('INSERT INTO collection_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(GENERATION_KEY, generation)
  database.prepare('INSERT INTO collection_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(FENCE_KEY, 'true')
  return generation
}

export function requiresCollectionGeneration(database: DatabaseSync) {
  const row = database.prepare('SELECT value FROM collection_metadata WHERE key = ?').get(FENCE_KEY) as { value: string } | undefined
  return row?.value === 'true'
}
