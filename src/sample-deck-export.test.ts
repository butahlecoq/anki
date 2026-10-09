import 'fake-indexeddb/auto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { Collection as AnkiCollection } from 'ankipack'
import { collection, createCollection, Rating, type Collection } from './collection'
import { loadSampleDeck } from './sample-deck'
import { exportAnkiPackage } from './anki-export'
import { prepareAnkiImport } from './anki-import'
import { readAnkiExportSnapshot } from './collection-queries'

let SQL: SqlJsStatic
const databases: Collection[] = []
const all = { scheduling: true, history: true, media: true }
async function captureNativePackage(name: string, bytes: Uint8Array) {
  if (!process.env.KIROKU_NATIVE_EXPORT_FIXTURE) return
  await mkdir('runtime/sample-export-interop', { recursive: true })
  await writeFile(`runtime/sample-export-interop/${name}.apkg`, bytes)
}
beforeAll(async () => { SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' }) })
afterEach(async () => {
  vi.unstubAllGlobals()
  await collection.removeLocalCollection()
  await Promise.all(databases.splice(0).map(db => db.removeLocalCollection()))
})

test('the real Japanese sample exports and restores its formatted templates and actual media', async () => {
  // Only fixture-file transport is replaced; creation, storage and exchange are real.
  const files = new Map(await Promise.all(['cat.wav', 'garden.png'].map(async name =>
    [name, Uint8Array.from(await readFile(`public/sample-deck/${name}`))] as const)))
  vi.stubGlobal('fetch', async (url: string) => {
    const bytes = files.get(url.replace('/sample-deck/', ''))
    if (!bytes) throw new Error(`Unexpected sample fetch: ${url}`)
    return { ok: true, blob: async () => new Blob([bytes]) }
  })
  await loadSampleDeck()
  const source = await readAnkiExportSnapshot(collection)
  expect(source.notes).toHaveLength(2)
  expect(source.cards).toHaveLength(2)
  expect(source.references.map(reference => reference.displayName).sort()).toEqual(['cat.wav', 'garden.png'])
  await collection.answer(source.cards[0].id, Rating.Good, new Date('2026-10-01T12:00:00Z'))
  const output = await exportAnkiPackage(collection, { ...all, SQL })
  await captureNativePackage('sample-media', output.bytes)
  expect(output).toMatchObject({ notes: 2, cards: 2, reviews: 1, media: 2 })
  const native = AnkiCollection.open(output.bytes, SQL)
  expect(native.data.media).toHaveLength(2)
  expect(native.data.revlog).toHaveLength(1)
  const target = createCollection(crypto.randomUUID())
  databases.push(target)
  const prepared = await prepareAnkiImport(new File([output.bytes.slice().buffer], 'sample.apkg'), target, { SQL })
  expect(prepared.issues.filter(issue => issue.severity === 'error')).toEqual([])
  await prepared.commit()
  const restored = await readAnkiExportSnapshot(target)
  expect(restored.cards.map(card => card.clozeOrdinal)).toEqual([1, 1])
  expect(restored.reviews).toHaveLength(1)
  expect(restored.blobs.map(blob => blob.digest).sort()).toEqual(source.blobs.map(blob => blob.digest).sort())
  expect(restored.references.map(({ displayName, side, playback }) => ({ displayName, side, playback })).sort((a, b) => a.displayName.localeCompare(b.displayName)))
    .toEqual(source.references.map(({ displayName, side, playback }) => ({ displayName, side, playback })).sort((a, b) => a.displayName.localeCompare(b.displayName)))
  const type = source.types.find(type => type.id === source.notes[0].typeId)!
  const restoredType = restored.types.find(type => type.id === restored.notes[0].typeId)!
  expect(restoredType.kind).toBe('cloze')
  expect(restoredType.templates.map(({ front, back }) => ({ front, back }))).toEqual(type.templates.map(({ front, back }) => ({ front, back })))
  const values = (notes: typeof source.notes, fields: typeof type.fields) => notes.map(note => fields.map(field => note.fields[field.id])).sort((a, b) => a.join().localeCompare(b.join()))
  expect(values(restored.notes, restoredType.fields)).toEqual(values(source.notes, type.fields))
})

test('a cloze-only template exports an actual image without changing the cloze expression', async () => {
  const source = createCollection(crypto.randomUUID())
  databases.push(source)
  const type = await source.createNoteType({ name: 'Media cloze', kind: 'cloze', fields: [{ name: 'Text' }], templates: [{ name: 'Cloze', front: '{{cloze:Text}}', back: '{{cloze:Text}}', css: '' }] })
  const deck = await source.createDeck('日本語')
  const note = await source.createNote(deck.id, type.id, { [type.fields[0].id]: '{{c1::猫}}' })
  await source.attachMedia(note.id, { file: new File([Uint8Array.from(await readFile('public/sample-deck/garden.png'))], 'garden.png', { type: 'image/png' }), side: 'front' })
  const output = await exportAnkiPackage(source, { ...all, SQL })
  await captureNativePackage('cloze-only-media', output.bytes)
  const native = AnkiCollection.open(output.bytes, SQL)
  expect(native.data.media).toHaveLength(1)
  expect(native.data.notes[0].flds).toContain('{{c1::猫}}')
  expect(native.data.notes[0].flds).toContain('<img src=')
})

test.each(['{{#Front}}Hello{{/Front}}', '{{text:Front}}'])('rejects media placement when the front cannot render it: %s', async front => {
  const source = createCollection(crypto.randomUUID())
  databases.push(source)
  const type = await source.createNoteType({ name: 'No media slot', kind: 'standard', fields: [{ name: 'Front' }, { name: 'Back' }], templates: [{ name: 'Card', front, back: '{{Back}}', css: '' }] })
  const deck = await source.createDeck('日本語')
  const note = await source.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat' })
  await source.attachMedia(note.id, { file: new File([Uint8Array.from(await readFile('public/sample-deck/garden.png'))], 'garden.png', { type: 'image/png' }), side: 'front' })
  await expect(exportAnkiPackage(source, { ...all, SQL })).rejects.toThrow('Media garden.png cannot be placed in its front template.')
})
