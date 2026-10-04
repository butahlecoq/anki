import { Dexie, type Table } from 'dexie'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { validateAnkiArchive } from './anki-archive.js'
import { NativeAnkiClient, NativeSyncError, type NativeRequestOptions } from './native-anki-sync.js'
import { requireWebLocks } from './native-sync-capability.js'

const maxBytes = 63 * 1024 * 1024
const targetBytes = 2.5 * 1024 * 1024
interface MediaFile { name: string; bytes: Uint8Array | null; sha1: string; sha256: string; pending: boolean; overrideRemoteSha1?: string }
interface MediaMeta { id: 'media'; usn: number }
interface MediaAttempt { id: 'active'; startedAt: number; status: 'running' | 'recovery-required' }
interface MediaConflict { name: string; local: MediaFile; remote: MediaFile; resolved?: boolean }
const invalid = () => new NativeSyncError('protocol', 'Native media response is invalid or incomplete. Verified local media and cursor are preserved.')
function filename(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\]/.test(value) || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.normalize('NFC') !== value || strToU8(value).length > 255) throw invalid()
  return value
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid()
  return value
}
async function record(name: string, bytes: Uint8Array | null, pending: boolean): Promise<MediaFile> {
  filename(name)
  if (bytes && (!bytes.length || bytes.length > maxBytes)) throw new NativeSyncError('transfer', 'Native media files must be nonempty and at most 63 MiB. Keep the original file before retrying.')
  const hash = async (algorithm: string) => bytes ? [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes.slice().buffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('') : ''
  return { name, bytes: bytes?.slice() ?? null, sha1: await hash('SHA-1'), sha256: await hash('SHA-256'), pending }
}

/** Durable native filenames and opaque bytes. A completed download batch and
 * its cursor commit together; failed uploads remain pending for stable replay.
 * Account keys never enter this database. */
export class NativeAnkiMedia extends Dexie {
  files!: Table<MediaFile, string>
  meta!: Table<MediaMeta, string>
  attempts!: Table<MediaAttempt, string>
  conflicts!: Table<MediaConflict, string>
  constructor(name = 'kiroku-native-media') {
    super(name)
    this.version(1).stores({ files: 'name', meta: 'id', attempts: 'id', conflicts: 'name' })
  }
  async cursor() { return (await this.meta.get('media'))?.usn ?? 0 }
  async setFile(name: string, bytes: Uint8Array | null) {
    const file = await record(name, bytes, true)
    await this.transaction('rw', this.files, this.attempts, this.conflicts, async () => {
      if (await this.attempts.get('active') || (await this.conflicts.get(name))?.resolved === false) throw new NativeSyncError('conflict', 'Recover or resolve native media synchronization before editing this file.')
      await this.files.put(file)
    })
  }
  async synchronize(client: NativeAnkiClient, recover = false, options: NativeRequestOptions = {}) {
    return requireWebLocks('Anki media').request(`${this.name}:sync`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) throw new NativeSyncError('transfer', 'Another page is synchronizing native media.')
      await this.transaction('rw', this.attempts, this.conflicts, async () => {
        const attempt = await this.attempts.get('active')
        if ((Boolean(attempt) !== recover) || await this.conflicts.filter((conflict) => !conflict.resolved).count()) throw new NativeSyncError('conflict', 'Recover or resolve the previous native media synchronization first.')
        await this.attempts.put({ id: 'active', startedAt: Date.now(), status: 'running' })
      })
      try {
        await client.metadata(options)
        const begin = await client.mediaRequest('begin', { v: 'kiroku,0.1,web' }, options)
        if (!begin || typeof begin !== 'object' || !('usn' in begin)) throw invalid()
        const serverUsn = revision(begin.usn)
        if (serverUsn < await this.cursor()) throw new NativeSyncError('conflict', 'The account media revision moved backwards. Preserve this media database before rebuilding synchronization.')
        await this.receive(client, options)
        await this.send(client, options)
        // Fetch changes racing our uploads before comparing global file counts.
        await this.receive(client, options)
        const count = await this.files.filter((file) => file.bytes !== null).count()
        if (await client.mediaRequest('mediaSanity', { local: count }, options) !== 'OK') throw new NativeSyncError('transfer', 'Account media changed during synchronization. Retry without clearing verified local files.')
        await this.attempts.delete('active')
        return { outcome: 'synced' as const, cursor: await this.cursor(), files: count }
      } catch (error) {
        await this.attempts.update('active', { status: 'recovery-required' })
        throw error
      }
    })
  }
  /** Explicit resolution retains the alternate version until separately
   * acknowledged by the caller. No conflict is overwritten during sync. */
  async resolve(name: string, choice: 'local' | 'remote') {
    await this.transaction('rw', this.files, this.conflicts, this.attempts, async () => {
      const conflict = await this.conflicts.get(name)
      if (!conflict || (await this.attempts.get('active'))?.status !== 'recovery-required') throw invalid()
      await this.files.put({ ...conflict[choice], pending: choice === 'local', ...(choice === 'local' ? { overrideRemoteSha1: conflict.remote.sha1 } : {}) })
      await this.conflicts.update(name, { resolved: true })
    })
  }
  private async receive(client: NativeAnkiClient, options: NativeRequestOptions) {
    for (let batch = 0; batch < 4000; batch++) {
      const current = await this.cursor()
      const changes = await client.mediaRequest('mediaChanges', { lastUsn: current }, options)
      if (!Array.isArray(changes) || changes.length > 1000) throw invalid()
      if (!changes.length) return
      let last = current
      for (const change of changes) {
        if (!Array.isArray(change) || change.length !== 3 || typeof change[2] !== 'string' || (change[2] && !/^[a-f0-9]{40}$/.test(change[2]))) throw invalid()
        const name = filename(change[0]), usn = revision(change[1]), sha1 = change[2]
        if (usn <= last) throw invalid()
        last = usn
        const local = await this.files.get(name)
        let update: MediaFile | undefined
        if (local?.sha1 === sha1) update = { ...local, pending: false }
        // Native Anki keeps a pending local addition when the remote deleted
        // the same name. It will be uploaded below using the stable filename.
        else if (!(local?.pending && local.bytes && (!sha1 || local.overrideRemoteSha1 === sha1))) {
          const remote = sha1 ? await this.download(client, name, sha1, options) : await record(name, null, false)
          if (local?.pending && local.bytes && remote.bytes) {
            await this.conflicts.put({ name, local, remote, resolved: false })
            throw new NativeSyncError('conflict', 'Both local and account media versions were retained. Resolve the file before recovering synchronization.')
          }
          update = remote
        }
        await this.transaction('rw', this.files, this.meta, async () => {
          if (update) await this.files.put(update)
          await this.meta.put({ id: 'media', usn: usn })
        })
      }
    }
    throw new NativeSyncError('transfer', 'Native media synchronization exceeded its bounded change batches.')
  }
  private async download(client: NativeAnkiClient, name: string, sha1: string, options: NativeRequestOptions): Promise<MediaFile> {
    const zip = await client.mediaRequest('downloadFiles', { files: [name] }, options)
    if (!(zip instanceof Uint8Array)) throw invalid()
    validateAnkiArchive(zip, { compressedBytes: 64 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, entryBytes: maxBytes, entries: 2 })
    const entries = unzipSync(zip)
    if (!entries._meta || entries._meta.length > 50 * 1024 || Object.keys(entries).length !== 2) throw invalid()
    let manifest: unknown
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entries._meta)) } catch { throw invalid() }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalid()
    const map = Object.entries(manifest)
    if (map.length !== 1 || map[0][1] !== name || !/^(0|[1-9][0-9]*)$/.test(map[0][0]) || !Object.hasOwn(entries, map[0][0])) throw invalid()
    const file = await record(name, entries[map[0][0]], false)
    if (file.sha1 !== sha1) throw new NativeSyncError('transfer', 'Account media content changed or was damaged in transit. Its cursor was not committed.')
    return file
  }
  private async send(client: NativeAnkiClient, options: NativeRequestOptions) {
    for (let batch = 0; batch < 4000; batch++) {
      const names = await this.files.filter((file) => file.pending).limit(25).primaryKeys()
      if (!names.length) return
      const selected: MediaFile[] = []; let total = 0
      for (const name of names) {
        const file = await this.files.get(name)
        if (!file) throw invalid()
        if (selected.length === 25 || (selected.length && total + (file.bytes?.length ?? 0) > targetBytes)) break
        const verified = await record(file.name, file.bytes, true)
        if (verified.sha1 !== file.sha1 || verified.sha256 !== file.sha256) throw invalid()
        selected.push(file); total += file.bytes?.length ?? 0
      }
      const entries: Record<string, Uint8Array> = Object.create(null)
      const manifest = selected.map((file, index) => {
        if (file.bytes) entries[String(index)] = file.bytes
        return [file.name, file.bytes ? String(index) : null]
      })
      entries._meta = strToU8(JSON.stringify(manifest))
      const zip = zipSync(entries, { level: 0 })
      if (zip.length > 64 * 1024 * 1024) throw invalid()
      const reply = await client.mediaRequest('uploadChanges', zip, options)
      if (!Array.isArray(reply) || reply.length !== 2) throw invalid()
      const processed = revision(reply[0]), usn = revision(reply[1])
      if (!processed || processed > selected.length) throw invalid()
      await this.transaction('rw', this.files, this.meta, async () => {
        const cursor = await this.cursor()
        for (const file of selected.slice(0, processed)) await this.files.put({ ...file, pending: false, overrideRemoteSha1: undefined })
        // Only advance across exactly our changes; concurrent changes must be
        // fetched instead of skipping another client's media revisions.
        if (cursor + processed === usn) await this.meta.put({ id: 'media', usn })
      })
    }
    throw new NativeSyncError('transfer', 'Native media synchronization exceeded its bounded upload batches.')
  }
}
