/**
 * What the sync controls say, and when.
 *
 * The branching lived inside the component, so none of its result states could
 * be asserted without rendering it and driving a live service. Every outcome the
 * service can return is mapped here instead, which is the part a learner reads
 * and the part that must not be wrong.
 */

/** The sync result shapes the client can report. */
export type SyncOutcome =
  | { state: 'complete'; accepted: number; media?: { uploaded: number; downloaded: number; pending: number; uploadError?: string; downloadError?: string } }
  | { state: 'authentication-required' }
  | { state: 'upgrade-required'; target: 'this-device' | 'pc-service' }
  | { state: 'backup-failed'; message: string }
  | { state: 'unreachable' }
  | { state: 'error'; message?: string }

export type PairOutcome = 'paired' | 'unreachable' | 'pairing-error'

/** Shown before a device has ever been paired. */
export const SYNC_LOCAL_ONLY = 'This collection stays on this device until you connect a PC.'

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function syncOutcomeMessage(result: SyncOutcome): string {
  if (result.state === 'complete') {
    const media = result.media
    const error = media?.uploadError ?? media?.downloadError
    if (error === 'authentication-required') return `Card sync complete. ${plural(media?.pending ?? 0, 'media file')} still need pairing.`
    if (error) return `Card sync complete. ${plural(media?.pending ?? 0, 'media file')} will retry when the PC is reachable.`
    return `Sync complete. ${plural(result.accepted, 'local change')} sent; ${media?.uploaded ?? 0} uploaded and ${media?.downloaded ?? 0} downloaded.`
  }
  if (result.state === 'authentication-required') return 'This device needs to be paired again before it can sync.'
  if (result.state === 'upgrade-required') {
    return result.target === 'this-device'
      ? 'This device needs a Kiroku update before it can sync this collection. Update the app, then try again. Your local changes remain on this device.'
      : 'Your PC sync service needs an update before this collection can sync. Update the PC service, then try again. Your local changes remain on this device.'
  }
  if (result.state === 'backup-failed') return result.message
  return 'Your PC service could not be reached. Your changes remain on this device and will retry next time.'
}

export function pairOutcomeMessage(result: PairOutcome): string {
  if (result === 'paired') return 'PC connected. Your collections are ready to sync.'
  if (result === 'unreachable') return 'Your PC service could not be reached. Check its address and that it is running.'
  return 'That pairing code was not accepted. Create a new code on your PC and try again.'
}

/**
 * Whether pairing should close after this outcome. Only a successful pairing
 * does; the learner keeps the form open with their code when it was rejected.
 */
export function pairingClosesOn(result: PairOutcome) {
  return result === 'paired'
}
