import { describe, expect, test } from 'vitest'
import { mergeRevisions, revisionHeads, type Revision } from './sync-revisions'

const initial: Revision = { opId: 'initial', action: 'create', payload: { fields: { Word: '猫', Meaning: 'cat' }, tags: ['animal'], updatedAt: '2026-10-01' } }
const edit = (opId: string, payload: unknown, parents = ['initial']): Revision => ({ opId, parents, action: 'update', payload })

describe('causal sync revisions', () => {
  test('combines independent field edits regardless of delivery order', () => {
    const a = edit('a', { fields: { Word: 'ねこ', Meaning: 'cat' }, tags: ['animal', 'reading'], updatedAt: '2026-10-02' })
    const b = edit('b', { fields: { Word: '猫', Meaning: 'кот' }, tags: ['animal', 'translation'], updatedAt: '2026-10-03' })
    const expected = { fields: { Word: 'ねこ', Meaning: 'кот' }, tags: ['animal', 'reading', 'translation'], updatedAt: '2026-10-03' }
    for (const order of [[initial, a, b], [b, a, initial], [a, initial, b]]) {
      const merged = mergeRevisions(order)
      expect(merged.value).toEqual(expected)
      expect(merged.conflicts).toEqual([])
      expect(merged.heads).toEqual(['a', 'b'])
    }
  })

  test('retains both conflicting values and a resolution supersedes both heads', () => {
    const a = edit('a', { ...(initial.payload as object), fields: { Word: 'ねこ', Meaning: 'cat' } })
    const b = edit('b', { ...(initial.payload as object), fields: { Word: 'ネコ', Meaning: 'cat' } })
    const conflicted = mergeRevisions([initial, b, a])
    expect(conflicted.conflicts).toEqual(['fields.Word'])
    expect(conflicted.versions.map((version) => version.opId)).toEqual(['a', 'b'])
    const resolved = edit('resolution', a.payload, ['a', 'b'])
    expect(mergeRevisions([initial, b, resolved, a])).toMatchObject({ heads: ['resolution'], value: a.payload, conflicts: [] })
  })

  test('a newer edit does not erase a conflict between interrupted independent choices', () => {
    const office = edit('a-office', { fields: { Word: 'ねこ office', Meaning: 'cat' } })
    const home = edit('z-home', { fields: { Word: 'ネコ home', Meaning: 'cat' } })
    const officeChoice = edit('a-choice', office.payload, ['a-office', 'z-home'])
    const homeChoice = edit('b-choice', home.payload, ['a-office', 'z-home'])
    const laterOfficeEdit = edit('later-office', { fields: { Word: 'ねこ after choice', Meaning: 'cat' } }, ['a-choice'])
    const merged = mergeRevisions([initial, office, home, officeChoice, homeChoice, laterOfficeEdit])
    expect(merged.heads).toEqual(['b-choice', 'later-office'])
    expect(merged.conflicts).toContain('fields.Word')
    expect(merged.versions.map((version) => (version.value as { fields: { Word: string } }).fields.Word)).toEqual(['ネコ home', 'ねこ after choice'])
  })

  test('deletion wins over stale edits and retains conflicting context', () => {
    const deletion: Revision = { opId: 'delete', parents: ['initial'], action: 'delete', payload: { id: 'note' } }
    const stale = edit('offline', { fields: { Word: '犬', Meaning: 'dog' } })
    expect(mergeRevisions([stale, deletion, initial])).toMatchObject({ deleted: true, conflicts: expect.arrayContaining(['$deleted']) })
  })

  test('deduplicates retries and rejects operation identity reuse or cycles', () => {
    expect(mergeRevisions([initial, initial]).heads).toEqual(['initial'])
    expect(() => mergeRevisions([initial, { ...initial, payload: 'tampered' }])).toThrow(/identity/)
    expect(() => revisionHeads([edit('a', {}, ['b']), edit('b', {}, ['a'])])).toThrow(/cyclic/i)
  })
})
