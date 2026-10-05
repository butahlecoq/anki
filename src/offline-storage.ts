export type PersistenceResult = 'granted' | 'denied' | 'unsupported'

export async function requestPersistentStorage(storage: StorageManager | undefined = navigator.storage): Promise<PersistenceResult> {
  if (!storage?.persist || !storage.persisted) return 'unsupported'
  try {
    if (await storage.persisted()) return 'granted'
    return await storage.persist() ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value.toFixed(1)} ${unit}`
}

function hasQuotaExceededName(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  const candidate = error as { name?: unknown; cause?: unknown; inner?: unknown }
  return candidate.name === 'QuotaExceededError'
    || hasQuotaExceededName(candidate.cause, seen)
    || hasQuotaExceededName(candidate.inner, seen)
}

export function userFacingStorageError(error: unknown, fallback: string): string {
  if (hasQuotaExceededName(error)) {
    return 'This change could not be saved because device storage is full. The incomplete database write was rolled back. Free space, then export an Anki package or make a verified PC backup before continuing.'
  }
  return error instanceof Error ? error.message : fallback
}
