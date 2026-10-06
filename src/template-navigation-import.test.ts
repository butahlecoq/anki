import 'fake-indexeddb/auto'
import initSqlJs from 'sql.js'
import { expect, test } from 'vitest'
import { createCollection } from './collection'
import { prepareAnkiImport } from './anki-import'
import { exportAnkiPackage } from './anki-export'
import { readAnkiExportSnapshot } from './collection-queries'
import { navigationFront, navigationPackage } from '../tests/fixtures/secure-navigation'

test('Japanese HTTPS templates, fields and media survive package import/export/clean reimport', async () => {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const source = createCollection(`links-source-${crypto.randomUUID()}`), clean = createCollection(`links-clean-${crypto.randomUUID()}`)
  try {
    const bytes = await navigationPackage(SQL)
    const prepared = await prepareAnkiImport(new File([bytes.slice().buffer], 'synthetic.apkg'), source, { SQL })
    expect(prepared.issues.filter(issue => issue.severity === 'error')).toEqual([])
    await prepared.commit()
    const template = (await readAnkiExportSnapshot(source)).types.find(type => type.name === 'Japanese navigation')!
    expect(template.templates[0].front).toBe(navigationFront)
    const output = await exportAnkiPackage(source, { SQL, media: true, history: true, scheduling: true })
    const reimport = await prepareAnkiImport(new File([output.bytes.slice().buffer], 'roundtrip.apkg'), clean, { SQL })
    expect(reimport.issues.filter(issue => issue.severity === 'error')).toEqual([])
    await reimport.commit()
    const [cleanState, sourceState] = await Promise.all([readAnkiExportSnapshot(clean), readAnkiExportSnapshot(source)])
    expect(cleanState.notes.map(note => [note.id, note.fields, note.tags])).toEqual(sourceState.notes.map(note => [note.id, note.fields, note.tags]))
    expect(cleanState.types.find(type => type.name === 'Japanese navigation')!.templates[0].front).toBe(navigationFront)
    expect(cleanState.references.map(media => media.digest)).toEqual(sourceState.references.map(media => media.digest))
  } finally { await source.removeLocalCollection(); await clean.removeLocalCollection() }
})

test('navigation exception does not allow remote resources, executable markup or unsafe schemes', async () => {
  const SQL = await initSqlJs({ locateFile: () => './node_modules/sql.js/dist/sql-wasm.wasm' })
  const db = createCollection(`links-boundary-${crypto.randomUUID()}`)
  try {
    for (const [front, css] of [
      ['{{Word}}<a href="javascript:alert(1)">Unsafe</a>', ''],
      ['{{Word}}<a href="https://user:secret@example.org">Unsafe</a>', ''],
      ['{{Word}}<img src="https://example.org/image.png">', ''],
      ['{{Word}}<iframe src="https://example.org"></iframe>', ''],
      ['{{Word}}<script src="https://example.org/code.js"></script>', ''],
      ['{{Word}}<a href="https://example.org" onclick="alert(1)">Unsafe</a>', ''],
      ['{{Word}}', '.card { background-image: url(https://example.org/image.png) }'],
    ]) {
      const bytes = await navigationPackage(SQL, front, css)
      const prepared = await prepareAnkiImport(new File([bytes.slice().buffer], 'unsafe.apkg'), db, { SQL })
      expect(prepared.issues.some(issue => issue.severity === 'error')).toBe(true)
      await expect(prepared.commit()).rejects.toThrow()
      expect((await readAnkiExportSnapshot(db)).notes).toHaveLength(0)
    }
  } finally { await db.removeLocalCollection() }
})
