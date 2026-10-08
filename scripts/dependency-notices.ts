import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

interface Notice { file: string; sha256: string; source: string; installedPath?: string; installedSha256?: string }
interface Dependency { name: string; version: string; integrity?: string; includedBy?: string; provenance?: string; notices: Notice[]; assets?: string[] }
interface Inventory { schemaVersion: number; limitations: string[]; sourceChecks: { path: string; sha256: string }[]; dependencies: Dependency[] }
const workerPackages = ['workbox-core', 'workbox-routing', 'workbox-precaching', 'workbox-strategies', 'workbox-window']
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function verifyBytes(path: string, expected: string) {
  const bytes = readFileSync(path)
  if (digest(bytes) !== expected) throw new Error(`Dependency notice source changed: ${path}. Review the exact publisher text and update the inventory.`)
  return bytes
}

export function validateNoticeInventory(root: string): Inventory {
  const inventory: Inventory = JSON.parse(readFileSync(join(root, 'third-party/inventory.json'), 'utf8'))
  const lock: { packages: Record<string, { version: string; integrity?: string; dev?: boolean }> } = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  if (inventory.schemaVersion !== 1) throw new Error('Unsupported dependency notice inventory schema')
  const expected = Object.keys(lock.packages).filter(path => path.startsWith('node_modules/') && (!lock.packages[path].dev || workerPackages.includes(path.slice('node_modules/'.length)))).map(path => path.slice('node_modules/'.length)).sort()
  const declared = inventory.dependencies.filter(item => !item.includedBy).map(item => item.name).sort()
  if (JSON.stringify(expected) !== JSON.stringify(declared)) throw new Error('Dependency notice inventory is stale: resolved production/runtime packages changed')
  for (const dependency of inventory.dependencies) {
    if (!dependency.includedBy) {
      const entry = lock.packages[`node_modules/${dependency.name}`]
      const installed = JSON.parse(readFileSync(join(root, 'node_modules', dependency.name, 'package.json'), 'utf8'))
      if (entry.version !== dependency.version || installed.version !== dependency.version || entry.integrity !== dependency.integrity) throw new Error(`Dependency notice inventory is stale for ${dependency.name}: version or package integrity changed`)
    } else if (!declared.includes(dependency.includedBy)) throw new Error(`Unknown notice parent: ${dependency.includedBy}`)
    if (!dependency.notices.length) throw new Error(`No publisher notices for ${dependency.name}`)
    for (const notice of dependency.notices) {
      if (!/^[a-zA-Z0-9._-]+$/.test(notice.file) || !notice.source.startsWith('https://')) throw new Error(`Invalid notice path/source for ${dependency.name}`)
      verifyBytes(join(root, 'third-party/notices', notice.file), notice.sha256)
      if (notice.installedPath) verifyBytes(join(root, notice.installedPath), notice.installedSha256!)
    }
  }
  for (const check of inventory.sourceChecks) verifyBytes(join(root, check.path), check.sha256)
  return inventory
}

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
function indexPage(inventory: Inventory) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kiroku dependency notices</title><style>body{font:1rem/1.6 system-ui,sans-serif;max-width:70rem;margin:2rem auto;padding:0 1rem}a{overflow-wrap:anywhere}section{border-top:1px solid #aaa;padding:1rem 0}code{overflow-wrap:anywhere}</style><main><h1>Kiroku dependency notices</h1><p>Exact publisher text copies for the distributed code, fonts and runtime assets. <a href="inventory.json">Version and text-hash inventory</a></p>${inventory.limitations.map(text => `<p>${escape(text)}</p>`).join('')}${inventory.dependencies.map(item => `<section><h2>${escape(item.name)} — ${escape(item.version)}</h2>${item.provenance ? `<p>${escape(item.provenance)}</p>` : ''}<p>Asset relationship: ${(item.assets ?? []).map(escape).join(', ')}</p><ul>${item.notices.map(notice => `<li><a href="${escape(notice.file)}">${escape(notice.file)}</a> · <a href="${escape(notice.source)}">Publisher source</a><br><code>SHA256 ${escape(notice.sha256)}</code></li>`).join('')}</ul></section>`).join('')}</main></html>\n`
}

export function dependencyNotices(): Plugin {
  let root: string
  let inventory: Inventory
  return {
    name: 'kiroku-dependency-notices',
    apply: 'build',
    configResolved(config) { root = config.root },
    buildStart() { inventory = validateNoticeInventory(root) },
    generateBundle(_options, bundle) {
      const assets = new Map<string, Set<string>>()
      const add = (name: string, file: string) => { if (!assets.has(name)) assets.set(name, new Set()); assets.get(name)!.add(file) }
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') for (const id of Object.keys(output.modules)) {
          const name = id.replaceAll('\\', '/').match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]
          if (name) {
            if (!inventory.dependencies.some(item => item.name === name)) throw new Error(`Bundled package lacks notice inventory: ${name}`)
            add(name, output.fileName)
          }
        }
        if (/jetbrains-mono.*\.woff2$/.test(output.fileName)) add('@fontsource-variable/jetbrains-mono', output.fileName)
        if (/sql-wasm.*\.wasm$/.test(output.fileName)) add('sql.js', output.fileName)
      }
      const emitted: Inventory = { ...inventory, dependencies: inventory.dependencies.map(item => {
        const name = item.includedBy ?? item.name
        const files = workerPackages.includes(name) && name !== 'workbox-window' ? ['workbox-*.js'] : [...(assets.get(name) ?? [])].sort()
        if (!files.length) throw new Error(`Notice asset relationship is stale: no emitted asset for ${item.name}`)
        return { ...item, assets: files }
      }) }
      for (const item of emitted.dependencies) for (const notice of item.notices) this.emitFile({ type: 'asset', fileName: `notices/${notice.file}`, source: verifyBytes(join(root, 'third-party/notices', notice.file), notice.sha256) })
      this.emitFile({ type: 'asset', fileName: 'notices/inventory.json', source: JSON.stringify(emitted, null, 2) + '\n' })
      this.emitFile({ type: 'asset', fileName: 'notices/index.html', source: indexPage(emitted) })
    },
  }
}

export function verifyDistributedNotices(root: string) {
  validateNoticeInventory(root)
  const dist = join(root, 'dist')
  const inventory: Inventory = JSON.parse(readFileSync(join(dist, 'notices/inventory.json'), 'utf8'))
  const files = readdirSync(dist)
  const worker = files.filter(file => /^workbox-.*\.js$/.test(file)).map(file => readFileSync(join(dist, file), 'utf8')).join('\n')
  const markers = [...new Set(worker.match(/workbox:[a-z-]+:[0-9.]+/g))]
  if (!markers.length) throw new Error('Generated Workbox runtime is missing')
  for (const marker of markers) if (!inventory.dependencies.some(item => item.name === `workbox-${marker.split(':')[1]}`)) throw new Error(`Generated runtime lacks a notice: ${marker}`)
  const serviceWorker = readFileSync(join(dist, 'sw.js'), 'utf8')
  const noticeFiles = ['index.html', 'inventory.json', ...new Set(inventory.dependencies.flatMap(item => item.notices.map(notice => notice.file)))]
  for (const file of noticeFiles) if (!serviceWorker.includes(`notices/${file}`)) throw new Error(`Offline precache omits notice: ${file}`)
  for (const item of inventory.dependencies) for (const notice of item.notices) verifyBytes(join(dist, 'notices', notice.file), notice.sha256)
  console.log(`Dependency notices verified: ${inventory.dependencies.length} records, ${noticeFiles.length - 2} exact text copies, offline precache present. Provenance limitations remain recorded.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv[2] === '--check') validateNoticeInventory(root)
  else if (process.argv[2] === '--verify-dist') verifyDistributedNotices(root)
  else throw new Error('Use --check or --verify-dist')
}
