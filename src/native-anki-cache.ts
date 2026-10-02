import type { Database } from 'sql.js'
import { decodeHTMLStrict } from 'entities'

/** Native note caches are derived from fields, never authoritative content. */
export function nativeFieldText(field: string): string {
  const stripped = field.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi, '')
    .replace(/<(?:img|audio|video|object|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
      const name = tag.match(/\b(?:src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      return name ? ` ${name[1] ?? name[2] ?? name[3]} ` : ''
    }).replace(/<[^>]*>/g, '')
  // Native entity decoding preserves the original text when an entity is
  // invalid. Do not silently normalize such field contents differently.
  const entity = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi
  if (stripped.replace(entity, '').includes('&') || [...stripped.matchAll(entity)].some(([token]) => decodeHTMLStrict(token) === token)) return stripped
  return decodeHTMLStrict(stripped).replaceAll('\u00a0', ' ')
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
