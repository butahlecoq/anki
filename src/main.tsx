import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import '@fontsource-variable/jetbrains-mono'
import { App } from './App'
import { OFFLINE_READY_EVENT, OFFLINE_UNAVAILABLE_EVENT, UPDATE_READY_EVENT } from './appEvents'
import { setActivateWaitingWorker } from './service-worker-update'
import './styles.css'

const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT))
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent(OFFLINE_READY_EVENT))
  },
  onRegisterError() {
    window.dispatchEvent(new CustomEvent(OFFLINE_UNAVAILABLE_EVENT))
  },
})
setActivateWaitingWorker(updateServiceWorker)

const root = document.getElementById('root')

if (!root) throw new Error('Application root is missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
