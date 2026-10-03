export type ActivateWaitingWorker = (reloadPage?: boolean) => Promise<void>

let activateWaitingWorker: ActivateWaitingWorker | undefined

export function setActivateWaitingWorker(activate: ActivateWaitingWorker | undefined) {
  activateWaitingWorker = activate
}

export async function activateAvailableUpdate(): Promise<boolean> {
  if (!activateWaitingWorker) return false
  await activateWaitingWorker(true)
  return true
}
