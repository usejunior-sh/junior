/**
 * The chat's tool rail (variant I, artifact 9d492a83): a 48px column on the
 * right, the one home for a chat's tools on a desktop. The sidebar toggle on
 * top, then the tabs it switches (Changes, Artifacts, Background agents,
 * Browser), and at the foot where the chat runs (Open in) and what it has cost.
 */
import { FileDiff, FileText, PanelRight } from 'lucide-react'
import type { SessionSummary } from '../../../shared/protocol.js'
import type { AgentRun } from '../agents.js'
import { AgentsIcon, BrowserButton, OpenIn, agentsTitle } from '../app/ChatHeader.js'
import { useSessionArtifacts } from '../artifactsClient.js'
import { chatSide, useChatSide } from '../chatSide.js'
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
  return (
    <nav className="toolRail" aria-label="Chat tools">
      {/* As tall as the chat's header and the sidebar's, with the same bottom line, so the three read as one. */}
      <div className="trHead">
        <button
          type="button"
          className={`ib${side ? ' on' : ''}`}
          title={side ? 'Hide the sidebar (⌘⌥B)' : 'Show the sidebar (⌘⌥B)'}
          aria-label={side ? 'Hide the sidebar' : 'Show the sidebar'}
          aria-pressed={!!side}
          onClick={() => chatSide.toggleOpen(current.id)}
        >
          <PanelRight size={15} aria-hidden="true" />
        </button>
      </div>
      {current.checkoutId && (
        <button
          type="button"
          className={`ib tab${side === 'changes' ? ' on' : ''}`}
          title={`Changes in this folder · ${changed}`}
          aria-label={`Changes in this folder, ${changed}`}
          aria-pressed={side === 'changes'}
          onClick={() => chatSide.toggle(current.id, 'changes')}
        >
          <FileDiff size={15} aria-hidden="true" />
          {changed > 0 && <span className="ibCount">{changed}</span>}
        </button>
      )}
      <button
        type="button"
        className={`ib tab${side === 'artifacts' ? ' on' : ''}`}
        title={`Artifacts from this chat · ${artifacts}`}
        aria-label={`Artifacts from this chat, ${artifacts}`}
        aria-pressed={side === 'artifacts'}
        onClick={() => chatSide.toggle(current.id, 'artifacts')}
      >
        <FileText size={15} aria-hidden="true" />
        {artifacts > 0 && <span className="ibCount">{artifacts}</span>}
      </button>
      {agents.length > 0 && (
        <button
          type="button"
          className={`ib tab${side === 'agents' ? ' on' : ''}`}
          title={agentsTitle(agents)}
          aria-label={`Background agents, ${agents.length}`}
          aria-pressed={side === 'agents'}
          onClick={() => chatSide.toggle(current.id, 'agents')}
        >
          <AgentsIcon agents={agents} />
        </button>
      )}
      <BrowserButton sessionId={current.id} open={browserOpen} className="tab" />
      <span className="trGap" />
      <OpenIn current={current} checkout={checkout} newTerminalIn={newTerminalIn} align="end" />
      <SessionCost sessionId={current.id} status={current.status} workflows={current.workflows} compact />
    </nav>
  )
}
