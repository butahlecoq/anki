/** Causal revisions preserve concurrent versions independently of delivery order. */
export interface Revision {
  opId: string
  parents?: string[]
  action: 'create' | 'update' | 'delete'
  payload: unknown
}

export interface RevisionMerge {
  heads: string[]
  value: unknown
  deleted: boolean
  conflicts: string[]
  versions: { opId: string; value: unknown }[]
}

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equal(value, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => key in b && equal(a[key], b[key]))
}

function ancestors(revision: Revision, revisions: Map<string, Revision>, visiting = new Set<string>()): Set<string> {
  if (visiting.has(revision.opId)) throw new Error('Cyclic sync revision history')
  const next = new Set(visiting).add(revision.opId)
  const result = new Set<string>()
  for (const parentId of revision.parents ?? []) {
    result.add(parentId)
    const parent = revisions.get(parentId)
    if (parent) for (const ancestor of ancestors(parent, revisions, next)) result.add(ancestor)
  }
  return result
}

export function revisionHeads(revisions: Revision[]): string[] {
  const byId = new Map(revisions.map((revision) => [revision.opId, revision]))
  const superseded = new Set(revisions.flatMap((revision) => [...ancestors(revision, byId)]))
  return [...byId.keys()].filter((key) => !superseded.has(key)).sort()
}

/** Arrays are atomic except tags. Field maps merge independently by field name. */
function mergeValue(base: unknown, values: unknown[], path: string, conflicts: string[]): unknown {
  const changed = values.filter((value) => !equal(base, value))
  if (!changed.length) return base
  if (changed.every((value) => equal(value, changed[0]))) return changed[0]
  if (path === 'updatedAt' && changed.every((value) => typeof value === 'string')) return [...changed as string[]].sort().at(-1)
  if (path === 'tags' && Array.isArray(base) && values.every(Array.isArray)) {
    const original = new Set(base as string[])
    const retained = [...original].filter((tag) => values.every((value) => (value as string[]).includes(tag)))
    const added = values.flatMap((value) => (value as string[]).filter((tag) => !original.has(tag)))
    return [...new Set([...retained, ...added])].sort()
  }
  if (base && typeof base === 'object' && !Array.isArray(base) && values.every((value) => value && typeof value === 'object' && !Array.isArray(value))) {
    const keys = new Set([...Object.keys(base), ...values.flatMap((value) => Object.keys(value as object))])
    return Object.fromEntries([...keys].sort().map((key) => [key, mergeValue((base as Record<string, unknown>)[key], values.map((value) => (value as Record<string, unknown>)[key]), path ? `${path}.${key}` : key, conflicts)]))
  }
  conflicts.push(path || '$')
  // Stable presentation while awaiting an explicit choice; every side remains retained.
  return changed[0]
}

export function mergeRevisions(revisions: Revision[]): RevisionMerge {
  const byId = new Map<string, Revision>()
  for (const revision of revisions) {
    const existing = byId.get(revision.opId)
    if (existing && !equal(existing, revision)) throw new Error('Sync operation identity was reused with different content')
    byId.set(revision.opId, revision)
  }
  const heads = revisionHeads([...byId.values()])
  const tips = heads.map((head) => byId.get(head)!)
  if (!tips.length) return { heads, value: undefined, deleted: false, conflicts: [], versions: [] }
  // A deletion remains authoritative even when a stale update is delivered later.
  const deleted = revisions.some((revision) => revision.action === 'delete')
  const versions = tips.map((tip) => ({ opId: tip.opId, value: tip.action === 'delete' ? null : tip.payload }))
  if (tips.length === 1) return { heads, value: tips[0].payload, deleted, conflicts: [], versions }
  const histories = tips.map((tip) => ancestors(tip, byId))
  const common = [...histories[0]].filter((key) => histories.every((history) => history.has(key)) && byId.has(key))
  const bases = revisionHeads(common.map((key) => byId.get(key)!))
  const base = bases.length ? mergeRevisions(common.map((key) => byId.get(key)!)).value : undefined
  const conflicts: string[] = []
  const value = mergeValue(base, tips.map((tip) => tip.payload), '', conflicts)
  if (deleted && tips.some((tip) => tip.action !== 'delete')) conflicts.push('$deleted')
  return { heads, value, deleted, conflicts: [...new Set(conflicts)], versions }
}
