/**
 * Pinning a thread to the sidebar: one flag on the session, kept by the server
 * per workspace (`set_pinned`), so every window and the phone see the same
 * Pinned list. A pin never lapses; only you take it off.
 */
import { Pin, PinOff } from 'lucide-react'
import type { ReactElement } from 'react'
import { store } from '../store.js'
import { CtxMenu, CtxMenuContent, CtxMenuItem, CtxMenuTrigger } from '../ui/Menu.js'

export function setThreadPinned(sessionId: string, pinned: boolean): void {
  store.send({ type: 'set_pinned', sessionId, pinned })
}

const words = (pinned: boolean) => (pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar')

/** The pin icon: pins the thread; filled while pinned, and a click unpins it. */
export function PinThreadButton({ id, pinned, size = 15, className }: { id: string; pinned: boolean; size?: number; className?: string }) {
  return (
    <button
      type="button"
      className={`iconBtn pinThread${pinned ? ' on' : ''}${className ? ` ${className}` : ''}`}
      title={words(pinned)}
      aria-label={words(pinned)}
      aria-pressed={pinned}
      onClick={(e) => {
        e.stopPropagation()
        setThreadPinned(id, !pinned)
      }}
    >
      <Pin size={size} aria-hidden="true" />
    </button>
  )
}

/** A thread's row, with Pin or Unpin on right-click (a long press on a phone). */
export function ThreadPinMenu({ id, pinned, children }: { id: string; pinned: boolean; children: ReactElement }) {
  return (
    <CtxMenu>
      <CtxMenuTrigger asChild>{children}</CtxMenuTrigger>
      <CtxMenuContent>
        <CtxMenuItem onSelect={() => setThreadPinned(id, !pinned)}>
          {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
          {words(pinned)}
        </CtxMenuItem>
      </CtxMenuContent>
    </CtxMenu>
  )
}
