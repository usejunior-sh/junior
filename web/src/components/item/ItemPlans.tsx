import { runFileHash } from '../RunFolderPage.js'
import type { RunState, Link } from '../../../../shared/protocol.js'
import type { LinkedSession } from './types.js'

export const TEAM_STATE: Record<RunState, string> = {
  proposed: 'needs you · approve the card',
  running: 'running',
  gate: 'needs you · a step is done',
  waiting: 'waiting on the world',
  paused: 'paused',
  stopped: 'stopped',
  done: 'done',
}

/**
 * The side panel's team-run plans: each run's folder (plan, ledger, reviews,
 * handoffs). The sessions themselves are listed in the Sessions tab.
 */
export function ItemPlans({ linkedSessions, links, onNavigate }: {
  linkedSessions: LinkedSession[]
  links: Link[]
  onNavigate: (hash: string) => void
}) {
  return (
    <>
      {/* Team runs: each has a run folder, plan, ledger, reviews, every handoff, read on its page. */}
      {(() => {
        const leads = linkedSessions.filter(({ s: x }) => x.teamRun?.role === 'lead').map(({ s: x }) => x)
        // Runs from before the folder, whose state is gone, still have their Plan artifact.
        const old = leads.length ? [] : links.filter((l) => l.fromKind === 'artifact' && l.role === 'plan')
        if (!leads.length && !old.length) return null
        return (
          <>
            <div className="secLabel mute">Plans</div>
            {leads.map((lead, i) => (
              <button key={lead.id} type="button" className="line planLine" onClick={() => onNavigate(runFileHash(lead.teamRun!.id))}>
                <span className="dash">—</span>
                <span>
                  {lead.teamRun!.goal ? 'Goal plan' : 'Plan'}{leads.length > 1 ? ` ${i + 1}` : ''}
                  <span className={`k${lead.teamRun!.state === 'proposed' || lead.teamRun!.state === 'gate' ? ' needsYou' : ''}`}> · {TEAM_STATE[lead.teamRun!.state]}</span>
                </span>
              </button>
            ))}
            {old.map((l, i) => (
              <button key={l.fromId} type="button" className="line planLine" onClick={() => onNavigate(`/artifact/${l.fromId}`)}>
                <span className="dash">—</span>
                <span>Plan{old.length > 1 ? ` ${i + 1}` : ''}</span>
              </button>
            ))}
          </>
        )
      })()}

    </>
  )
}
