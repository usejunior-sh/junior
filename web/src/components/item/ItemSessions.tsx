import { runFileHash } from '../RunFolderPage.js'
import { ChevronRight } from 'lucide-react'
import type { RunState, Link, SessionsUsage } from '../../../../shared/protocol.js'
import { tokens, money } from '../../usageFormat.js'
import { useCheckouts } from '../../hooks.js'
import { checkoutOf } from '../../checkouts.js'
import type { LinkedSession } from './types.js'

const TEAM_STATE: Record<RunState, string> = {
  proposed: 'needs you · approve the card',
  running: 'running',
  gate: 'needs you · a step is done',
  waiting: 'waiting on the world',
  paused: 'paused',
  stopped: 'stopped',
  done: 'done',
}

export function ItemSessions({ linkedSessions, links, spend, checkouts, onNavigate }: {
  linkedSessions: LinkedSession[]
  links: Link[]
  spend: SessionsUsage | null
  checkouts: ReturnType<typeof useCheckouts>
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

      <div className="secLabel mute">
        Sessions <span className="n">{linkedSessions.length}</span>
      </div>
      {linkedSessions.length === 0 ? (
        <div className="asideEmpty">None yet — Dispatch opens one in the matching project; a brief run is one too.</div>
      ) : (
        linkedSessions.map(({ s, role }) => {
          const live = s.status === 'running' || s.status === 'starting'
          const err = s.status === 'error'
          return (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={`card sessCard${live ? ' run' : err ? ' err' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                onNavigate(s.id)
              }}
            >
              <div className="top">
                <span className="ti">{s.title}</span>
                <span className="rs">
                  {s.teamRun?.role === 'lead' ? (
                    // A team's lead stands for the run: whether it needs you (a card to approve, a gate), is going, or is done.
                    <span className={s.teamRun.state === 'proposed' || s.teamRun.state === 'gate' ? 'needsYou' : undefined}>
                      <span className="role">team lead ·</span> {TEAM_STATE[s.teamRun.state]}
                    </span>
                  ) : (
                    <>
                      <span className="role">{s.teamRun ? 'team worker' : role} ·</span> {s.status}
                    </>
                  )}
                </span>
              </div>
              <div className="me">
                {s.cwd.split('/').pop()}
                {checkoutOf(checkouts, s.checkoutId)?.branch ? ` · ${checkoutOf(checkouts, s.checkoutId)?.branch}` : ''}
                {s.model ? ` · ${s.model}` : ''}
              </div>
              <span className="act">
                {role === 'brief' ? 'Open the run' : 'Re-enter session'} <ChevronRight size={12} aria-hidden="true" />
                {spend?.bySession[s.id] && (
                  <span className="spend" title={`${tokens(spend.bySession[s.id].tokens)} tokens over ${spend.bySession[s.id].messages} messages`}>
                    {money(spend.bySession[s.id].cost)}
                  </span>
                )}
              </span>
            </a>
          )
        })
      )}
    </>
  )
}
