import { type Dispatch, type SetStateAction, useRef, useEffect } from 'react'
import { startJuniorChat } from '../junior.js'
import type { RailSection } from '../components/Rail.js'
import type { Route } from '../hooks.js'
import { anyDialogOpen, isTypingTarget } from '../keys.js'
import { openSettings } from '../settings.js'
import { usePanelWidth } from '../panelWidth.js'
import type { Navigate } from './types.js'

export function useGlobalHotkeys({ route, navigate, newSession, newTerminal, terminalCwd, goTo, currentId, panelSize, setHelpOpen, setPaletteOpen, setComposeSignal }: {
  route: Route
  navigate: Navigate
  newSession: () => void
  newTerminal: (cwd?: string) => void
  terminalCwd: string | undefined
  goTo: (section: RailSection) => void
  currentId: string | null
  panelSize: ReturnType<typeof usePanelWidth>
  setHelpOpen: Dispatch<SetStateAction<boolean>>
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setComposeSignal: Dispatch<SetStateAction<number>>
}) {
  // pending "g" prefix for two-key sequences (g i, g s, g j, g p, g c)
  const goPrefix = useRef<number | undefined>(undefined)

  // Global hotkeys. ⌘K works everywhere (even in inputs); single keys only
  // outside text fields and while no dialog is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen((v) => !v)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen(false)
        openSettings()
        return
      }
      // ⌘J: a new chat with Junior, from anywhere (no other ⌘J in the app or Triage.app's menus).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        if (anyDialogOpen()) return
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen(false)
        startJuniorChat()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        if (isTypingTarget(e) || anyDialogOpen()) return
        e.preventDefault()
        panelSize.toggleCollapsed()
        return
      }
      if (isTypingTarget(e) || anyDialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return

      if (goPrefix.current !== undefined) {
        clearTimeout(goPrefix.current)
        goPrefix.current = undefined
        if (e.key === 'h') return goTo('junior')
        if (e.key === 'i') return goTo('inbox')
        if (e.key === 's') return goTo('sessions')
        if (e.key === 't') return goTo('terminals')
        if (e.key === 'c') return openSettings('connectors')
        if (e.key === 'p') return openSettings('projects')
        if (e.key === 'j') return goTo('jobs')
        if (e.key === 'a') return goTo('actions')
        return // unknown sequence — swallow
      }
      if (e.key === 'g') {
        goPrefix.current = window.setTimeout(() => (goPrefix.current = undefined), 1000)
        return
      }
      if (e.key === 'n') {
        e.preventDefault()
        // In the inbox, `n` is "new work item"; among terminals, a new shell;
        // everywhere else, a new session.
        if (route.page === 'inbox') setComposeSignal((n) => n + 1)
        else if (route.page === 'terminal' || route.page === 'terminals') newTerminal(terminalCwd)
        else if (route.page === 'artifacts' || route.page === 'artifact') navigate('/artifact/new')
        else newSession()
      } else if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, newSession, newTerminal, terminalCwd, goTo, currentId, route.page, panelSize])

  return {  }
}
