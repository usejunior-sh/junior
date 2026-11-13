/**
 * Pull requests (.docs/redesign-b2-plan.md, Phase 4): yours and the ones
 * waiting on your review, one page, one button a row. A row an agent is on
 * says so and opens its thread. The button hands the PR to Junior in plain
 * words ("Review #477 for me"), the same as typing it: Junior reads it back
 * and starts the thread. Anything that goes out (a push, a comment, a merge)
 * still waits on its own approval card.
 */
import { ExternalLink } from 'lucide-react'
import { useMemo } from 'react'
import { JUNIOR_DM, findDm } from '../../../core/junior/dms.js'
import type { ScoredItem } from '../../../core/work/types.js'
import type { SessionSummary } from '../../../shared/protocol.js'
import { useChatAgents } from '../chatAgents.js'
import { itemHash, useSessions } from '../hooks.js'
import { useInbox } from '../inboxStore.js'
import { usePersona } from '../junior.js'
import { isWorking } from '../sessionModes.js'
import { store } from '../store.js'
import { JuniorFace } from './JuniorFace.js'
import { useOpenThread } from './ThreadCards.js'

const prNumber = (url: string): string | null => /\/pull\/(\d+)/.exec(url)?.[1] ?? null

/** What state the PR is in, in a few words: red checks, conflicts, threads, draft. */
function stateLine(i: ScoredItem): { text: string; bad: boolean } {
  const s = i.seen
  const parts: string[] = []
  let bad = false
  if (s?.red.length || i.ciFailing) {
    parts.push(s?.red.length ? `CI failing: ${s.red.slice(0, 2).join(', ')}${s.red.length > 2 ? ` +${s.red.length - 2}` : ''}` : 'CI failing')
    bad = true
  }
  if (s?.rebase === 'conflict') {
    parts.push('merge conflict')
    bad = true
  } else if (s?.rebase === 'behind') parts.push('behind the base branch')
  const threads = (s?.people ?? 0) + (s?.bots ?? 0)
  if (threads) parts.push(`${threads} open thread${threads === 1 ? '' : 's'}`)
  if (s?.draft || i.isDraft) parts.push('draft')
  if (!parts.length) parts.push(i.reason === 'review-requested' ? `${i.author} asked for your review` : 'Nothing blocking')
  return { text: parts.join(' · '), bad }
}

/** The thread working on this PR right now, if one is: a live session linked to the item. */
function workingOn(i: ScoredItem, sessions: readonly SessionSummary[]): SessionSummary | undefined {
  return sessions.filter((s) => s.itemId === i.id && s.kind !== 'brief').sort((a, b) => b.updatedAt - a.updatedAt).find((s) => isWorking(s) || s.waiting)
}

export function PullRequestsPage({ onNavigate }: { onNavigate: (hash: string) => void }) {
  const inbox = useInbox()
  const sessions = useSessions()
  const agents = useChatAgents()
  const persona = usePersona()
  const openThread = useOpenThread()

  const { mine, reviews } = useMemo(() => {
    const prs = inbox.items.filter((i) => i.reason === 'your-pr' || i.reason === 'review-requested')
    return {
      mine: prs.filter((i) => i.reason === 'your-pr').sort((a, b) => Number(stateLine(b).bad) - Number(stateLine(a).bad) || b.score - a.score),
      reviews: prs.filter((i) => i.reason === 'review-requested').sort((a, b) => b.score - a.score),
    }
  }, [inbox.items])

  const labelOf = (agent?: string) => (agent ? agents.find((a) => a.name === agent)?.label ?? agent : persona.name)
  const colourOf = (agent?: string) => (agent ? agents.find((a) => a.name === agent)?.colour ?? undefined : undefined)

  /** Hand a PR to Junior in words, as if typed: Junior reads it back and starts the thread. */
  const handOff = (text: string) => {
    const dm = findDm(sessions, JUNIOR_DM)
    // Before Junior's chat exists, its first box opens instead: nothing is sent for you.
    if (dm) store.send({ type: 'user_message', sessionId: dm.id, text })
    onNavigate('/junior')
  }

  const row = (i: ScoredItem, review: boolean) => {
    const n = prNumber(i.url)
    const ref = n ? `#${n}` : i.title
    const st = stateLine(i)
    const on = workingOn(i, sessions)
    return (
      <li key={i.id} className="prRow">
        <span className="prNum">{n ? `#${n}` : ''}</span>
        <span className="prT">
          <button type="button" className="prTitle" onClick={() => onNavigate(itemHash(i.id))}>
            {i.title}
          </button>
          <span className={st.bad ? 'bad' : ''}>
            {i.repo} · {st.text}
          </span>
        </span>
        <a className="tsIcon" href={i.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
          <ExternalLink size={14} aria-hidden="true" />
        </a>
        {on ? (
          <button type="button" className="prOn" onClick={() => openThread(on.id)} title={on.title}>
            <JuniorFace mood={on.waiting ? 'needs' : 'working'} size={18} motion="still" colour={colourOf(on.agent)} decorative />
            {on.waiting ? `${labelOf(on.agent)} needs you` : `${labelOf(on.agent)} is on it`}
          </button>
        ) : review ? (
          <button type="button" className="btn primary sm" onClick={() => handOff(`Review ${ref} for me. ${i.url}`)}>
            Review it for me
          </button>
        ) : st.bad ? (
          <button type="button" className="btn primary sm" onClick={() => handOff(`Get ${ref} green. ${i.url}`)}>
            Get it green
          </button>
        ) : (
          <button type="button" className="btn sm" onClick={() => onNavigate(itemHash(i.id))}>
            Open
          </button>
        )}
      </li>
    )
  }

  return (
    <div className="page prPage">
      <div className="inner">
        <h1 className="prH1">Pull requests</h1>
        <p className="prSub">Yours, and the ones waiting on your review. Nothing goes out until you approve it.</p>

        <h2 className="agH">
          Mine <span className="tsN">{mine.length}</span>
        </h2>
        {mine.length ? <ul className="prList">{mine.map((i) => row(i, false))}</ul> : <p className="agEmpty">{inbox.loaded ? 'No open PRs of yours.' : 'Loading…'}</p>}

        <h2 className="agH">
          Waiting on your review <span className="tsN">{reviews.length}</span>
        </h2>
        {reviews.length ? <ul className="prList">{reviews.map((i) => row(i, true))}</ul> : <p className="agEmpty">{inbox.loaded ? 'Nobody is waiting on your review.' : 'Loading…'}</p>}
      </div>
    </div>
  )
}
