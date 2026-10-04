import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeAnkiBoundaryReport, parseNativeAnkiUpstreamBoundary, readNativeAnkiUpstreamBoundary, supportsNativeAnkiCurrentBoundary } from './native-anki-upstream-boundary'

function upstreamCheckout() {
  const configured = process.env.ANKI_SOURCE_DIR
  const candidates = [configured, join(process.cwd(), 'upstream', 'anki'), join(process.cwd(), '..', 'anki-upstream')]
    .filter((candidate): candidate is string => Boolean(candidate))
  return candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate))
}

describe('Anki upstream compatibility tripwire', () => {
  it('resolves numeric and aliased u8 constants and reports a boundary diff', () => {
    const boundary = parseNativeAnkiUpstreamBoundary(
      'pub const SYNC_VERSION_MIN: u8 = SYNC_VERSION_08; pub const SYNC_VERSION_08: u8 = 8; pub const SYNC_VERSION_MAX: u8 = 11;',
      'pub(super) const SCHEMA_MIN_VERSION: u8 = 11;',
    )
    expect(boundary).toEqual({ syncVersionMin: 8, syncVersionMax: 11, schemaMinVersion: 11 })
    expect(supportsNativeAnkiCurrentBoundary(boundary)).toBe(true)
    expect(nativeAnkiBoundaryReport(boundary)).toContain('No boundary constant changes.')
  })

  it('rejects a protocol window or minimum schema that excludes this engine', () => {
    expect(supportsNativeAnkiCurrentBoundary({ syncVersionMin: 11, syncVersionMax: 12, schemaMinVersion: 11 })).toBe(false)
    expect(supportsNativeAnkiCurrentBoundary({ syncVersionMin: 8, syncVersionMax: 9, schemaMinVersion: 11 })).toBe(false)
    expect(supportsNativeAnkiCurrentBoundary({ syncVersionMin: 8, syncVersionMax: 11, schemaMinVersion: 12 })).toBe(false)
  })

  it.skipIf(!upstreamCheckout())('keeps protocol 10 and schema 11 inside the latest upstream window', () => {
    const boundary = readNativeAnkiUpstreamBoundary(upstreamCheckout()!)
    expect(supportsNativeAnkiCurrentBoundary(boundary)).toBe(true)
  })
})
