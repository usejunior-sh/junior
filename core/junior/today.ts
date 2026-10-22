/**
 * Today's plan: one list for you and Junior, per workspace and local day.
 * Every row is a work item with an owner; done comes from the item's own
 * status, so nothing here can disagree with the inbox. Unfinished rows carry
 * to the next day on their own; the first open of a day drafts up to five
 * rows from the carry-overs and the top items on your turn. Pure and
 * browser-safe; time is always an argument.
 */

export type Owner = 'you' | 'junior'
export const isOwner = (v: unknown): v is Owner => v === 'you' || v === 'junior'

/** Who put a row on the plan: you (the page), Junior (a chat's add_to_today), or the morning draft. */
export type AddedBy = 'you' | 'junior' | 'draft'

export type TodayEntry = {
  /** local day, `YYYY-MM-DD` */
  date: string
  itemId: string
  owner: Owner
  addedBy: AddedBy
  addedAt: number
  /** sort key within the day; lower first */
  order: number
  /** the day this row was first planned, when it came over from an earlier day */
  carriedFrom: string | null
}

/** A plan day's own record: when it was first opened and drafted. */
export type TodayDay = { date: string; createdAt: number; draftedAt: number | null }

export const DRAFT_MAX = 5

const pad = (n: number) => String(n).padStart(2, '0')

/** The local day `now` falls in, `YYYY-MM-DD`. */
export function dayKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The rows that come over to `date` from the last planned day: every row
 * whose item is still open, in its old order, marked with the day it was
 * first planned. Done, archived, snoozed and vanished items stay behind.
 */
export function carryOver(prev: readonly TodayEntry[], isOpen: (itemId: string) => boolean, date: string, now: number): TodayEntry[] {
  return [...prev]
    .filter((e) => e.date < date && isOpen(e.itemId))
    .sort((a, b) => a.order - b.order)
    .map((e, i) => ({ ...e, date, order: i, carriedFrom: e.carriedFrom ?? e.date, addedAt: e.addedAt ?? now }))
}

/** What the draft reads of an open item. */
export type DraftCandidate = {
  id: string
  score: number
  /** whose move it is (core/work/flow.ts); only your turn is drafted */
  turn?: string
  group?: string
  kind?: string
  status?: string
}

/**
 * The first open of a day: keep what's already on the plan (the carry-overs,
 * anything added since), then fill up to DRAFT_MAX with the highest-ranked
 * open items on your turn. FYI rows and job digests are reports, not work,
 * and are never drafted. Returns only the rows to add.
 */
export function draftPlan(input: {
  date: string
  now: number
  existing: readonly TodayEntry[]
  candidates: readonly DraftCandidate[]
  max?: number
}): TodayEntry[] {
  const max = input.max ?? DRAFT_MAX
  const room = max - input.existing.length
  if (room <= 0) return []
  const taken = new Set(input.existing.map((e) => e.itemId))
  const start = input.existing.reduce((m, e) => Math.max(m, e.order + 1), 0)
  return [...input.candidates]
    .filter((c) => !taken.has(c.id) && (c.status ?? 'open') === 'open' && c.turn === 'me' && c.group !== 'fyi' && c.kind !== 'digest')
    .sort((a, b) => b.score - a.score)
    .slice(0, room)
    .map((c, i) => ({ date: input.date, itemId: c.id, owner: 'you' as const, addedBy: 'draft' as const, addedAt: input.now, order: start + i, carriedFrom: null }))
}

// The rows as the page shows them

/** What a plan row reads of its item. */
export type PlanItem = {
  id: string
  title: string
  url: string
  source: string
  kind: string
  repo: string
  author: string
  status?: string
  /** when it went done, for "done 06:10" */
  statusAt?: number
  peopleWaiting: number
  createdAt: string
  /** what it asks of you (core/work/asks.ts), when ranked */
  ask?: string
  flow?: { stage: string; turn: string; since: number; next?: string }
  refs?: string[]
  projectId?: string
}

/** What a plan row reads of a session on its item. */
export type PlanSession = {
  id: string
  itemId: string
  running: boolean
  waiting: boolean
  /** "step 2 of 3", from its todo list or its team */
  step: { n: number; of: number } | null
  /** what it is doing now, lower-case ("running the auth test 50 times") */
  activity: string | null
  updatedAt: number
}

export type PlanStatus =
  | { kind: 'done'; at: number | null }
  /** a session on it waits on you: a question or a permission */
  | { kind: 'needs'; sessionId: string }
  | { kind: 'live'; sessionId: string; step: { n: number; of: number } | null; activity: string | null }
  /** a person waits on you for it */
  | { kind: 'waiting'; since: number; who: string | null }
  | { kind: 'carried'; from: string }
  | { kind: 'todo'; note: string | null }

export type PlanRow = {
  itemId: string
  title: string
  /** the source ref, short: "#478", "NOV-140", "#api" */
  ref: string
  url: string
  owner: Owner
  addedBy: AddedBy
  status: PlanStatus
  /** Junior's row with nothing running on it yet: the page offers Start (the existing dispatch) */
  startable: boolean
  /** the item is gone from the store */
  missing?: boolean
}

export type PlanView = {
  date: string
  rows: PlanRow[]
  done: number
  total: number
  /** the morning draft put rows here */
  drafted: boolean
}

const HUMAN_ASKS = new Set(['review', 'reply', 'decide'])

/** "#478", "NOV-140", "#api", or the item's home. */
export function shortRef(item: Pick<PlanItem, 'id' | 'source' | 'repo' | 'url' | 'refs'>, projectName?: string): string {
  const gh = /^github:[^#]+#(\d+)$/.exec(item.id)
  if (gh) return `#${gh[1]}`
  const lin = /^linear:(.+)$/.exec(item.id)
  if (lin) return lin[1]
  if (item.source === 'slack') return item.repo ? (item.repo.startsWith('#') ? item.repo : `#${item.repo}`) : 'Slack'
  for (const r of item.refs ?? []) {
    const m = /#(\d+)$/.exec(r) ?? /^linear:(.+)$/.exec(r)
    if (m) return m[1].includes('-') ? m[1] : `#${m[1]}`
  }
  const pr = /\/(?:pull|issues)\/(\d+)/.exec(item.url)
  if (pr) return `#${pr[1]}`
  if (item.source === 'manual') return projectName ?? 'to-do'
  return item.repo || item.source
}

/** The rows, in order, with a status each. Precedence: done, needs you, live, waiting on you, carried, to do. */
export function planRows(input: {
  date: string
  entries: readonly TodayEntry[]
  items: ReadonlyMap<string, PlanItem>
  sessions: readonly PlanSession[]
  projectName?: (id: string | undefined) => string | undefined
}): PlanView {
  const projectName = input.projectName ?? (() => undefined)
  const { items, sessions } = input
  const sorted = [...input.entries].sort((a, b) => a.order - b.order)
  const rows = sorted.map((e): PlanRow => {
    const item = items.get(e.itemId)
    if (!item) {
      return { itemId: e.itemId, title: 'An item that is no longer in Junior', ref: e.itemId.split(':')[0] || 'item', url: '', owner: e.owner, addedBy: e.addedBy, status: { kind: 'todo', note: 'gone' }, startable: false, missing: true }
    }
    const mine = sessions.filter((s) => s.itemId === e.itemId).sort((a, b) => b.updatedAt - a.updatedAt)
    const waiting = mine.find((s) => s.waiting)
    const live = mine.find((s) => s.running)
    const base = { itemId: e.itemId, title: item.title, ref: shortRef(item, projectName(item.projectId)), url: item.url, owner: e.owner, addedBy: e.addedBy }
    let status: PlanStatus
    if (item.status === 'done') status = { kind: 'done', at: item.statusAt ?? null }
    else if (waiting) status = { kind: 'needs', sessionId: waiting.id }
    else if (live) status = { kind: 'live', sessionId: live.id, step: live.step, activity: live.activity }
    else if (e.owner === 'you' && item.source !== 'manual' && (item.peopleWaiting > 0 || HUMAN_ASKS.has(item.ask ?? ''))) {
      const since = item.flow?.turn === 'me' ? item.flow.since : Date.parse(item.createdAt) || 0
      status = { kind: 'waiting', since, who: item.author || null }
    } else if (e.carriedFrom) status = { kind: 'carried', from: e.carriedFrom }
    else status = { kind: 'todo', note: todoNote(item) }
    const startable = e.owner === 'junior' && status.kind !== 'done' && status.kind !== 'live' && status.kind !== 'needs' && mine.length === 0
    return { ...base, status, startable }
  })
  const done = rows.filter((r) => r.status.kind === 'done').length
  return { date: input.date, rows, done, total: rows.length, drafted: sorted.some((e) => e.addedBy === 'draft') }
}

function todoNote(item: PlanItem): string | null {
  if (item.status === 'snoozed') return 'snoozed'
  const f = item.flow
  if (!f) return null
  if (f.stage === 'review' && f.turn === 'me') return 'ready for review'
  if (f.stage === 'ready' && f.turn === 'me') return 'brief ready'
  if (f.stage === 'briefing') return 'briefing'
  if (f.turn === 'others') return 'waiting on others'
  return null
}

// "Also today…": find the work item someone means

/**
 * The references in a message, in order: links, "#455", "NOV-123". What the
 * new-session composer offers to pull in as items; each is looked up with
 * matchItem, so only refs that name a real item turn into anything.
 */
export function refsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) out.add(m[0].replace(/[.,;:!?]+$/, ''))
  const rest = text.replace(/https?:\/\/\S+/g, ' ')
  for (const m of rest.matchAll(/(?:^|[\s(])#(\d+)\b/g)) out.add(`#${m[1]}`)
  for (const m of rest.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)) out.add(m[1])
  return [...out]
}

/** What the matcher reads of an item. */
export type MatchItem = { id: string; title: string; url: string; refs?: string[]; urls?: string[]; score?: number }

const STOP = new Set(['the', 'a', 'an', 'to', 'on', 'in', 'of', 'for', 'and', 'or', 'my', 'our', 'with', 'about', 'this', 'that', 'it', 'is', 'do', 'we', 'also', 'today', 'please'])

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”"'`’‘]/g, '')
    .split(/[^a-z0-9#-]+/)
    .filter(Boolean)

/** Do two words name the same thing ("onboarding" ~ "onboard")? */
const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))

/**
 * The open item a few typed words mean, or null. A ref wins outright: a URL,
 * "#455", "NOV-123". Otherwise every meaningful word typed must appear in the
 * title (prefixes count: "onboard" finds "onboarding"); the best-covered,
 * then highest-ranked, title wins. Deterministic: no model in the path.
 */
export function matchItem(query: string, items: readonly MatchItem[]): MatchItem | null {
  const q = query.trim()
  if (!q) return null
  const url = /https?:\/\/\S+/.exec(q)?.[0]?.replace(/[).,]+$/, '')
  if (url) {
    const hit = items.find((i) => i.url === url || i.urls?.includes(url))
    if (hit) return hit
  }
  const key = /\b([A-Za-z][A-Za-z0-9]+-\d+)\b/.exec(q)?.[1]?.toUpperCase()
  if (key) {
    const hit = items.find((i) => i.id.toUpperCase() === `LINEAR:${key}` || i.refs?.some((r) => r.toUpperCase() === `LINEAR:${key}`))
    if (hit) return hit
  }
  const num = /(?:^|\s)#(\d+)\b/.exec(q)?.[1]
  if (num) {
    const ends = (s: string) => s.endsWith(`#${num}`) || /\/(?:pull|issues)\/(\d+)\/?$/.exec(s)?.[1] === num
    const hit = items.find((i) => ends(i.id) || ends(i.url) || i.refs?.some(ends))
    if (hit) return hit
  }
  const want = words(q).filter((w) => !STOP.has(w) && !w.startsWith('#'))
  if (!want.length) return null
  let best: { item: MatchItem; cover: number } | null = null
  for (const item of items) {
    const have = words(item.title)
    const hits = want.filter((w) => have.some((h) => near(w, h))).length
    const cover = hits / want.length
    if (cover < 1) continue
    if (!best || cover > best.cover || (cover === best.cover && (item.score ?? 0) > (best.item.score ?? 0))) best = { item, cover }
  }
  return best?.item ?? null
}
