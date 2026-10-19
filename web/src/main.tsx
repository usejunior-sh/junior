import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { initAppearance } from './appearance.js'
import { trackInputModality } from './inputModality.js'
import { store } from './store.js'
import { installWorkspaceFetch } from './workspaceUrl.js'
import { trackViewport } from './viewport.js'
import './styles/tokens.css'
import './styles/shell.css'
import './styles/inbox.css'
import './styles/session.css'
import './styles/teams.css'
import './styles/chat.css'
import './styles/overlays.css'
import './styles/lists.css'
import './styles/settings.css'
import './styles/panels.css'
import './styles/mentions.css'
import './styles/artifacts.css'
import './styles/artifact-card.css'
import './styles/artifact-viewer.css'
import './styles/artifact-page.css'
import './styles/jobs.css'
import './styles/changes.css'
import './styles/phone.css'
import './styles/goals.css'
import './styles/phone-touch.css'
import './styles/actions.css'
import './styles/ultracode.css'
import './junior.css'

// This tab's workspace comes from its own URL (`/w/<id>/`), so two tabs can
// hold two workspaces at once. Tag every request before anything can fetch.
installWorkspaceFetch()
// Apply the saved theme/font before the first paint, so there is no
// flash of the default dark theme when a light-theme user loads the page.
initAppearance()
trackViewport()
trackInputModality()
store.connect()
// Phones suspend background tabs and drop their sockets: reconnect the moment
// the page is looked at again, not on the next retry tick.
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && store.resume())
window.addEventListener('online', () => store.resume())
window.addEventListener('pageshow', (e) => e.persisted && store.resume())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
