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
