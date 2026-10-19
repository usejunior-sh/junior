import { Globe } from 'lucide-react'
import { type RefObject, useState, useEffect } from 'react'
import type { SessionStatus, SessionSummary } from '../../../shared/protocol.js'
import { useChanges } from '../changesStore.js'
import { checkoutOf } from '../checkouts.js'
import { CheckoutChip } from '../components/CheckoutChip.js'
import { CheckoutMenu } from '../components/CheckoutMenu.js'
import { hasBrowser, browserPane } from '../browser.js'
import { SessionCost } from '../components/SessionCost.js'
import { AgentsMenu } from '../components/Agents.js'
import type { AgentRun } from '../agents.js'
import { EFFORT_LABEL } from '../models.js'
import { shownStatus } from '../sessionModes.js'
import { projectColor } from '../tabs.js'

/** `/Users/you/Code/x` → `~/Code/x`: display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/** `/Users/you/Code/x` → `x`: the header's fallback once the homely path won't fit. */
const folderName = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? p

/**
 * Whether the folder pill has given up the homely path for just the folder name: true once the
 * header can't fit the full path even with the title shrunk to nothing. Measured each resize
 * against the full path (the hidden `.measure` twin of the pill), so switching back doesn't lag
 * behind the header's real slack the way a latched "we're short" flag would.
 */
export function useNarrowFolder(
  headerRef: RefObject<HTMLDivElement | null>,
  shownRef: RefObject<HTMLSpanElement | null>,
  fullRef: RefObject<HTMLSpanElement | null>,
  dep: string,
) {
  const [short, setShort] = useState(false)
  useEffect(() => {
    const header = headerRef.current
    if (!header) return
    const read = () => {
      const extra = (fullRef.current?.scrollWidth ?? 0) - (shownRef.current?.scrollWidth ?? 0)
      // Sub-pixel layout means scrollWidth can sit a hair above clientWidth with nothing actually hidden.
      setShort(header.scrollWidth + extra > header.clientWidth + 1)
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(header)
    return () => ro.disconnect()
  }, [headerRef, shownRef, fullRef, dep])
  return short
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'working',
  idle: 'idle',
  error: 'error',
}

export function ChatHeader({
  current,
  chatHeaderRef,
  folderTextRef,
  folderMeasureRef,
  folderShort,
  modelName,
  currentCheckout,
  newTerminalIn,
  changes,
  agents,
  openAgent,
  showAgent,
  mobile,
  browserOpen,
}: {
  current: SessionSummary
  chatHeaderRef: RefObject<HTMLDivElement | null>
  folderTextRef: RefObject<HTMLSpanElement | null>
  folderMeasureRef: RefObject<HTMLSpanElement | null>
  folderShort: boolean
  modelName: string | undefined
  currentCheckout: ReturnType<typeof checkoutOf>
  newTerminalIn: (checkoutId: string) => void
  changes: ReturnType<typeof useChanges>
  agents: AgentRun[]
  openAgent: AgentRun | null
  showAgent: (toolUseId: string | null) => void
  mobile: boolean
  browserOpen: boolean
}) {
  const shown = shownStatus(current)
  return (
    <div id="chatHeader" ref={chatHeaderRef}>
      <span id="chatTitle" title={current.title}>
        {current.title}
      </span>
      <span className="pills">
        {modelName && (
          <span className="pill" title="Model · effort">
            {modelName}
            {current.effort ? ` · ${EFFORT_LABEL[current.effort].toLowerCase()}` : ''}
          </span>
        )}
        {currentCheckout ? (
          <CheckoutMenu checkout={currentCheckout} onNewTerminal={() => newTerminalIn(currentCheckout.id)}>
            <CheckoutChip
              checkout={currentCheckout}
              projectName={
                changes.projects.find((p) => p.project.id === currentCheckout.projectId)?.project.name ??
                folderName(currentCheckout.path)
              }
              color={projectColor(currentCheckout.projectId)}
              menu
              size="sm"
            />
          </CheckoutMenu>
        ) : (
          <span className="pill mono" title={current.cwd}>
            <span className="t" ref={folderTextRef}>
              {folderShort ? folderName(current.cwd) : homely(current.cwd)}
            </span>
          </span>
        )}
        {!currentCheckout && (
          <span className="pill mono measure" aria-hidden="true">
            <span className="t" ref={folderMeasureRef}>
              {homely(current.cwd)}
            </span>
          </span>
        )}
      </span>
      {agents.length > 0 && (
        <AgentsMenu agents={agents} current={openAgent?.toolUseId} onOpen={showAgent}>
          <button type="button" className="btn sm ghost agentsBtn" title="Every agent this session has spawned">
            Agents <span className="n">{agents.length}</span>
            {agents.some((a) => a.state === 'running') && <span className="dot live" aria-hidden="true" />}
          </button>
        </AgentsMenu>
      )}
      {hasBrowser && !mobile && (
        <button
          type="button"
          className={`btn sm ghost browserBtn${browserOpen ? ' on' : ''}`}
          title={browserOpen ? 'Hide the browser pane' : 'Show this session’s browser — the page the agent checks its work in'}
          aria-pressed={browserOpen}
          onClick={() => browserPane.set(current.id, !browserOpen)}
        >
          <Globe size={14} aria-hidden="true" />
          Browser
        </button>
      )}
      <SessionCost sessionId={current.id} status={current.status} workflows={current.workflows} />
      <span className={`state ${shown.status}`} title={shown.title}>
        <span
          className={`dot ${
            shown.status === 'running' || shown.status === 'starting'
              ? 'live'
              : shown.status === 'error'
                ? 'red'
                : 'green'
          }`}
        />
        {STATUS_LABEL[shown.status]}
      </span>
    </div>
  )
}
