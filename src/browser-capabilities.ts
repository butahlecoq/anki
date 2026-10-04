export function supportsServiceWorkers() {
  return typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker)
}
