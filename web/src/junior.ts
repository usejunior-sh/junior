/**
 * Junior on the client: the persona (from `hello` and `persona` frames), the
 * Junior page's day (one read, refetched when anything it shows moves), the
 * brief's "while you were away" window, today's plan writes, and starters,
 * a Junior chat with its first message written, waiting for you to send it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  JuniorDay,
  JuniorDayResponse,
  Persona,
  PersonaResponse,
  SessionSummary,
  TodayAddRequest,
  TodayMatchResponse,
  TodayResponse,
} from '../../shared/protocol.js'
import { awayWindow, type SeenState } from '../../core/junior/greeting.js'
import { railMood, type Mood } from '../../core/junior/mood.js'
import { draftStore } from './drafts.js'
import { useInbox } from './inboxStore.js'
import { store } from './store.js'
import { isWorking } from './sessionModes.js'

export function usePersona(): Persona {
  return useSyncExternalStore(store.subscribeStructural, store.getPersona)
}

/** What Junior calls you, read once per page load ("Samar"); null until known or when the Mac has no name. */
let youName: Promise<string | null> | null = null
export function useYouName(): string | null {
  const [you, setYou] = useState<string | null>(null)
  useEffect(() => {
    youName ??= fetch('/api/persona')
      .then((r) => r.json() as Promise<PersonaResponse>)
      .then((b) => (b.ok ? (b.you ?? null) : null))
      .catch(() => null)
    let live = true
    void youName.then((n) => live && setYou(n))
    return () => {
      live = false
    }
  }, [])
  return you
}

/** Save a patch onto the persona. Resolves to the saved persona, or the error to show. */
export async function savePersona(patch: Partial<Persona>): Promise<Persona | string> {
  try {
    const res = await fetch('/api/persona', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    const body = (await res.json()) as PersonaResponse
    if (!body.ok) return body.error
    store.setPersona(body.persona)
    return body.persona
  } catch (err) {
    return String(err)
  }
}

/**
 * A chat with Junior, first message written (or none), waiting for you to
 * send it. The same as every starter in the app. `job` = a "New job:" chat.
 */
export function startJuniorChat(text = '', opts: { intent?: 'job' } = {}) {
  const d = text || opts.intent ? draftStore.create({ text, ...(opts.intent ? { intent: opts.intent } : {}) }) : draftStore.findEmpty() ?? draftStore.create()
  location.hash = `/new/${d.id}`
}

// The brief's window: per browser, per workspace, where *you* were.

const seenKey = (ws: string) => `triage.junior.seen.${ws || 'default'}`

function readSeen(ws: string): SeenState | null {
  try {
    const raw = localStorage.getItem(seenKey(ws))
    const v = raw ? (JSON.parse(raw) as Partial<SeenState>) : null
    return v && typeof v.seenAt === 'number' && typeof v.since === 'number' ? { seenAt: v.seenAt, since: v.since, away: !!v.away } : null
  } catch {
    return null
  }
}

function writeSeen(ws: string, s: SeenState) {
  try {
    localStorage.setItem(seenKey(ws), JSON.stringify(s))
  } catch {
    // storage blocked: the brief covers today instead
  }
}

/**
 * The window the brief covers, fixed when the page opens; while the page is
 * in front, "last seen" keeps moving so the next absence is measured right.
 */
export function useAwayWindow(workspaceId: string): SeenState {
  const [win] = useState(() => {
    const w = awayWindow(readSeen(workspaceId), Date.now())
    writeSeen(workspaceId, w)
    return w
  })
  useEffect(() => {
    const touch = () => {
      if (document.visibilityState !== 'visible') return
      const cur = readSeen(workspaceId) ?? win
      writeSeen(workspaceId, { ...cur, seenAt: Date.now() })
    }
    const t = setInterval(touch, 60_000)
    document.addEventListener('visibilitychange', touch)
    return () => {
      touch()
      clearInterval(t)
      document.removeEventListener('visibilitychange', touch)
    }
  }, [workspaceId, win])
  return win
}

// The day: one read, kept current.

/** What in the session list moves the page: who runs, who waits, which team step. */
const sessionsKey = (ss: readonly SessionSummary[]) =>
  ss.map((s) => `${s.id}:${s.status}:${s.waiting ? 1 : 0}:${s.teamRun?.state ?? ''}:${s.teamRun?.rev ?? ''}`).join('|')

export function useJuniorDay(win: SeenState): { day: JuniorDay | null; error: string | null; reload: () => void } {
  const [day, setDay] = useState<JuniorDay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const opened = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      // The first read of the page opens today: carry-overs, and the morning draft.
      if (!opened.current) {
        opened.current = true
        await fetch('/api/today/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
      }
      const body = (await (await fetch(`/api/junior?since=${win.since}&away=${win.away ? 1 : 0}`)).json()) as JuniorDayResponse
      if (mine !== seq.current) return
      if (body.ok) {
        setDay(body.day)
        setError(null)
      } else setError(body.error)
    } catch (err) {
      if (mine === seq.current) setError(String(err))
    }
  }, [win.since, win.away])

  const soon = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void load(), 250)
  }, [load])

  useEffect(() => {
    void load()
    const offs = [store.onTodayChanged(soon), store.onActionsChanged(soon), store.onInboxChanged(soon), store.onLibraryChanged(soon)]
    return () => {
      offs.forEach((off) => off())
      clearTimeout(timer.current)
    }
  }, [load, soon])

  // Sessions starting, finishing and waiting move Needs you, Right now and the plan's statuses.
  const sessions = useSyncExternalStore(store.subscribeStructural, store.getSessions)
  const key = sessionsKey(sessions)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    soon()
  }, [key, soon])

  return { day, error, reload: () => void load() }
}

async function post<T extends { ok: boolean; error?: string }>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return (await res.json()) as T
}

/** Put an item on today (or a new to-do from `title`). Resolves to an error message, or null. */
export async function addToday(req: TodayAddRequest): Promise<string | null> {
  try {
    const b = await post<TodayResponse>('/api/today/add', { ...req, by: 'you' })
    return b.ok ? null : b.error
  } catch (err) {
    return String(err)
  }
}

export async function removeToday(itemId: string): Promise<string | null> {
  try {
    const b = await post<TodayResponse>('/api/today/remove', { itemId })
    return b.ok ? null : b.error
  } catch (err) {
    return String(err)
  }
}

/** "Draft one from my inbox" on a first open: the morning draft, asked for. */
export async function draftToday(): Promise<string | null> {
  try {
    const b = await post<TodayResponse>('/api/today/open', { force: true })
    return b.ok ? null : b.error
  } catch (err) {
    return String(err)
  }
}

export async function matchToday(q: string): Promise<Extract<TodayMatchResponse, { ok: true }>['match'] | string> {
  try {
    const b = (await (await fetch(`/api/today/match?q=${encodeURIComponent(q)}`)).json()) as TodayMatchResponse
    return b.ok ? b.match : b.error
  } catch (err) {
    return String(err)
  }
}

// The rail's face: the most urgent state, from what the client already holds.

/**
 * needs > stuck > working > hello (core/junior/mood.ts). Needs = a session on
 * a prompt, a send waiting for your OK, a team card or gate; stuck = a failed
 * job, a paused team, a session that errored; working = any session running.
 * Job runs aren't in the client's session list, so the rail misses them; the
 * page's "Right now" line shows them.
 */
export function useRailMood(pendingActions: number): Mood {
  const sessions = useSyncExternalStore(store.subscribeStructural, store.getSessions)
  const inbox = useInbox()
  const stuckAlerts = inbox.alerts.length > 0
  return useMemo(() => {
    const blocked = sessions.filter((s) => s.waiting).length
    const teams = sessions.filter((s) => s.teamRun?.role === 'lead' && (s.teamRun.state === 'proposed' || s.teamRun.state === 'gate')).length
    return railMood({
      needs: blocked + teams + pendingActions,
      stuck: stuckAlerts || sessions.some((s) => s.status === 'error'),
      working: sessions.some(isWorking),
    })
  }, [sessions, pendingActions, stuckAlerts])
}
