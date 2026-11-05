/**
 * The chat's tool rail (variant I, artifact 9d492a83): a 48px column on the
 * right, the one home for a chat's tools on a desktop. The sidebar toggle on
 * top, then the tabs it switches (Changes, Artifacts, Background agents,
 * Browser), and at the foot where the chat runs (Open in) and what it has cost.
 */
import { FileDiff, FileText, PanelRight } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SessionSummary } from '../../../shared/protocol.js'
import type { AgentRun } from '../agents.js'
import { AgentsIcon, BrowserButton, OpenIn, agentsTitle } from '../app/ChatHeader.js'
import { useSessionArtifacts } from '../artifactsClient.js'
import { chatSide, useChatSide } from '../chatSide.js'
import { hasBrowser } from '../browser.js'
import { Tooltip } from '../ui/Tooltip.js'
import type { checkoutOf } from '../checkouts.js'
import { SessionCost } from './SessionCost.js'
import { useChatChanges } from './ChatSide.js'

type Props = {
  current: SessionSummary
  checkout: ReturnType<typeof checkoutOf>
  newTerminalIn: (checkoutId: string) => void
  agents: AgentRun[]
  browserOpen: boolean
}

export function ToolRail({ current, checkout, newTerminalIn, agents, browserOpen }: Props) {
  const side = useChatSide(current.id)
  const artifacts = useSessionArtifacts(current.id).length
  const changed = useChatChanges(current.checkoutId)?.files.length ?? 0
  const browserTip = !hasBrowser ? 'Browser · in Junior.app' : browserOpen ? 'Hide the browser' : 'Browser'
  return (
    <nav className="toolRail" aria-label="Chat tools">
      {/* As tall as the chat's header and the sidebar's, with the same bottom line, so the three read as one. */}
      <div className="trHead">
        <RailTip label={side ? 'Hide the sidebar' : 'Show the sidebar'} keys="⌘⌥B">
          <button
            type="button"
            className={`ib${side ? ' on' : ''}`}
            aria-label={side ? 'Hide the sidebar' : 'Show the sidebar'}
            aria-pressed={!!side}
            onClick={() => chatSide.toggleOpen(current.id)}
          >
            <PanelRight size={15} aria-hidden="true" />
          </button>
        </RailTip>
      </div>
      {current.checkoutId && (
        <RailTip label="Changes" note={changed ? `${changed} ${changed === 1 ? 'file' : 'files'} in this folder` : 'nothing uncommitted'}>
          <button
            type="button"
            className={`ib tab${side === 'changes' ? ' on' : ''}`}
            aria-label={`Changes in this folder, ${changed}`}
            aria-pressed={side === 'changes'}
            onClick={() => chatSide.toggle(current.id, 'changes')}
          >
            <FileDiff size={15} aria-hidden="true" />
            {changed > 0 && <span className="ibCount">{changed}</span>}
          </button>
        </RailTip>
      )}
      <RailTip label="Artifacts" note={artifacts ? `${artifacts} from this chat` : 'none from this chat yet'}>
        <button
          type="button"
          className={`ib tab${side === 'artifacts' ? ' on' : ''}`}
          aria-label={`Artifacts from this chat, ${artifacts}`}
          aria-pressed={side === 'artifacts'}
          onClick={() => chatSide.toggle(current.id, 'artifacts')}
        >
          <FileText size={15} aria-hidden="true" />
          {artifacts > 0 && <span className="ibCount">{artifacts}</span>}
        </button>
      </RailTip>
      {agents.length > 0 && (
        <RailTip label="Background agents" note={agentsTitle(agents).replace(/^Background agents · /, '')}>
          <button
            type="button"
            className={`ib tab${side === 'agents' ? ' on' : ''}`}
            aria-label={`Background agents, ${agents.length}`}
            aria-pressed={side === 'agents'}
            onClick={() => chatSide.toggle(current.id, 'agents')}
          >
            <AgentsIcon agents={agents} />
          </button>
        </RailTip>
      )}
      <RailTip label={browserTip}>
        <BrowserButton sessionId={current.id} open={browserOpen} className="tab" bare />
      </RailTip>
      <span className="trGap" />
      <RailTip label="Open in…" note={checkout ? 'Finder, your editor, a terminal' : 'copy the folder path'}>
        <OpenIn current={current} checkout={checkout} newTerminalIn={newTerminalIn} align="end" bare />
      </RailTip>
      <SessionCost sessionId={current.id} status={current.status} workflows={current.workflows} compact />
    </nav>
  )
}

/**
 * The rail's tooltip: the name, a line of what's there, and the key, opening
 * to the left, toward the chat. The span gives Radix a box to anchor on, so a
 * menu trigger inside (Open in) keeps working.
 */
function RailTip({ label, note, keys, children }: { label: string; note?: string; keys?: string; children: ReactNode }) {
  return (
    <Tooltip
      side="left"
      align="center"
      delay={250}
      className="railTip"
      content={
        <>
          <span className="rtName">{label}</span>
          {keys && <span className="rtKeys">{keys}</span>}
          {note && <span className="rtNote">{note}</span>}
        </>
      }
    >
      <span className="trTip">{children}</span>
    </Tooltip>
  )
}
