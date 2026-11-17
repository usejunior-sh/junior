/**
 * Threads (.docs/redesign-b2-plan.md): a task Junior handed to one of its
 * agents is a chat session it started from its own DM (`startedBy`), talking
 * as that agent (`agent`). The sidebar lists the open ones; each agent's row
 * says what it is doing. Pure and browser-safe; time is an argument.
 *
 * "Open" means it still matters today: it waits on you, it is working, it
 * stopped with an error, or Junior started it in the last 12 hours. Chats you
 * started yourself show only while they wait on you or work.
 */

export type ThreadState = 'you' | 'working' | 'stopped' | 'ready'

/** What this reads of a session (a SessionSummary fits). */
export type ThreadSession = {
  id: string
  title: string
  kind?: string
  agent?: string
  startedBy?: string
  status: string
  waiting?: boolean
  waitingOn?: string
  workflows?: number
  updatedAt: number
  teamRun?: { role: string; state?: string }
  /** a job's run opened it (mode: thread) */
  jobId?: string
  /** put away: a job's run that found nothing new */
  archived?: boolean
}

export type Thread = {
  id: string
  title: string
  /** the agent it talks as; absent = plain Junior */
  agent?: string
  state: ThreadState
  /** Junior started it from its DM */
  fromJunior: boolean
  /** waiting on a question (not a permission or a send) */
  question: boolean
  /** a job's run opened it */
  job: boolean
  updatedAt: number
}

/** How long a finished thread Junior started stays in the list. */
export const READY_FOR_MS = 12 * 3_600_000
/** Threads the sidebar shows before "Show all". */
export const THREADS_SHOWN = 5

const working = (s: ThreadSession) => s.status === 'running' || s.status === 'starting' || (s.workflows ?? 0) > 0
const teamWaits = (s: ThreadSession) => s.teamRun?.role === 'lead' && (s.teamRun.state === 'proposed' || s.teamRun.state === 'gate')
/** Sessions that are conversations: chats and DMs, not brief runs, job runs, goal leads or team workers. */
const isChat = (s: ThreadSession) => (s.kind ?? 'chat') === 'chat' && s.teamRun?.role !== 'worker'

export function threadState(s: ThreadSession): ThreadState {
  if (s.waiting || teamWaits(s)) return 'you'
  if (working(s)) return 'working'
  if (s.status === 'error') return 'stopped'
  return 'ready'
}

const ORDER: Record<ThreadState, number> = { you: 0, stopped: 1, working: 2, ready: 3 }

/** The open threads, yours first, then stopped, working, ready; newest first within each. */
export function openThreads(sessions: readonly ThreadSession[], now: number): Thread[] {
  const dms = new Set(sessions.filter((s) => s.kind === 'dm').map((s) => s.id))
  return sessions
    .filter(isChat)
    .map((s) => ({ s, state: threadState(s), fromJunior: !!s.startedBy && dms.has(s.startedBy) }))
    .filter(({ s, state, fromJunior }) => state === 'you' || state === 'working' || (fromJunior && !s.archived && (state === 'stopped' || now - s.updatedAt < READY_FOR_MS)))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.s.updatedAt - a.s.updatedAt)
    .map(({ s, state, fromJunior }) => ({
      id: s.id,
      title: s.title,
      ...(s.agent ? { agent: s.agent } : {}),
      state,
      fromJunior,
      question: !!s.waiting && s.waitingOn === 'AskUserQuestion',
      job: !!s.jobId,
      updatedAt: s.updatedAt,
    }))
}

/**
 * Every thread that needs you, from every agent and Junior, job runs too: the
 * open threads on your turn, plus each session the needs rows point at
 * (`needing`: a send it drafted, a team's plan), even one that is not held on
 * a prompt. DMs are not threads: their agent's row carries the dot. Newest first.
 */
export function waitingThreads(sessions: readonly ThreadSession[], needing: ReadonlySet<string>, now: number): Thread[] {
  const dms = new Set(sessions.filter((s) => s.kind === 'dm').map((s) => s.id))
  const mine = openThreads(sessions, now).filter((t) => t.state === 'you')
  const have = new Set(mine.map((t) => t.id))
  const more: Thread[] = sessions
    .filter((s) => needing.has(s.id) && !have.has(s.id) && s.kind !== 'dm')
    .map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.agent ? { agent: s.agent } : {}),
      state: 'you' as const,
      fromJunior: !!s.startedBy && dms.has(s.startedBy),
      question: !!s.waiting && s.waitingOn === 'AskUserQuestion',
      job: !!s.jobId,
      updatedAt: s.updatedAt,
    }))
  return [...mine, ...more].sort((a, b) => b.updatedAt - a.updatedAt)
}

export type AgentStatus = { state: 'you' | 'working' | 'idle'; line: string; threads: number }

/**
 * One agent's row: its DM and its threads together. Waiting on you first ("1
 * question for you"), then work in flight ("Working on 2 threads"), else what
 * it is for.
 */
export function agentStatus(agent: string, sessions: readonly ThreadSession[], description: string): AgentStatus {
  const mine = sessions.filter((s) => s.agent === agent && (isChat(s) || s.kind === 'dm'))
  const waiting = mine.filter((s) => s.waiting || teamWaits(s))
  const busy = mine.filter((s) => !s.waiting && working(s) && s.kind !== 'dm')
  const chatting = mine.some((s) => s.kind === 'dm' && !s.waiting && working(s))
  const threads = mine.filter((s) => s.kind !== 'dm').length
  if (waiting.length) {
    const questions = waiting.filter((s) => s.waitingOn === 'AskUserQuestion').length
    const line = questions === waiting.length ? `${questions} question${questions === 1 ? '' : 's'} for you` : `${waiting.length} thing${waiting.length === 1 ? '' : 's'} for you`
    return { state: 'you', line, threads }
  }
  if (busy.length) return { state: 'working', line: `Working on ${busy.length} thread${busy.length === 1 ? '' : 's'}`, threads }
  if (chatting) return { state: 'working', line: 'Replying to you', threads }
  return { state: 'idle', line: description, threads }
}

/** The longest first sentence a thread's report quotes before it cuts. */
const REPORT_MAX = 180

/** The first sentence of a reply, plain text, cut at REPORT_MAX. '' when it said nothing. */
export function threadReportSentence(said: string): string {
  const plain = said
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const first = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain
  return first.length > REPORT_MAX ? `${first.slice(0, REPORT_MAX - 1).trimEnd()}…` : first
}

/**
 * The line Junior's chat gets when a thread it started finishes a turn: who,
 * which thread, and the first sentence of what it said, plain text. A notice,
 * not a message: it is shown, never fed back to the model.
 */
export function threadReportLine(who: string, title: string, said: string): string {
  const cut = threadReportSentence(said)
  return cut ? `${who} replied in "${title}": ${cut}` : `${who} replied in "${title}".`
}
