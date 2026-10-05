export const UPDATE_READY_EVENT = 'kiroku:update-ready'
export const OFFLINE_READY_EVENT = 'kiroku:offline-ready'
export const OFFLINE_UNAVAILABLE_EVENT = 'kiroku:offline-unavailable'

let updateWaiting = false

export function announceUpdateReady() {
  updateWaiting = true
  window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT))
}

export function isUpdateWaiting() {
  return updateWaiting
}

export function clearUpdateWaiting() {
  updateWaiting = false
}
