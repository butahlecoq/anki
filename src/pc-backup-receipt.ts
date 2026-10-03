/** Metadata retained locally after this browser verifies a downloaded PC backup. */
export interface VerifiedPcBackupReceipt {
  backupId: string
  createdAt: string
  verifiedAt: string
  reason: 'manual' | 'before-sync'
  changeCount: number
  mediaFiles: number
  mediaBytes: number
  archiveBytes: number
  archiveSha256: string
}

/** Owns the persisted receipt's validity rule for both storage and display. */
export function isVerifiedPcBackupReceipt(value: unknown): value is VerifiedPcBackupReceipt {
  if (!value || typeof value !== 'object') return false
  const receipt = value as Partial<VerifiedPcBackupReceipt>
  const timestamp = (item: unknown) => typeof item === 'string' && Number.isFinite(Date.parse(item))
  const count = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  return typeof receipt.backupId === 'string' && Boolean(receipt.backupId)
    && timestamp(receipt.createdAt) && timestamp(receipt.verifiedAt)
    && (receipt.reason === 'manual' || receipt.reason === 'before-sync')
    && count(receipt.changeCount) && count(receipt.mediaFiles) && count(receipt.mediaBytes) && count(receipt.archiveBytes)
    && typeof receipt.archiveSha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.archiveSha256)
}
