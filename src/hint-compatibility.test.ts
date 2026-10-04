import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import initSqlJs from 'sql.js'
import { createCollection, tryRenderNoteTemplate } from './collection'
import { exportAnkiPackage } from './anki-export'
import { prepareAnkiImport } from './anki-import'

test('Japanese hint meaning and template survive portable export and a clean import', async () => {
  const source = createCollection(crypto.randomUUID()), target = createCollection(crypto.randomUUID())
  try {
    const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
    const deck = await source.createDeck('日本語 hints')
    const type = await source.createNoteType({ name: 'Hints', fields: [{ name: 'Word' }, { name: 'Meaning' }], templates: [{ name: 'Recognition', front: '{{Word}} {{hint:Meaning}}', back: '{{FrontSide}}<hr>{{Meaning}}', css: '' }] })
    await source.createNote(deck.id, type.id, { [type.fields[0].id]: '猫', [type.fields[1].id]: 'cat · ねこ' })
    const exported = await exportAnkiPackage(source, { scheduling: true, history: true, media: true, SQL })
    const preview = await prepareAnkiImport(new File([exported.bytes.slice().buffer], 'hints.apkg'), target, { SQL })
    expect(preview.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    await preview.commit()
    const note = (await target.notes.toArray())[0], restored = (await target.noteTypes.toArray()).find((entry) => entry.id === note.typeId)!
    expect(restored.templates[0].front).toBe('{{Word}} {{hint:Meaning}}')
    expect(restored.fields.map((field) => note.fields[field.id])).toEqual(['猫', 'cat · ねこ'])
    const rendered = tryRenderNoteTemplate(restored.templates[0].front, restored, note.fields)
    expect(rendered.ok).toBe(true)
    if (rendered.ok) expect(new DOMParser().parseFromString(rendered.value.html, 'text/html').querySelector('.card-hint-content')?.textContent).toBe('cat · ねこ')
  } finally { await source.delete(); await target.delete() }
})
