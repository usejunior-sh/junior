import type { ItemEvent } from '../../../../shared/protocol.js'
import { relTime } from '../../itemUi.js'
import { isStage, STAGE_LABEL, isTurn, TURN_LABEL } from '../../../../core/work/flow.js'

const EVENT_LABEL: Record<string, string> = {
  created: 'surfaced',
  updated: 'new activity',
  reopened: 'reopened',
  done: 'marked done',
  archived: 'archived',
  snoozed: 'snoozed',
  woken: 'snooze ended',
  moved: 'moved',
  'flow-set': 'turn set',
}

/** A stage/turn event's one line: "Ready · My turn", "Waiting on others, Niraj", "back to automatic". */
function flowLine(ev: ItemEvent): string | undefined {
  const d = ev.detail ?? {}
  if (ev.event === 'moved') {
    const to = d.to as { stage?: string; turn?: string } | undefined
    if (!to) return undefined
    const stage = isStage(to.stage) ? STAGE_LABEL[to.stage] : to.stage
    const turn = isTurn(to.turn) ? TURN_LABEL[to.turn] : to.turn
    return `${stage} · ${turn}${typeof d.ask === 'string' ? ` — ${d.ask}` : ''}`
  }
  if (ev.event === 'flow-set') {
    if (d.cleared) return 'back to automatic'
    const parts = [isStage(d.stage) ? STAGE_LABEL[d.stage] : null, isTurn(d.turn) ? TURN_LABEL[d.turn] : null].filter(Boolean)
    return `${parts.join(' · ')}${typeof d.note === 'string' ? ` — ${d.note}` : ''}`
  }
  return undefined
}

function actorLabel(actor: string): string {
  if (actor === 'user') return 'you'
  if (actor === 'system') return 'system'
  if (actor === 'agent' || actor.startsWith('agent:')) return 'an agent'
  if (actor.startsWith('job:')) return 'a job run'
  return actor
}

export function ItemTimeline({ events }: { events: ItemEvent[] | null }) {
  return (
    <>
      <div className="secLabel mute">Timeline</div>
      {events === null ? (
        <div className="asideEmpty">Loading…</div>
      ) : events.length === 0 ? (
        <div className="asideEmpty">No history recorded.</div>
      ) : (
        <div className="tl">
          {[...events].reverse().map((ev) => {
            const why = typeof ev.detail?.why === 'string' ? ev.detail.why : undefined
            const reason = typeof ev.detail?.reason === 'string' ? ev.detail.reason : flowLine(ev)
            return (
              <div key={ev.seq} className="tlRow" title={new Date(ev.at).toLocaleString()}>
                <span className="when">{relTime(ev.at)}</span>
                <span>
                  {EVENT_LABEL[ev.event] ?? ev.event} <span className="who">· {actorLabel(ev.actor)}</span>
                  {(why || reason) && <span className="why">{why ?? reason}</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
