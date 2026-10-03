import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface NativeAnkiUpstreamBoundary {
  syncVersionMin: number
  syncVersionMax: number
  schemaMinVersion: number
}

function rustU8Constants(source: string, file: string) {
  const constants = new Map<string, string>()
  const declarations = /\bconst\s+([A-Z][A-Z0-9_]*)\s*:\s*[^=;]+?\s*=\s*([^;]+);/g
  for (const match of source.matchAll(declarations)) constants.set(match[1], match[2].trim())
  const resolve = (name: string, seen = new Set<string>()): number => {
    if (seen.has(name)) throw new Error(`Cyclic Rust constant alias for ${name} in ${file}.`)
    const value = constants.get(name)
    if (!value) throw new Error(`Rust constant ${name} was not found in ${file}.`)
    const numeric = value.match(/^(?:\(\s*)?(\d+)(?:_u\d+)?\s*\)?$/)
    if (numeric) return Number(numeric[1])
    const alias = value.match(/^(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Z][A-Z0-9_]*)$/)
    if (!alias) throw new Error(`Rust constant ${name} has an unsupported value (${value}) in ${file}.`)
    seen.add(name)
    return resolve(alias[1], seen)
  }
  return resolve
}

export function parseNativeAnkiUpstreamBoundary(versionSource: string, upgradesSource: string): NativeAnkiUpstreamBoundary {
  const resolveVersion = rustU8Constants(versionSource, 'rslib/src/sync/version.rs')
  const resolveSchema = rustU8Constants(upgradesSource, 'rslib/src/storage/upgrades/mod.rs')
  return {
    syncVersionMin: resolveVersion('SYNC_VERSION_MIN'),
    syncVersionMax: resolveVersion('SYNC_VERSION_MAX'),
    schemaMinVersion: resolveSchema('SCHEMA_MIN_VERSION'),
  }
}

export function readNativeAnkiUpstreamBoundary(root: string): NativeAnkiUpstreamBoundary {
  return parseNativeAnkiUpstreamBoundary(
    readFileSync(join(root, 'rslib', 'src', 'sync', 'version.rs'), 'utf8'),
    readFileSync(join(root, 'rslib', 'src', 'storage', 'upgrades', 'mod.rs'), 'utf8'),
  )
}

export function supportsNativeAnkiCurrentBoundary(boundary: NativeAnkiUpstreamBoundary) {
  return boundary.syncVersionMin <= 10 && boundary.syncVersionMax >= 10 && boundary.schemaMinVersion <= 11
}

export function nativeAnkiBoundaryReport(boundary: NativeAnkiUpstreamBoundary) {
  const lines = [
    'Baseline verified with Anki 26.9.3: SYNC_VERSION_MIN=8, SYNC_VERSION_MAX=11, SCHEMA_MIN_VERSION=11',
    `Latest upstream checkout: SYNC_VERSION_MIN=${boundary.syncVersionMin}, SYNC_VERSION_MAX=${boundary.syncVersionMax}, SCHEMA_MIN_VERSION=${boundary.schemaMinVersion}`,
    `Protocol 10 supported: ${boundary.syncVersionMin <= 10 && boundary.syncVersionMax >= 10}`,
    `Schema 11 supported: ${boundary.schemaMinVersion <= 11}`,
  ]
  const baseline = { SYNC_VERSION_MIN: 8, SYNC_VERSION_MAX: 11, SCHEMA_MIN_VERSION: 11 }
  const latest = { SYNC_VERSION_MIN: boundary.syncVersionMin, SYNC_VERSION_MAX: boundary.syncVersionMax, SCHEMA_MIN_VERSION: boundary.schemaMinVersion }
  const diff = Object.keys(baseline).flatMap((key) => baseline[key as keyof typeof baseline] === latest[key as keyof typeof latest]
    ? []
    : [`- ${key}=${baseline[key as keyof typeof baseline]}`, `+ ${key}=${latest[key as keyof typeof latest]}`])
  lines.push('Boundary constant diff:', ...(diff.length ? diff : ['No boundary constant changes.']))
  return lines.join('\n')
}
