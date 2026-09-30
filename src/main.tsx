import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import '@fontsource-variable/jetbrains-mono'
import { App } from './App'
import { UPDATE_READY_EVENT } from './appEvents'
import './styles.css'

registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT))
  },
})

const root = document.getElementById('root')

if (!root) throw new Error('Application root is missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
