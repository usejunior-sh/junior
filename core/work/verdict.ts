/**
 * The item page's verdict: one sentence on whose turn it is, and the tab the
 * page opens on (redesign artifact 0dcb0d0c, plan a3dcaad8). The line, the
 * default tab and the hand-off bar all read this one answer.
 *
 *   needs you   a task waits on you (yours, or Junior's question), or a send
 *               waits for your OK                      → Needs you
 *   Junior's    a Junior task is queued or running, or a dispatched session
 *               is working (flow turn "ai")           → Sessions
 *   not handed  nobody has it: the item's own ask is the one thing that
 *   off         needs you                             → Needs you
 *
 * Pure, browser-safe.
 */
import { askOf } from './asks.js'
import type { ItemTask } from './tasks.js'
import type { ItemFlow } from './flow.js'
import type { WorkItem } from './types.js'

export type VerdictTurn = 'you' | 'junior' | 'ready' | 'others' | 'idle'
export type ItemTab = 'needs' | 'sessions' | 'activity'

export interface Verdict {
  turn: VerdictTurn
  /** Junior has had this item: a task of its own, or a session working it */
  handedOff: boolean
  /** what the Needs you tab counts */
  needs: number
  say: string
  sub: string
  /** the tab the page opens on */
  tab: ItemTab
}

export type VerdictItem = Pick<WorkItem, 'kind' | 'author' | 'source'> & Partial<Pick<WorkItem, 'ask' | 'status'>> & { flow?: ItemFlow }
export type VerdictTask = Pick<ItemTask, 'owner' | 'state' | 'step' | 'title'>

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const count = (n: number) => WORDS[n] ?? String(n)

/** "Nirajsinh Rajput" → "Nirajsinh"; a manual item or no author → null. */
function who(item: VerdictItem): string | null {
  if (item.source === 'manual') return null
  const first = item.author.trim().replace(/^@/, '').split(/\s+/)[0]
  return first || null
}

/** Nobody has it yet: the line says what the item itself asks of you. */
function ownAsk(item: VerdictItem): string {
  if (item.kind.startsWith('own-pr')) return 'Your PR. Junior isn’t watching it.'
  const name = who(item)
  if (!name) return 'This one’s yours. Nobody’s on it.'
  switch (askOf(item)) {
    case 'reply':
      return `${name} is waiting on your reply.`
    case 'review':
      return `${name} asked for your review.`
    case 'decide':
      return `${name} needs a decision from you.`
    case 'do':
      return `${name} is waiting on you.`
    case 'follow-up':
      return `Follow up with ${name}.`
    default:
      return `${name} sent you this. Nobody’s on it.`
  }
}

export function verdictOf(item: VerdictItem, tasks: readonly VerdictTask[], held: number): Verdict {
  const waiting = tasks.filter((t) => t.state === 'waiting')
  const running = tasks.filter((t) => t.owner === 'junior' && t.state === 'running')
  const busy = running.length > 0 || tasks.some((t) => t.owner === 'junior' && t.state === 'queued') || item.flow?.turn === 'ai'
  const handedOff = tasks.some((t) => t.owner === 'junior') || item.flow?.turn === 'ai'
  const base = { handedOff }

  if (item.status === 'done' || item.status === 'archived')
    return { ...base, turn: 'idle', needs: 0, say: item.status === 'done' ? 'Done.' : 'Archived.', sub: 'Nothing left on it.', tab: 'activity' }

  const needs = waiting.length + held
  if (needs > 0) {
    const rest = busy ? 'Junior is handling the rest.' : 'Nothing else is moving.'
    if (held === 0 && waiting.length === 1 && waiting[0]!.step === 'request-review')
      return { ...base, turn: 'ready', needs, say: 'Ready for review. Pick a reviewer.', sub: 'The request goes out only when you press it.', tab: 'needs' }
    if (held === 0 && waiting.every((t) => t.step === 'send-reply'))
      return {
        ...base,
        turn: 'you',
        needs,
        say: needs === 1 ? 'Junior’s draft is ready. Read it, then send.' : `${count(needs)} drafts are ready to send.`,
        sub: 'Nothing goes out until you press Send.',
        tab: 'needs',
      }
    if (waiting.length === 0)
      return { ...base, turn: 'you', needs, say: held === 1 ? 'One send waits for your OK.' : `${count(held)} sends wait for your OK.`, sub: rest, tab: 'needs' }
    return { ...base, turn: 'you', needs, say: needs === 1 ? 'One thing needs your call.' : `${count(needs)} things need your call.`, sub: rest, tab: 'needs' }
  }

  if (busy)
    return {
      ...base,
      turn: 'junior',
      needs: 0,
      say: 'Junior is on it. Nothing needs you.',
      sub: running.length === 1 ? `Working on: ${running[0]!.title}.` : 'You’ll hear from it if something needs you.',
      tab: 'sessions',
    }

  if (item.flow?.turn === 'others') {
    const name = who(item)
    return { ...base, turn: 'others', needs: 0, say: name ? `Waiting on ${name}.` : 'Waiting on others.', sub: 'Nothing needs you right now.', tab: handedOff ? 'sessions' : 'needs' }
  }

  if (!handedOff) return { ...base, turn: 'you', needs: 1, say: ownAsk(item), sub: 'Hand it to Junior, or do it yourself.', tab: 'needs' }

  return { ...base, turn: 'idle', needs: 0, say: 'Junior’s done for now. Nothing needs you.', sub: 'It picks this up again when something changes.', tab: 'sessions' }
}
