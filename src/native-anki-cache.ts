import type { Database } from 'sql.js'
import { nativeHtmlEntities } from './native-html-entities.js'

/** Native note caches are derived from fields, never authoritative content. */
export function nativeFieldText(field: string): string {
  const stripped = field.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi, '')
    .replace(/<(?:img|audio|video|object|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
      const name = tag.match(/\b(?:src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      return name ? ` ${name[1] ?? name[2] ?? name[3]} ` : ''
    }).replace(/<[^>]*>/g, '')
  // Native entity decoding preserves the original text when an entity is
  // invalid. Do not silently normalize such field contents differently.
  const entity = /&([^;\s&]+);/g
  let valid = !stripped.replace(entity, '').includes('&')
  const decoded = stripped.replace(entity, (_token, name: string) => {
    const code = name.startsWith('#x') ? (/^#x[0-9a-f]+$/i.test(name) ? Number.parseInt(name.slice(2), 16) : NaN)
      : name.startsWith('#') ? (/^#[0-9]+$/.test(name) ? Number(name.slice(1)) : NaN) : Object.hasOwn(nativeHtmlEntities, name) ? nativeHtmlEntities[name] : NaN
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) { valid = false; return _token }
    return String.fromCodePoint(code)
  })
  return valid ? decoded.replaceAll('\u00a0', ' ') : stripped
}

export async function rebuildNativeNoteCaches(db: Database) {
  const models = JSON.parse(String(db.exec('SELECT models FROM col')[0]?.values[0]?.[0])) as Record<string, { sortf?: number }>
  const rows = db.exec('SELECT id,mid,flds FROM notes')[0]?.values ?? []
  for (const [id, mid, raw] of rows) {
    const fields = String(raw).split('\u001f')
    const first = nativeFieldText(fields[0] ?? '')
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(first))
    const checksum = new DataView(digest).getUint32(0, false)
    const sort = models[String(mid)]?.sortf ?? 0
    if (!Number.isInteger(sort) || sort < 0) throw new Error('Invalid native note sort field.')
    db.run('UPDATE notes SET sfld=?,csum=? WHERE id=?', [nativeFieldText(fields[sort] ?? ''), checksum, id])
  }
}
