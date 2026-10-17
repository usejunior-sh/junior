/**
 * Outbound actions on the client: the fetch behind the Actions page, an item's
 * Actions list and a transcript's action lines, kept current by the server's
 * `actions_changed` frames, plus the words and glyphs every surface shares,
 * so a record reads the same wherever it shows up.
 */
import {
  ArrowUpFromLine,
  ArrowUpRight,
  GitMerge,
  GitPullRequest,
  Mail,
  Megaphone,
  MessageCircle,
  MessageSquare,
  PenLine,
  Rocket,
  Ticket,
  type LucideProps,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import type {
  ActionKind,
  ActionMoveResponse,
  ActionOverrideResponse,
  ActionsPendingResponse,
  ActionsResponse,
  ActionVerb,
  ActionView,
  KindCount,
} from '../../shared/protocol.js'
import { store } from './store.js'

export const KIND_ICON: Record<ActionKind, ComponentType<LucideProps>> = {
  pr: GitPullRequest,
  comment: MessageSquare,
  ticket: Ticket,
  post: Megaphone,
  message: MessageCircle,
  email: Mail,
  push: ArrowUpFromLine,
  merge: GitMerge,
  release: Rocket,
  update: PenLine,
  other: ArrowUpRight,
}

/** The status pill: what happened to it, in two words at most. */
export const STATUS_TEXT: Record<ActionView['status'], string> = {
  attempted: 'no result yet',
  succeeded: 'went out',
  failed: 'failed',
  denied: 'you denied it',
  needs_you: 'needs you',
  scheduled: 'scheduled',
  sending: 'sending',
  unknown: 'unknown',
  sent_back: 'sent back',
  rejected: 'rejected',
  expired: 'expired',
}

/** The pill's colour (the `.pill` modifiers), one per status. */
export const STATUS_TONE: Record<ActionView['status'], 'green' | 'red' | 'yellow' | 'blue' | 'mute'> = {
  attempted: 'blue',
  succeeded: 'green',
  failed: 'red',
  denied: 'mute',
  needs_you: 'yellow',
  scheduled: 'blue',
  sending: 'blue',
  unknown: 'yellow',
  sent_back: 'mute',
  rejected: 'mute',
  expired: 'mute',
}

/** Who let it run, as a short phrase ("you", "autonomy: never asks", "the job’s grants"). */
export function allowedText(a: ActionView): string {
  switch (a.allowedBy) {
    case 'prompt':
      return a.allowedDetail ? `you · ${a.allowedDetail}` : 'you'
    case 'mode':
      return a.allowedDetail ?? 'the session’s mode'
    case 'rule':
      return a.allowedDetail ?? 'an allow rule'
    case 'policy':
      return a.allowedDetail ? `triage · ${a.allowedDetail}` : 'triage’s policy'
    default:
      return a.status === 'denied' ? 'nobody — denied' : '—'
  }
}

/** Who did it: the session, or the job or team it ran for. */
export function whoText(a: ActionView): string {
  if (a.sessionKind === 'job-run') return `Job · ${a.jobTitle ?? 'run'}`
  if (a.teamRunId) return `Team · ${a.teamLabel ?? 'run'}`
  if (a.sessionKind === 'brief') return 'Brief run'
  return a.sessionTitle ?? 'a session'
}

/** The tool, the way a person names it: "Bash", "Slack · send message". */
export function toolText(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const rest = tool.slice(5)
  const cut = rest.lastIndexOf('__')
  if (cut === -1) return rest
  const server = rest.slice(0, cut).replace(/^claude_ai_/, '').replace(/_/g, ' ')
  return `${server} · ${rest.slice(cut + 2).replace(/[_-]/g, ' ')}`
}

/** Where a link goes, short: "github.com/acme/app/pull/42". */
export const linkText = (url: string): string => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

/** Shorter still, for a one-row stub: "pull/42", "tree/feat", else the host. */
export function shortLink(url: string): string {
  const gh = /github\.com\/[^/]+\/[^/]+\/((?:pull|issues|tree|releases\/tag)\/[^#?]+)/.exec(url)
  if (gh) return gh[1].replace(/\/$/, '')
  return linkText(url).split('/')[0]
}

/** "40s", "12m", "6h", "2d", a span, coarse. */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

/** Where it came from, short: "job x-content", "team Build", the session's title. */
export function originText(a: ActionView): string {
  if (a.sessionKind === 'job-run') return `job ${a.jobTitle ?? ''}`.trim()
  if (a.teamRunId) return `team ${a.teamLabel ?? ''}`.trim()
  if (a.sessionKind === 'brief') return 'brief run'
  return a.sessionTitle ?? 'a session'
}

/** A clock that ticks while something on screen counts down (an undo window). */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [active, everyMs])
  return now
}

export type ActionsQuery = { session?: string; item?: string }

type ActionsState = {
  actions: ActionView[]
  today: { line: string; counts: KindCount[] } | null
  file: { path: string; errors: string[] } | null
  loaded: boolean
  error: string | null
}

const EMPTY: ActionsState = { actions: [], today: null, file: null, loaded: false, error: null }

/**
 * Actions, newest first, all of them, one session's, or one item's (`null`
 * = don't fetch). Refetches when the server says something moved: a frame
 * for another session leaves a session's list alone.
 */
export function useActions(q: ActionsQuery | null): ActionsState & { refresh: () => void } {
  const [state, setState] = useState<ActionsState>(EMPTY)
  const key = q ? `session=${encodeURIComponent(q.session ?? '')}&item=${encodeURIComponent(q.item ?? '')}` : null
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(async () => {
    if (!q) return
    const params = new URLSearchParams()
    if (q.session) params.set('session', q.session)
    if (q.item) params.set('item', q.item)
    try {
      const body = (await (await fetch(`/api/actions${params.toString() ? `?${params}` : ''}`)).json()) as ActionsResponse
      setState(
        body.ok
          ? { actions: body.actions, today: body.today, file: body.file, loaded: true, error: null }
          : (s) => ({ ...s, loaded: true, error: body.error }),
      )
    } catch (err) {
      setState((s) => ({ ...s, loaded: true, error: String(err) }))
    }
  }, [key])

  useEffect(() => {
    setState(EMPTY)
    void load()
    if (!q) return
    const off = store.onActionsChanged((sessionId) => {
      if (q.session && sessionId && sessionId !== q.session) return
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void load(), 200)
    })
    return () => {
      off()
      clearTimeout(timer.current)
    }
  }, [load])

  return { ...state, refresh: () => void load() }
}

/** A row's one-click override, written to the actions file. Resolves to an error message, or null. */
export async function overrideAction(actionId: string, verdict: 'action' | 'not_action'): Promise<string | null> {
  try {
    const res = await fetch('/api/actions/override', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId, verdict }),
    })
    const body = (await res.json()) as ActionOverrideResponse
    return body.ok ? null : body.error
  } catch (err) {
    return String(err)
  }
}

/**
 * A queued action's verb (approve, with edited args; undo; send back; reject;
 * retry). Resolves to the action as it now stands, or the error to show.
 */
export async function actOn(
  verb: ActionVerb,
  id: string,
  body: { args?: Record<string, unknown>; notes?: string; reason?: string } = {},
): Promise<{ ok: true; action: ActionView } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/actions/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...body }),
    })
    const out = (await res.json()) as ActionMoveResponse
    return out.ok ? { ok: true, action: out.action } : { ok: false, error: out.error }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** How many queued actions wait on you. The rail's badge, kept current by `actions_changed`. */
export function usePendingActions(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const body = (await (await fetch('/api/actions/pending')).json()) as ActionsPendingResponse
        if (alive && body.ok) setN(body.needsYou)
      } catch {
        // offline: keep the last count
      }
    }
    void load()
    const off = store.onActionsChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 250)
    })
    return () => {
      alive = false
      off()
      clearTimeout(timer)
    }
  }, [])
  return n
}
