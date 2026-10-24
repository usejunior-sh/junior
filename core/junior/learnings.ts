/**
 * Learnings with receipts: what Junior has learned about how you work, one
 * markdown file each under `<workspace>/learnings/<id>.md`. Junior proposes;
 * you keep or forget. Nothing here ever makes a learning `kept`: only the
 * keep op does (server/learnings-ops.ts), and only the user calls it.
 *
 * The frontmatter is the same small YAML subset team recipes use, read
 * strictly: an unknown key, a bad scope, a source without a day, a date that
 * doesn't parse is an error, and a file with any error isn't a learning.
 *
 *   ---
 *   scope: repo:acme/web
 *   status: kept
 *   createdAt: 2026-10-20T09:12:00.000Z
 *   proposedAt: 2026-10-21T10:05:00.000Z
 *   keptAt: 2026-10-21T16:40:00.000Z
 *   lastUsedAt: 2026-10-23T08:02:00.000Z
 *   sources:
 *     - { ref: "pr:acme/web#3235", day: 2026-10-20 }
 *     - { ref: "pr:acme/web#3240", day: 2026-10-21 }
 *   ---
 *   Run pnpm test:unit, not pnpm test, in acme/web.
 *
 * Statuses: `candidate` (seen once, never shown, never loaded), `proposed`
 * (seen on two different days, waiting on you), `kept` (you said keep),
 * `stale` (kept, but every receipt it cites is gone: a file that was deleted,
 * an item or session no longer in the store; waits on you to keep or forget).
 * Only `kept` learnings ever go into a prompt (`loadable`), and only after
 * their citations are re-checked at load (`citationOf`, `loadVerdict`). At most
 * PROPOSALS_PER_DAY new proposals a day: past that, a second sighting stays
 * a candidate and is proposed on a later day.
 *
 * The rules against memory rot, all pure and clock-free (time is an argument):
 * - expiry: a learning nobody used, kept or touched in 28 days goes;
 * - budget: at most KEPT_PER_SCOPE kept learnings per scope;
 * - loss guard: a change that drops more than half is refused (an expiry
 *   sweep after a month away, an edit that guts a learning).
 */
import { parseYaml, YamlError, type YamlValue } from '../teams/recipe.js'
import { dayKey } from './today.js'

export const LEARNING_STATUSES = ['candidate', 'proposed', 'kept', 'stale'] as const
export type LearningStatus = (typeof LEARNING_STATUSES)[number]

/** `global`, or one repo: `repo:<owner>/<repo>` (lowercase). */
export type LearningScope = 'global' | `repo:${string}`

/** A receipt: what Junior saw (a PR, a thread, a session, a file:line) and the local day it saw it. */
export type LearningSource = { ref: string; day: string }

export type Learning = {
  /** the file name without `.md` */
  id: string
  /** the learning itself: the file's body */
  text: string
  scope: LearningScope
  status: LearningStatus
  sources: LearningSource[]
  /** ms */
  createdAt: number
  /** ms; when it became a proposal, absent while a candidate (and on files from before it was recorded) */
  proposedAt?: number
  /** ms; when you kept it, absent until you do */
  keptAt?: number
  /** ms; when it last went into a chat or run, absent until it does */
  lastUsedAt?: number
  /**
   * ms; when a load found every receipt it cites gone and marked it `stale`.
   * Stays after you keep it again: `keptAt` later than this means you vouched
   * for it, and the load no longer re-checks it.
   */
  staleAt?: number
}

export const LEARNING_FILE_KEYS = ['scope', 'status', 'createdAt', 'proposedAt', 'keptAt', 'lastUsedAt', 'staleAt', 'sources'] as const

/** Unused this long, a learning goes. */
export const EXPIRE_DAYS = 28
export const EXPIRE_MS = EXPIRE_DAYS * 86_400_000
/** Kept learnings per scope. Keeping one more asks you to forget one first. */
export const KEPT_PER_SCOPE = 20
/** New proposals a day, per workspace: past this, the rest wait for another day. */
export const PROPOSALS_PER_DAY = 3
/** A learning is a line or two, not a document. */
export const LEARNING_TEXT_MAX = 600
/** Receipts kept per learning; past this, the oldest go. */
export const SOURCES_MAX = 8
export const REF_MAX = 300
/** The loss guard only speaks up when at least this many learnings (or characters, for an edit) would go. */
export const LOSS_MIN_LEARNINGS = 3
export const LOSS_MIN_CHARS = 20

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const REPO_RE = /^repo:[a-z0-9_.-]+\/[a-z0-9_.-]+$/
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export const isLearningId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)
export const isLearningStatus = (v: unknown): v is LearningStatus => typeof v === 'string' && (LEARNING_STATUSES as readonly string[]).includes(v)

/** A scope as typed (`global`, `repo:Acme/Web`, `acme/web`) → the stored form, or null. */
export function scopeFrom(raw: unknown): LearningScope | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (s === 'global') return 'global'
  const repo = s.startsWith('repo:') ? s : `repo:${s}`
  return REPO_RE.test(repo) ? (repo as LearningScope) : null
}

/** A `YYYY-MM-DD` that is a real calendar day. */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = DAY_RE.exec(v)
  if (!m) return false
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
}

/** The local midnight a `YYYY-MM-DD` starts at, ms. */
export function dayStart(day: string): number {
  const m = DAY_RE.exec(day)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN
}

/** Problems with a source ref, or null when it's fine. */
export function refProblem(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.trim()) return 'a source needs a ref (a PR, a thread, a session, a file:line)'
  if (ref.length > REF_MAX) return `a source ref is at most ${REF_MAX} characters`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(ref)) return 'a source ref is one line, without backslashes'
  return null
}

/** Problems with a learning's text, or null when it's fine. */
export function textProblem(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return 'a learning needs text'
  if (text.trim().length > LEARNING_TEXT_MAX) return `a learning is at most ${LEARNING_TEXT_MAX} characters`
  return null
}

/** What two learnings are compared on: case, spacing and closing punctuation don't count. */
export const normaliseText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[`*_"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!;:,]+$/, '')

// ---------------------------------------------------------------------------
// The file

export type ParsedLearning = { learning: Learning | null; errors: string[] }

function splitFile(text: string): { yaml: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return m ? { yaml: m[1], body: text.slice(m[0].length) } : null
}

const isMap = (v: YamlValue): v is { [key: string]: YamlValue } => typeof v === 'object' && !Array.isArray(v)

function timeOf(key: string, v: YamlValue | undefined, errors: string[], required: boolean): number | undefined {
  if (v === undefined || v === '') {
    if (required) errors.push(`${key}: required (an ISO time)`)
    return undefined
  }
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  if (!Number.isFinite(ms)) {
    errors.push(`${key}: "${typeof v === 'string' ? v : '…'}" is not an ISO time`)
    return undefined
  }
  return ms
}

function sourcesOf(v: YamlValue | undefined, errors: string[]): LearningSource[] {
  if (v === undefined || v === '') {
    errors.push('sources: at least one (a learning without a receipt is a guess)')
    return []
  }
  if (!Array.isArray(v)) {
    errors.push('sources: a list of { ref, day }')
    return []
  }
  const out: LearningSource[] = []
  v.forEach((s, i) => {
    if (typeof s !== 'object' || Array.isArray(s)) return void errors.push(`sources[${i}]: expected { ref, day }`)
    for (const k of Object.keys(s)) if (k !== 'ref' && k !== 'day') errors.push(`sources[${i}]: unknown key "${k}" (expected ref, day)`)
    const ref = typeof s.ref === 'string' ? s.ref.trim() : ''
    const bad = refProblem(ref)
    if (bad) errors.push(`sources[${i}]: ${bad}`)
    if (!isDay(s.day)) errors.push(`sources[${i}]: day is a YYYY-MM-DD`)
    if (!bad && isDay(s.day)) out.push({ ref, day: s.day })
  })
  if (!v.length) errors.push('sources: at least one (a learning without a receipt is a guess)')
  return out
}

/** A learning file → the learning. Any error and `learning` is null: a half-read learning is never used. */
export function parseLearning(id: string, text: string): ParsedLearning {
  const errors: string[] = []
  if (!isLearningId(id)) errors.push(`"${id}" is not a learning id (lowercase letters, digits and dashes)`)
  const parts = splitFile(text)
  if (!parts) return { learning: null, errors: [...errors, 'no frontmatter: the file starts with a --- line'] }
  let doc: YamlValue
  try {
    doc = parseYaml(parts.yaml, 2)
  } catch (err) {
    return { learning: null, errors: [...errors, err instanceof YamlError ? err.message : String(err)] }
  }
  if (!isMap(doc)) return { learning: null, errors: [...errors, 'the frontmatter is a map of keys'] }
  for (const k of Object.keys(doc)) {
    if (!(LEARNING_FILE_KEYS as readonly string[]).includes(k)) errors.push(`unknown key "${k}" (expected ${LEARNING_FILE_KEYS.join(', ')})`)
  }
  const scope = scopeFrom(doc.scope)
  if (!scope) errors.push('scope: global, or repo:<owner>/<repo>')
  const status = doc.status
  if (!isLearningStatus(status)) errors.push(`status: one of ${LEARNING_STATUSES.join(', ')}`)
  const createdAt = timeOf('createdAt', doc.createdAt, errors, true)
  const proposedAt = timeOf('proposedAt', doc.proposedAt, errors, false)
  const keptAt = timeOf('keptAt', doc.keptAt, errors, false)
  const lastUsedAt = timeOf('lastUsedAt', doc.lastUsedAt, errors, false)
  const staleAt = timeOf('staleAt', doc.staleAt, errors, false)
  const sources = sourcesOf(doc.sources, errors)
  const body = parts.body.trim()
  const bad = textProblem(body)
  if (bad) errors.push(`body: ${bad}`)
  if (status === 'kept' && keptAt === undefined && !errors.some((e) => e.startsWith('keptAt'))) errors.push('keptAt: a kept learning says when you kept it')
  if (errors.length || !scope || !isLearningStatus(status) || createdAt === undefined) return { learning: null, errors }
  const learning: Learning = { id, text: body, scope, status, sources, createdAt }
  if (proposedAt !== undefined) learning.proposedAt = proposedAt
  if (keptAt !== undefined) learning.keptAt = keptAt
  if (lastUsedAt !== undefined) learning.lastUsedAt = lastUsedAt
  if (staleAt !== undefined) learning.staleAt = staleAt
  return { learning, errors: [] }
}

const quoted = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const iso = (ms: number) => new Date(ms).toISOString()

/** The learning → its file. `parseLearning(l.id, serializeLearning(l))` gives `l` back. */
export function serializeLearning(l: Learning): string {
  const lines = ['---', `scope: ${l.scope}`, `status: ${l.status}`, `createdAt: ${iso(l.createdAt)}`]
  if (l.proposedAt !== undefined) lines.push(`proposedAt: ${iso(l.proposedAt)}`)
  if (l.keptAt !== undefined) lines.push(`keptAt: ${iso(l.keptAt)}`)
  if (l.lastUsedAt !== undefined) lines.push(`lastUsedAt: ${iso(l.lastUsedAt)}`)
  if (l.staleAt !== undefined) lines.push(`staleAt: ${iso(l.staleAt)}`)
  lines.push('sources:')
  for (const s of l.sources) lines.push(`  - { ref: ${quoted(s.ref)}, day: ${s.day} }`)
  lines.push('---')
  return `${lines.join('\n')}\n${l.text.trim()}\n`
}

/** A file name for a new learning: its words, made unique against `taken`. */
export function learningId(text: string, taken: ReadonlySet<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'learning'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

// ---------------------------------------------------------------------------
// Sightings: Junior saw it again

export type SightingInput = { text: string; scope: LearningScope; ref: string }

export type Sighting =
  /**
   * a quiet candidate, never shown, never loaded: the first sighting, one more
   * on the same day, or (`held`) one on another day when today's proposals
   * are used up
   */
  | { kind: 'candidate'; learning: Learning; created: boolean; held?: boolean }
  /** seen again on another day: now it's a proposal you see */
  | { kind: 'proposed'; learning: Learning }
  /** already proposed or kept: one more receipt, nothing else moves */
  | { kind: 'known'; learning: Learning }

/** Add a receipt unless that ref was already seen that day; past SOURCES_MAX the oldest goes. */
function withSource(sources: LearningSource[], s: LearningSource): LearningSource[] {
  if (sources.some((x) => x.ref === s.ref && x.day === s.day)) return sources
  const next = [...sources, s]
  return next.length > SOURCES_MAX ? next.slice(next.length - SOURCES_MAX) : next
}

/** The learning that says the same thing in the same scope, if any. */
export const findMatch = (list: readonly Learning[], text: string, scope: LearningScope): Learning | null =>
  list.find((l) => l.scope === scope && normaliseText(l.text) === normaliseText(text)) ?? null

/** How many learnings became proposals on local day `day` (kept ones included: they were proposed first). */
export function proposalsOn(list: readonly Learning[], day: string): number {
  return list.filter((l) => l.proposedAt !== undefined && dayKey(l.proposedAt) === day).length
}

/**
 * Junior saw something worth learning. The first sighting is a candidate. A
 * matching sighting (same scope, same text once normalised) on a *different*
 * local day makes it a proposal; another on the same day doesn't. When
 * `perDay` proposals were already made today, it stays a candidate (`held`)
 * with the new receipt, and the next sighting on a later day proposes it.
 * Never returns a learning that is newly `kept`: only you keep.
 */
export function sight(list: readonly Learning[], input: SightingInput, now: number, newId: () => string, perDay = PROPOSALS_PER_DAY): Sighting {
  const source = { ref: input.ref.trim(), day: dayKey(now) }
  const match = findMatch(list, input.text, input.scope)
  if (!match) {
    return { kind: 'candidate', created: true, learning: { id: newId(), text: input.text.trim(), scope: input.scope, status: 'candidate', sources: [source], createdAt: now } }
  }
  const sources = withSource(match.sources, source)
  if (match.status !== 'candidate') return { kind: 'known', learning: { ...match, sources } }
  const anotherDay = match.sources.some((s) => s.day !== source.day)
  if (anotherDay) {
    if (proposalsOn(list, source.day) >= perDay) return { kind: 'candidate', created: false, held: true, learning: { ...match, sources } }
    return { kind: 'proposed', learning: { ...match, sources, status: 'proposed', proposedAt: now } }
  }
  return { kind: 'candidate', created: false, learning: { ...match, sources } }
}

/**
 * What propose_learning answers, as JSON. A `proposed` answer is the session
 * event the chat renders as a card ("Learned: … · Keep · Edit · Undo"):
 * the tool call and this result are persisted in the session's event log like
 * every tool call, and `learningProposalOf` reads the card back out of it.
 */
export type ProposeLearningResult = {
  /** what the sighting did */
  status: Sighting['kind']
  /** true only for a new proposal: the one answer the user sees as a card */
  shown: boolean
  /** a second sighting that would have been a proposal, held because today's are used up */
  held?: boolean
  learning: Learning
  /** one line for the model: what happened and what to do next */
  note: string
}

export function proposeLearningResult(s: Sighting): ProposeLearningResult {
  const base = { status: s.kind, shown: s.kind === 'proposed', learning: s.learning }
  if (s.kind === 'proposed') {
    return { ...base, note: 'Seen on two different days: shown to the user as a card. Nothing is kept until they press Keep. Carry on.' }
  }
  if (s.kind === 'known') {
    const was = s.learning.status === 'stale' ? 'waiting on the user (its old receipts are gone)' : s.learning.status === 'kept' ? 'kept' : 'proposed'
    return { ...base, note: `Already ${was}; the receipt is added. Nothing else changes.` }
  }
  if (s.held) {
    return { ...base, held: true, note: `Seen again, but ${PROPOSALS_PER_DAY} learnings were already proposed today. It stays a quiet note; the next sighting on a later day proposes it.` }
  }
  return {
    ...base,
    note: s.created
      ? 'Noted quietly. The user does not see it. If you see the same thing on another day, propose it again with the same words and scope.'
      : 'Seen again today. It stays a quiet note until it is seen on another day.',
  }
}

/** A propose_learning result → the proposal card's learning, or null when the call made no card. Never throws. */
export function learningProposalOf(resultText: string): Learning | null {
  try {
    const r = JSON.parse(resultText) as Partial<ProposeLearningResult>
    if (r?.status !== 'proposed' || r.shown !== true || !r.learning || typeof r.learning !== 'object') return null
    const l = r.learning
    return isLearningId(l.id) && typeof l.text === 'string' && scopeFrom(l.scope) && Array.isArray(l.sources) ? l : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Expiry, budget, loss guard

/** The last time anything happened to it: made, seen again, kept, used. */
export function lastActive(l: Learning): number {
  let t = Math.max(l.createdAt, l.keptAt ?? 0, l.lastUsedAt ?? 0)
  for (const s of l.sources) {
    const d = dayStart(s.day)
    if (Number.isFinite(d) && d > t) t = d
  }
  return t
}

export const isExpired = (l: Learning, now: number): boolean => now - lastActive(l) > EXPIRE_MS

/**
 * Would going from `before` to `after` lose too much? More than half, and at
 * least `min` of them. The minimum keeps a workspace with one or two
 * learnings (or a one-line learning) from never being allowed to change.
 */
export function dropsTooMuch(before: number, after: number, min: number): boolean {
  const lost = before - after
  return lost >= min && lost * 2 > before
}

export type Sweep = {
  /** what stays */
  live: Learning[]
  /** what goes */
  expired: Learning[]
  /**
   * kept learnings that are past expiry but stay, because letting them all go
   * at once would drop more than half of what you kept (a month away is not
   * a month of them being wrong)
   */
  held: Learning[]
}

/** Which learnings expire now. Candidates and proposals just go; kept ones go unless the loss guard holds them. */
export function sweep(list: readonly Learning[], now: number): Sweep {
  const kept = list.filter((l) => l.status === 'kept')
  const keptGoing = kept.filter((l) => isExpired(l, now))
  const hold = dropsTooMuch(kept.length, kept.length - keptGoing.length, LOSS_MIN_LEARNINGS)
  const live: Learning[] = []
  const expired: Learning[] = []
  const held: Learning[] = []
  for (const l of list) {
    if (!isExpired(l, now)) live.push(l)
    else if (l.status === 'kept' && hold) {
      held.push(l)
      live.push(l)
    } else expired.push(l)
  }
  return { live, expired, held }
}

export type Budget = {
  scope: LearningScope
  /** kept learnings in this scope */
  count: number
  max: number
  /** another keep here would pass the budget */
  full: boolean
  /** the kept one used least recently: what to forget first */
  leastUsed: Learning | null
}

/** Where a scope stands against the budget. */
export function budget(list: readonly Learning[], scope: LearningScope, max = KEPT_PER_SCOPE, exceptId?: string): Budget {
  const kept = list.filter((l) => l.status === 'kept' && l.scope === scope && l.id !== exceptId)
  const leastUsed = kept.reduce<Learning | null>((a, l) => (!a || lastActive(l) < lastActive(a) ? l : a), null)
  return { scope, count: kept.length, max, full: kept.length >= max, leastUsed }
}

/**
 * Kept learnings, at most `max` per scope, the most recently active first. A
 * hand-edited folder can hold more than the budget; only these count.
 */
export function withinBudget(list: readonly Learning[], max = KEPT_PER_SCOPE): Learning[] {
  const byScope = new Map<LearningScope, Learning[]>()
  for (const l of list) {
    if (l.status !== 'kept') continue
    const arr = byScope.get(l.scope) ?? []
    arr.push(l)
    byScope.set(l.scope, arr)
  }
  const out: Learning[] = []
  for (const arr of byScope.values()) out.push(...arr.sort((a, b) => lastActive(b) - lastActive(a) || a.id.localeCompare(b.id)).slice(0, max))
  return out
}

// ---------------------------------------------------------------------------
// The user's moves, as pure transitions

export type Move = { ok: true; learning: Learning } | { ok: false; error: string }

/** You said keep. The only way anything becomes `kept` (a stale one too: keeping it vouches for it). */
export function keep(list: readonly Learning[], id: string, now: number, max = KEPT_PER_SCOPE): Move {
  const l = list.find((x) => x.id === id)
  if (!l) return { ok: false, error: 'no such learning' }
  if (l.status === 'kept') return { ok: true, learning: l }
  const b = budget(list, l.scope, max)
  if (b.full) return { ok: false, error: budgetError(b) }
  return { ok: true, learning: { ...l, status: 'kept', keptAt: now } }
}

export type EditInput = { text?: string; scope?: LearningScope; confirm?: boolean }

/**
 * You changed its words or its scope. The status never moves: editing a
 * proposal doesn't keep it. Cutting more than half the words needs `confirm`.
 */
export function edit(list: readonly Learning[], id: string, input: EditInput, max = KEPT_PER_SCOPE): Move {
  const l = list.find((x) => x.id === id)
  if (!l) return { ok: false, error: 'no such learning' }
  let next = l
  if (input.text !== undefined) {
    const bad = textProblem(input.text)
    if (bad) return { ok: false, error: bad }
    const text = input.text.trim()
    if (!input.confirm && dropsTooMuch(l.text.length, text.length, LOSS_MIN_CHARS)) {
      return { ok: false, error: 'this cuts more than half of the learning; send confirm to save it anyway' }
    }
    next = { ...next, text }
  }
  if (input.scope !== undefined && input.scope !== l.scope) {
    if (l.status === 'kept') {
      const b = budget(list, input.scope, max, l.id)
      if (b.full) return { ok: false, error: budgetError(b) }
    }
    next = { ...next, scope: input.scope }
  }
  return { ok: true, learning: next }
}

export function budgetError(b: Budget): string {
  const where = b.scope === 'global' ? 'everywhere' : `for ${b.scope.slice('repo:'.length)}`
  const hint = b.leastUsed ? ` The one used least lately: "${b.leastUsed.text.slice(0, 80)}".` : ''
  return `Junior keeps at most ${b.max} learnings ${where}. Forget one first.${hint}`
}

/**
 * The learnings a prompt may carry: kept ones only. Candidates are Junior's
 * quiet notes and proposals wait on you; neither ever reaches a model.
 */
export const loadable = (list: readonly Learning[]): Learning[] => list.filter((l) => l.status === 'kept')

/** Mark learnings as used now (they went into a chat or a run). Returns only the ones that changed. */
export function markUsed(list: readonly Learning[], ids: readonly string[], now: number): Learning[] {
  const want = new Set(ids)
  return list.filter((l) => want.has(l.id) && l.status === 'kept').map((l) => ({ ...l, lastUsedAt: now }))
}

// ---------------------------------------------------------------------------
// Loading: which kept learnings go into a session, and are their receipts still there

/** Learnings loaded into one session, at most. The composer's character cap may stop it sooner. */
export const LOAD_MAX = 12
/** A loaded learning's lastUsedAt is written again only when it is older than this (a revive storm writes nothing). */
export const USED_WRITE_EVERY_MS = 10 * 60_000

/**
 * What a receipt points at, for the local re-check at load:
 * - `file`: a path in the project, with the line it cited when it had one
 *   (`src/a.ts:42`, `src/a.ts:42-50`, `file:src/a.ts`, `package.json`);
 * - `item`: a work item that must still be in the store (`item:<id>`, `manual:<uuid>`);
 * - `session`: a session that must still be in the store (`session:<id>`);
 * - `remote`: a PR, issue, thread or link (`pr:`, `github:`, `slack:`,
 *   `linear:`, `thread:`, `issue:`, `http(s)://`), which passes without a call;
 * - `unknown`: anything else, which can't be checked and so never fails.
 */
export type Citation =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'item'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'remote' }
  | { kind: 'unknown' }

const REMOTE_PREFIXES = ['pr', 'github', 'slack', 'linear', 'thread', 'issue', 'http', 'https', 'mailto']
const FILE_LINE_RE = /^(.*[^\s:]):(\d+)(?:[-:]\d+)?$/
const PATHISH_RE = /^[\w.@~/+-]+$/

export function citationOf(rawRef: string): Citation {
  const ref = rawRef.trim()
  const scheme = /^([a-z][a-z0-9+-]*):(.*)$/i.exec(ref)
  if (scheme) {
    const [, rawPrefix, rest] = scheme
    const prefix = rawPrefix.toLowerCase()
    if (prefix === 'session') return rest.trim() ? { kind: 'session', id: rest.trim() } : { kind: 'unknown' }
    if (prefix === 'item') return rest.trim() ? { kind: 'item', id: rest.trim() } : { kind: 'unknown' }
    if (prefix === 'manual') return rest.trim() ? { kind: 'item', id: ref } : { kind: 'unknown' }
    if (REMOTE_PREFIXES.includes(prefix)) return { kind: 'remote' }
    if (prefix === 'file') return fileCitation(rest.trim()) ?? { kind: 'unknown' }
    // `src:12` reads as a file named src at line 12; any other `word:` is a kind we don't know.
    if (!/^\d+(?:[-:]\d+)?$/.test(rest)) return { kind: 'unknown' }
  }
  return fileCitation(ref) ?? { kind: 'unknown' }
}

function fileCitation(ref: string): Citation | null {
  const m = FILE_LINE_RE.exec(ref)
  const file = m ? m[1] : ref
  if (!file || !PATHISH_RE.test(file)) return null
  // Without a line, a bare word ("ci", "review") is not a file; it needs a slash or an extension.
  if (!m && !file.includes('/') && !/\.[a-z0-9]{1,10}$/i.test(file)) return null
  const line = m ? Number(m[2]) : undefined
  return line !== undefined && line > 0 ? { kind: 'file', path: file, line } : { kind: 'file', path: file }
}

/** One receipt at load: still there, gone, or nothing to check it against here. */
export type CitationCheck = 'ok' | 'gone' | 'unchecked'

/** The user kept it again after it went stale: they vouched for it, so its receipts aren't re-checked. */
export const vouched = (l: Learning): boolean => l.staleAt !== undefined && l.keptAt !== undefined && l.keptAt > l.staleAt

/**
 * A kept learning's receipts, re-checked: `load` it, or it is `stale` because
 * every receipt it cites is gone. One receipt still there, or one that can't
 * be checked here, is enough to load it.
 */
export function loadVerdict(checks: readonly CitationCheck[]): 'load' | 'stale' {
  return checks.length > 0 && checks.every((c) => c === 'gone') ? 'stale' : 'load'
}

/** Every receipt gone: the learning waits on you to keep or forget. */
export const markStale = (l: Learning, now: number): Learning => ({ ...l, status: 'stale', staleAt: now })

/**
 * The kept learnings a session in `repo` may load (null: no repo, so only
 * global ones), within the per-scope budget, the repo's own first, then the
 * most recently active. Capped at `max`; the caller drops stale ones before
 * it caps.
 */
export function forScope(list: readonly Learning[], repo: string | null): Learning[] {
  const repoScope = repo ? scopeFrom(repo) : null
  const mine = withinBudget(loadable(list)).filter((l) => l.scope === 'global' || (repoScope !== null && repoScope !== 'global' && l.scope === repoScope))
  return mine.sort((a, b) => Number(b.scope !== 'global') - Number(a.scope !== 'global') || lastActive(b) - lastActive(a) || a.id.localeCompare(b.id))
}

/** The receipt a prompt shows: the newest one still there (or not checkable), else the newest. */
export function citeOf(l: Learning, checks?: readonly CitationCheck[]): LearningSource {
  const order = l.sources.map((s, i) => ({ s, i })).sort((a, b) => b.s.day.localeCompare(a.s.day) || b.i - a.i)
  const live = checks ? order.find(({ i }) => checks[i] !== 'gone') : order[0]
  return (live ?? order[0]).s
}
