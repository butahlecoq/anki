import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync } from 'fflate'

const MAX_BACKUPS = 14
const RETENTION_DAYS = 30
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export type BackupManifest = {
  format: 'kiroku-server-backup'
  formatVersion: 1
  id: string
  createdAt: string
  reason: 'manual' | 'before-sync'
  collectionSchemaVersion: number
  changeCount: number
  latestCursor: number
  databaseBytes: number
  databaseSha256: string
  media: Array<{ digest: string; byteLength: number; mimeType: string }>
  archiveSha256: string
  archiveBytes: number
}

type Options = { database: DatabaseSync; mediaDirectory: string; backupDirectory: string; collectionSchemaVersion: () => number }

async function prune(directory: string) {
  const files = (await readdir(directory)).filter((name) => /^backup-[a-f0-9-]+\.json$/.test(name))
  const manifests = await Promise.all(files.map(async (name) => {
    try { return { name, manifest: JSON.parse(await readFile(join(directory, name), 'utf8')) as BackupManifest } } catch { return undefined }
  }))
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60_000
  const valid = manifests.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
  for (const [index, entry] of valid.entries()) {
    if (index >= MAX_BACKUPS || Date.parse(entry.manifest.createdAt) < cutoff) {
      await rm(join(directory, entry.name), { force: true })
      await rm(join(directory, entry.name.replace(/\.json$/, '.zip')), { force: true })
    }
  }
  const validArchives = new Set(valid.filter((entry, index) => index < MAX_BACKUPS && Date.parse(entry.manifest.createdAt) >= cutoff).map((entry) => entry.name.replace(/\.json$/, '.zip')))
  for (const name of await readdir(directory)) if (name.endsWith('.zip') && !validArchives.has(name)) await rm(join(directory, name), { force: true })
}

export function createBackupStore(options: Options) {
  const { database, mediaDirectory, backupDirectory } = options

  async function create(reason: BackupManifest['reason']): Promise<BackupManifest> {
    await mkdir(backupDirectory, { recursive: true })
    const id = randomUUID()
    const snapshotPath = join(backupDirectory, `.snapshot-${id}.sqlite`)
    const stagedArchive = join(backupDirectory, `.backup-${id}.zip`)
    try {
      // VACUUM INTO observes one consistent SQLite snapshot, including committed WAL rows.
      database.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`)
      const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
      let media: BackupManifest['media']
      let mediaContents = new Map<string, Uint8Array>()
      let changeCount: number
      let latestCursor: number
      let schemaVersion: number
      try {
        const integrity = snapshot.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite backup failed its integrity check.')
        const tables = new Set((snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name))
        for (const table of ['changes', 'media_blobs', 'collection_metadata']) if (!tables.has(table)) throw new Error(`SQLite backup is missing required table ${table}.`)
        const rows = snapshot.prepare('SELECT digest, byte_length, mime_type FROM media_blobs ORDER BY digest').all() as Array<{ digest: string; byte_length: number; mime_type: string }>
        const verifiedMedia = await Promise.all(rows.map(async (row) => {
          let bytes: Buffer
          try { bytes = await readFile(join(mediaDirectory, row.digest.slice(0, 2), row.digest)) }
          catch { throw new Error(`Media ${row.digest} is missing or unreadable. Restore the file from another backup before syncing.`) }
          if (bytes.byteLength !== row.byte_length || digest(bytes) !== row.digest) throw new Error(`Media ${row.digest} failed backup verification. Restore the missing or damaged media file before making a backup.`)
          return { manifest: { digest: row.digest, byteLength: bytes.byteLength, mimeType: row.mime_type }, bytes }
        }))
        media = verifiedMedia.map(({ manifest }) => manifest)
        mediaContents = new Map(verifiedMedia.map(({ manifest, bytes }) => [manifest.digest, bytes]))
        changeCount = Number((snapshot.prepare('SELECT COUNT(*) AS count FROM changes').get() as { count: number }).count)
        latestCursor = Number((snapshot.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM changes').get() as { cursor: number }).cursor)
        const meta = snapshot.prepare("SELECT value FROM collection_metadata WHERE key = 'collection_schema_version'").get() as { value: string } | undefined
        schemaVersion = meta ? Number.parseInt(meta.value, 10) : options.collectionSchemaVersion()
      } finally { snapshot.close() }
      const databaseBytes = await readFile(snapshotPath)
      const entries: Record<string, Uint8Array> = { 'collection.sqlite': databaseBytes }
      for (const item of media) entries[`media/${item.digest}`] = mediaContents.get(item.digest)!
      const archive = zipSync(entries, { level: 1 })
      const manifest: BackupManifest = {
        format: 'kiroku-server-backup', formatVersion: 1, id, createdAt: new Date().toISOString(), reason,
        collectionSchemaVersion: schemaVersion, changeCount, latestCursor, databaseBytes: databaseBytes.byteLength,
        databaseSha256: digest(databaseBytes), media, archiveSha256: digest(archive), archiveBytes: archive.byteLength,
      }
      const manifestPath = join(backupDirectory, `backup-${id}.json`)
      const archivePath = join(backupDirectory, `backup-${id}.zip`)
      await writeFile(stagedArchive, archive, { flag: 'wx' })
      await rename(stagedArchive, archivePath)
      const stagedManifest = `${manifestPath}.tmp`
      await writeFile(stagedManifest, JSON.stringify(manifest), { flag: 'wx' })
      await rename(stagedManifest, manifestPath)
      await prune(backupDirectory)
      return manifest
    } finally {
      await rm(snapshotPath, { force: true })
      await rm(stagedArchive, { force: true })
    }
  }

  async function list(): Promise<BackupManifest[]> {
    await mkdir(backupDirectory, { recursive: true })
    const names = (await readdir(backupDirectory)).filter((name) => /^backup-[a-f0-9-]+\.json$/.test(name))
    const items = await Promise.all(names.map(async (name) => {
      try {
        const manifest = JSON.parse(await readFile(join(backupDirectory, name), 'utf8')) as BackupManifest
        const archive = await readFile(join(backupDirectory, name.replace(/\.json$/, '.zip')))
        if (manifest.format !== 'kiroku-server-backup' || manifest.formatVersion !== 1 || digest(archive) !== manifest.archiveSha256 || archive.byteLength !== manifest.archiveBytes) return undefined
        return manifest
      } catch { return undefined }
    }))
    return items.filter((item): item is BackupManifest => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async function download(id: string) {
    const entry = (await list()).find((item) => item.id === id)
    if (!entry) throw new Error('Verified backup not found. Create a new backup or restore the backup directory from another copy.')
    const archive = await readFile(join(backupDirectory, `backup-${id}.zip`))
    if (digest(archive) !== entry.archiveSha256) throw new Error('Backup archive failed its integrity check. Keep the server data directory and seek recovery before restoring.')
    return { manifest: entry, bytes: new Uint8Array(archive) }
  }

  async function previewRestore(id: string) {
    const { manifest, bytes } = await download(id)
    const { unzipSync } = await import('fflate')
    const entries = unzipSync(bytes)
    const names = Object.keys(entries).sort()
    const expectedNames = ['collection.sqlite', ...manifest.media.map((item) => `media/${item.digest}`)].sort()
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error('Backup contents do not match the verified manifest.')
    const databaseImage = entries['collection.sqlite']
    if (!databaseImage || databaseImage.byteLength !== manifest.databaseBytes || digest(databaseImage) !== manifest.databaseSha256) throw new Error('Backup collection failed its integrity check.')
    const tempPath = join(backupDirectory, `.verify-${id}.sqlite`)
    try {
      await writeFile(tempPath, databaseImage)
      const snapshot = new DatabaseSync(tempPath, { readOnly: true })
      try {
        const integrity = snapshot.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Backup collection failed its SQLite integrity check.')
        const count = Number((snapshot.prepare('SELECT COUNT(*) AS count FROM changes').get() as { count: number }).count)
        const cursor = Number((snapshot.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM changes').get() as { cursor: number }).cursor)
        if (count !== manifest.changeCount || cursor !== manifest.latestCursor) throw new Error('Backup collection does not match its manifest summary.')
      } finally { snapshot.close() }
    } finally { await rm(tempPath, { force: true }) }
    for (const item of manifest.media) {
      const content = entries[`media/${item.digest}`]
      if (!content || content.byteLength !== item.byteLength || digest(content) !== item.digest) throw new Error(`Backup media ${item.digest} failed its integrity check.`)
    }
    return { manifest, mediaBytes: manifest.media.reduce((sum, item) => sum + item.byteLength, 0), changeCount: manifest.changeCount, latestCursor: manifest.latestCursor, restoreAvailable: false, restoreBlocker: 'Replacing a collection requires an explicit paired-device reset and recovery flow; preview does not change the active collection.' }
  }

  return { create, list, download, previewRestore }
}
