import { useCallback } from 'react'
import type { SessionSummary, TerminalSummary } from '../../../shared/protocol.js'
import { useDrafts } from '../drafts.js'
import { useTerminals } from '../hooks.js'
import { store } from '../store.js'
import { termKey } from './tabs.js'
import type { Navigate, TabsApi } from './types.js'

export function useTerminalActions({ closeTab, currentTerminalId, terminals, navigate, current, currentTerminal, currentDraft }: {
  closeTab: TabsApi['close']
  currentTerminalId: string | null
  terminals: ReturnType<typeof useTerminals>
  navigate: Navigate
  current: SessionSummary | null
  currentTerminal: TerminalSummary | null
  currentDraft: ReturnType<typeof useDrafts>[number] | null
}) {
  // Terminals: open in a folder (the server falls back to home), rename, kill.
  const newTerminal = useCallback((cwd?: string) => {
    store.send({ type: 'terminal_create', cwd })
  }, [])
  const newTerminalIn = useCallback((checkoutId: string) => {
    store.send({ type: 'terminal_create', checkoutId })
  }, [])
  const renameTerminal = useCallback((terminalId: string, title: string) => {
    store.send({ type: 'terminal_rename', terminalId, title })
  }, [])
  const closeTerminal = useCallback(
    (terminalId: string) => {
      store.send({ type: 'terminal_close', terminalId })
      closeTab(termKey(terminalId))
      if (terminalId === currentTerminalId) {
        const rest = terminals.filter((t) => t.id !== terminalId)
        navigate(rest.length ? `/terminal/${rest[rest.length - 1].id}` : '/terminals')
      }
    },
    [closeTab, currentTerminalId, terminals, navigate],
  )
  // Where "+" opens a shell: the folder of whatever tab is in front.
  const terminalCwd = current?.cwd ?? currentTerminal?.cwd ?? currentDraft?.cwd

  return { newTerminal, newTerminalIn, renameTerminal, closeTerminal, terminalCwd }
}
