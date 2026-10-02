// Optional independent oracle: install official anki==26.9.3 in a tools venv,
// then set ANKI_TEST_PYTHON to its interpreter. Never reads the user's .env.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, basename } from 'node:path'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import initSqlJs from 'sql.js'
import 'fake-indexeddb/auto'

// The oracle runs in one Node process; production media state uses Web Locks.
Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request: async (_name, _options, action) => action({}) } })

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
import sys,json,time
action,root,endpoint=sys.argv[1:]
path=Path(root)/('seed.anki2' if action=='seed' else 'observer.anki2')
c=Collection(str(path))
a=c.sync_login('kiroku-oracle','generated-local-only',endpoint)
a.endpoint=endpoint
def sync_media():
    c.sync_media(a)
    for attempt in range(200):
        if not c.media_sync_status().active:
            return
        time.sleep(.05)
    raise AssertionError('official media sync did not finish')
if action=='seed':
    deck=c.decks.id('日本語')
    for front in ['猫','犬']:
        n=c.new_note(c.models.by_name('Basic'))
        n.fields=[front,'original']
        c.add_note(n,deck)
    c.sync_collection(a,False)
    c.full_upload_or_download(auth=a,server_usn=None,upload=True)
    (Path(c.media.dir())/'猫-日本語.bin').write_bytes(b'generated Japanese media fixture')
    sync_media()
else:
    c.sync_collection(a,False)
    if action=='edit':
        c.full_upload_or_download(auth=a,server_usn=None,upload=False)
        n=c.get_note(c.find_notes('猫')[0])
        assert n.fields[1]=='native changed'
        assert c.db.scalar('select count(*) from revlog')==1
        n.fields[1]='official changed'
        n.fields[0]='<b>猫</b>&nbsp;<img src="猫.png">'
        c.update_note(n)
    elif action=='delete':
        c.remove_notes(c.find_notes('猫'))
    elif action=='cache':
        from anki.collection import StripHtmlMode
        from hashlib import sha1
        def cache_text(field):
            return c._backend.strip_html(text=field,mode=StripHtmlMode.PRESERVE_MEDIA_FILENAMES)
        fields=['今日','<b>猫</b>&nbsp;<img src="猫.png">','<script>ignore</script>犬<style>ignore</style>','<img src=cat.png>[sound:猫.mp3]','&amp;&lt;&quot;&#12354;','&unknown;&amp;']
        print(json.dumps([[field,cache_text(field),int(sha1(cache_text(field).encode('utf8')).hexdigest()[:8],16)] for field in fields]))
    elif action=='media-edit':
        sync_media()
        assert (Path(c.media.dir())/'native-日本語.bin').read_bytes()==b'generated native media'
        (Path(c.media.dir())/'native-日本語.bin').write_bytes(b'generated remote conflict')
        (Path(c.media.dir())/'猫-日本語.bin').unlink()
        (Path(c.media.dir())/'official-日本語.bin').write_bytes(b'generated official replacement')
        sync_media()
    elif action=='media-check':
        sync_media()
        assert (Path(c.media.dir())/'recovery-日本語.bin').read_bytes()==b'generated recovery media'
        assert (Path(c.media.dir())/'native-日本語.bin').read_bytes()==b'generated local conflict'
        for i in range(26):
            assert (Path(c.media.dir())/('batch-'+str(i)+'.bin')).read_bytes()==b'generated batch media'
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
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', 'src/native-anki-sync.ts', 'src/native-anki-media.ts', '--outDir', 'runtime/native-build', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--strict', '--skipLibCheck'], { stdio: 'pipe', windowsHide: true })
  const { NativeAnkiClient } = await import('../runtime/native-build/native-anki-sync.js')
  const { nativeFieldText } = await import('../runtime/native-build/native-anki-cache.js')
  const { NativeAnkiMedia } = await import('../runtime/native-build/native-anki-media.js')
  for (const [field, text, checksum] of JSON.parse(oracle('cache').toString())) {
    assert.equal(nativeFieldText(field), text, 'official native field text/cache interpretation')
    assert.equal(createHash('sha1').update(nativeFieldText(field)).digest().readUInt32BE(0), checksum)
  }
  let loseFinish = false
  let loseMediaUpload = false
  let truncateMediaDownload = false
  let mediaUploads = 0
  const client = await NativeAnkiClient.login(async (route, body) => {
    const response = await fetch(`${endpoint}${route}`, { method: 'POST', body, signal: AbortSignal.timeout(10000) })
    if (route === 'msync/uploadChanges') mediaUploads++
    if (route === 'sync/finish' && loseFinish) { loseFinish = false; await response.arrayBuffer(); throw Error('Generated lost finish response') }
    if (route === 'msync/uploadChanges' && loseMediaUpload) { loseMediaUpload = false; await response.arrayBuffer(); throw Error('Generated lost media upload response') }
    if (route === 'msync/downloadFiles' && truncateMediaDownload) { truncateMediaDownload = false; const bytes = new Uint8Array(await response.arrayBuffer()); return new Response(bytes.subarray(0, bytes.length - 10)) }
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
  mutate((db) => {
    const [sfld, csum] = db.exec('SELECT sfld,csum FROM notes ORDER BY id')[0].values[0]
    assert.equal(sfld, '猫  猫.png ')
    assert.equal(Number(csum), createHash('sha1').update(String(sfld)).digest().readUInt32BE(0), 'native cache checksum rebuilt')
  })
  const media = new NativeAnkiMedia(`oracle-${Date.now()}`)
  try {
    truncateMediaDownload = true
    await assert.rejects(media.synchronize(client))
    assert.equal(await media.cursor(), 0, 'truncated media must not advance durable cursor')
    assert.equal(await media.files.count(), 0, 'truncated media must not appear verified')
    await media.synchronize(client, true)
    assert.equal(new TextDecoder().decode((await media.files.get('猫-日本語.bin')).bytes), 'generated Japanese media fixture')
    await media.setFile('native-日本語.bin', new TextEncoder().encode('generated native media'))
    for (let index = 0; index < 26; index++) await media.setFile(`batch-${index}.bin`, new TextEncoder().encode('generated batch media'))
    await media.synchronize(client)
    assert.equal(mediaUploads, 2, 'official uploads split at maximum25 entries')
    await media.setFile('native-日本語.bin', new TextEncoder().encode('generated local conflict'))
    oracle('media-edit')
    await assert.rejects(media.synchronize(client), /Both local and account media versions/)
    const conflict = await media.conflicts.get('native-日本語.bin')
    assert.equal(new TextDecoder().decode(conflict.local.bytes), 'generated local conflict')
    assert.equal(new TextDecoder().decode(conflict.remote.bytes), 'generated remote conflict')
    await media.resolve('native-日本語.bin', 'local')
    await media.synchronize(client, true)
    assert.equal((await media.conflicts.get('native-日本語.bin')).resolved, true, 'alternate conflict version retained after resolution')
    assert.equal((await media.files.get('猫-日本語.bin')).bytes, null, 'official media deletion propagated')
    assert.equal(new TextDecoder().decode((await media.files.get('official-日本語.bin')).bytes), 'generated official replacement')
    await media.setFile('recovery-日本語.bin', new TextEncoder().encode('generated recovery media'))
    loseMediaUpload = true
    await assert.rejects(media.synchronize(client), /lost media upload response/)
    assert.equal((await media.files.get('recovery-日本語.bin')).pending, true)
    await media.close()
    await media.open()
    await media.synchronize(client, true)
    assert.equal((await media.files.get('recovery-日本語.bin')).pending, false)
    oracle('media-check')
  } finally { await media.delete() }
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
  console.log('Official Anki oracle passed: Japanese two-client edits, native caches, reviews/tombstones, lost-finish retry, media upload/download/deletion, truncated-download rejection and durable lost-upload recovery.')
} finally {
  if (!exited) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)) }
  const target = resolve(root)
  assert(!relative(resolve(tmpdir()), target).startsWith('..') && basename(target).startsWith('kiroku-native-oracle-'), 'oracle cleanup stays inside generated temporary directory')
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
