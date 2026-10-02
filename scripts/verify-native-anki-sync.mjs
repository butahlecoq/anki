// Optional independent oracle: install official anki==26.9.3 in a tools venv,
// then set ANKI_TEST_PYTHON to its interpreter. Never reads the user's .env.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'

const python = process.env.ANKI_TEST_PYTHON
if (!python) throw Error('Set ANKI_TEST_PYTHON to an isolated interpreter with official anki==26.9.3 installed.')
const root = mkdtempSync(join(tmpdir(), 'kiroku-native-oracle-'))
const listener = createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const endpoint = `http://127.0.0.1:${port}/`
const fixture = join(root, 'oracle.py')
writeFileSync(fixture, `from anki.collection import Collection
from pathlib import Path
import sys
action,root,endpoint=sys.argv[1:]
path=Path(root)/('seed.anki2' if action=='seed' else 'observer.anki2')
c=Collection(str(path))
a=c.sync_login('kiroku-oracle','generated-local-only',endpoint)
a.endpoint=endpoint
if action=='seed':
    deck=c.decks.id('日本語')
    for front in ['猫','犬']:
        n=c.new_note(c.models.by_name('Basic'))
        n.fields=[front,'original']
        c.add_note(n,deck)
    c.sync_collection(a,False)
    c.full_upload_or_download(auth=a,server_usn=None,upload=True)
else:
    c.sync_collection(a,False)
    if action=='edit':
        c.full_upload_or_download(auth=a,server_usn=None,upload=False)
        n=c.get_note(c.find_notes('猫')[0])
        assert n.fields[1]=='native changed'
        assert c.db.scalar('select count(*) from revlog')==1
        n.fields[1]='official changed'
        c.update_note(n)
    elif action=='delete':
        c.remove_notes(c.find_notes('猫'))
    c.sync_collection(a,False)
c.close()
`)
const server = spawn(python, ['-m', 'anki.syncserver'], {
  env: { ...process.env, SYNC_USER1: 'kiroku-oracle:generated-local-only', SYNC_HOST: '127.0.0.1', SYNC_PORT: String(port), SYNC_BASE: join(root, 'server') },
  stdio: 'ignore', windowsHide: true,
})
let exited = false
server.once('exit', () => { exited = true })
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited) throw Error('Official isolated server exited before readiness.')
    try { await fetch(endpoint, { signal: AbortSignal.timeout(1000) }); ready = true; break } catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
  assert(ready, 'official server readiness')
  const oracle = (action) => execFileSync(python, [fixture, action, root, endpoint], { stdio: 'pipe', windowsHide: true })
  oracle('seed')
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', 'src/native-anki-sync.ts', '--outDir', 'runtime/native-build', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--strict', '--skipLibCheck'], { stdio: 'pipe', windowsHide: true })
  const { NativeAnkiClient } = await import('../runtime/native-build/native-anki-sync.js')
  let loseFinish = false
  const client = await NativeAnkiClient.login(async (route, body) => {
    const response = await fetch(`${endpoint}${route}`, { method: 'POST', body, signal: AbortSignal.timeout(10000) })
    if (route === 'sync/finish' && loseFinish) { loseFinish = false; await response.arrayBuffer(); throw Error('Generated lost finish response') }
    return response
  }, 'kiroku-oracle', 'generated-local-only')
  const SQL = await initSqlJs()
  let snapshot = await client.downloadCollection(SQL)
  const mutate = (modify) => { const db = new SQL.Database(snapshot); try { modify(db); snapshot = db.export() } finally { db.close() } }
  mutate((db) => {
    db.run('UPDATE notes SET flds=?,mod=?,usn=-1 WHERE id=(SELECT min(id) FROM notes)', ['猫\u001fnative changed', Math.floor(Date.now() / 1000)])
    db.run('INSERT INTO revlog SELECT ?,id,-1,3,1,0,2500,1000,0 FROM cards WHERE nid=(SELECT min(id) FROM notes)', [Date.now()])
    db.run('UPDATE col SET mod=?', [Date.now()])
  })
  const sync = async () => { const result = await client.syncCollection(SQL, snapshot); assert('collection' in result); snapshot = result.collection; return result.outcome }
  assert.equal(await sync(), 'synced')
  assert.equal(await sync(), 'unchanged')
  oracle('edit')
  assert.equal(await sync(), 'synced')
  mutate((db) => assert(String(db.exec('SELECT flds FROM notes ORDER BY id')[0].values[0][0]).includes('official changed')))
  mutate((db) => { db.run('UPDATE notes SET tags=?,mod=?,usn=-1 WHERE id=(SELECT min(id) FROM notes)', [' native-recovery ', Math.floor(Date.now() / 1000)]); db.run('UPDATE col SET mod=?', [Date.now()]) })
  const beforeFailure = snapshot.slice()
  loseFinish = true
  await assert.rejects(sync, /lost finish response/)
  assert.deepEqual(snapshot, beforeFailure, 'failed finish retains original local snapshot')
  assert.equal(await sync(), 'synced')
  oracle('delete')
  assert.equal(await sync(), 'synced')
  mutate((db) => { assert.equal(db.exec('SELECT count(*) FROM notes')[0].values[0][0], 1); assert.equal(db.exec('SELECT count(*) FROM cards')[0].values[0][0], 1); assert.equal(db.exec('SELECT count(*) FROM revlog')[0].values[0][0], 1) })
  assert.equal(await sync(), 'unchanged')
  console.log('Official Anki oracle passed: Japanese two-client edits, review history, lost-finish retry, tombstones, repeat convergence.')
} finally {
  if (!exited) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)) }
  rmSync(root, { recursive: true, force: true })
}
