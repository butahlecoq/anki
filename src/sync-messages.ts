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
  | { state: 'complete'; accepted: number; media?: { uploaded: number; downloaded: number; pending: number; uploadError?: string; downloadError?: string }; conflicts?: number }
  | { state: 'incomplete'; accepted: number; pendingOperations: number; remoteChangesPending: boolean; pendingIncomingOperations?: number; dependencyProblem?: 'deck-cycle' }
  | { state: 'authentication-required' }
  | { state: 'upgrade-required'; target: 'this-device' | 'pc-service' }
  | { state: 'collection-generation-required'; message: string }
  | { state: 'backup-failed'; message: string }
  | { state: 'unreachable' }
  | { state: 'error'; message?: string }

export type PairOutcome = 'paired' | 'unreachable' | 'pairing-error' | 'collection-generation-required'

/** Shown before a device has ever been paired. */
export const SYNC_LOCAL_ONLY = 'This collection stays on this device until you connect a PC.'

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function incomingDependencyMessage(count: number, moreRemoteChanges?: boolean): string {
  const next = moreRemoteChanges === true ? 'More changes are waiting from the PC; tap Sync now to continue.'
    : moreRemoteChanges === false ? 'Sync the sending device, then tap Sync now to continue. Your local work and received changes remain on this device.'
    : 'Tap Sync now to continue. Your local work and received changes remain on this device.'
  return `${plural(count, 'received change')} waiting for related records from the PC. ${next}`
}

export function syncOutcomeMessage(result: SyncOutcome): string {
  if (result.state === 'complete') {
    const media = result.media
    const error = media?.uploadError ?? media?.downloadError
    const conflicts = result.conflicts ? ` ${plural(result.conflicts, 'conflict')} need review.` : ''
    if (error === 'authentication-required') return `Card sync complete. ${plural(media?.pending ?? 0, 'media file')} still need pairing.${conflicts}`
    if (error) return `Card sync complete. ${plural(media?.pending ?? 0, 'media file')} will retry when the PC is reachable.${conflicts}`
    return `Sync complete. ${plural(result.accepted, 'local change')} sent; ${media?.uploaded ?? 0} uploaded and ${media?.downloaded ?? 0} downloaded.${conflicts}`
  }
  if (result.state === 'incomplete') {
    if (result.dependencyProblem === 'deck-cycle') return 'Sync saved progress, but received decks contain a deck parent cycle. Correct the hierarchy on the sending device, sync it, then tap Sync now here. Your local work and received changes remain on this device.'
    if (result.pendingIncomingOperations) return `Sync saved progress after sending ${plural(result.accepted, 'local change')}. ${plural(result.pendingOperations, 'local change')} remain. ${incomingDependencyMessage(result.pendingIncomingOperations, result.remoteChangesPending)}`
    const remote = result.remoteChangesPending ? ' More changes are waiting from the PC.' : ''
    return `Sync saved progress after sending ${plural(result.accepted, 'local change')}. ${plural(result.pendingOperations, 'local change')} remain; tap Sync now to continue.${remote}`
  }
  if (result.state === 'authentication-required') return 'This device needs to be paired again before it can sync.'
  if (result.state === 'collection-generation-required') return result.message
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
  if (result === 'collection-generation-required') return 'The PC collection was replaced from a backup. This device’s offline collection and queued changes remain unchanged; export them before recovering or resetting this device.'
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
