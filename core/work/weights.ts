/**
 * Score weights you set (.docs/overnight-2026-10-24, P2 "One honest list").
 *
 * When the order is wrong you can say so: "this person matters", "this repo
 * can wait". Each correction is a weight, a whole number of points added to
 * every item it matches, shown as its own named part of the sum so the list
 * never moves for a reason you can't see. Weights expire 60 days after they
 * were set, so an old correction can't quietly rule the list forever.
 *
 * Pure: no I/O, time is always an argument. The server keeps the list in one
 * config value (server/settings-ops.ts); score.ts reads it.
 */
import type { ItemKind, WorkItem } from './types.js'

/** What a weight matches: a person (item author), a repo or channel (item repo), or an item kind. */
export type WeightScope = 'person' | 'repo' | 'kind'

export interface ScoreWeight {
  /** `person:<login>` | `repo:<owner/repo>` | `kind:<kind>`, normalized (lowercase, no `@`) */
  key: string
  /** points added to a matching item's score; negative sinks it */
  delta: number
  /** when it was set, ISO. Setting the same key again renews it. */
  setAt: string
  /** your words, shown after "you said": "Priya matters". Optional. */
  reason?: string
}

/** A weight's part of one item's sum. */
export interface WeightPart {
  key: string
  points: number
  /** "you said Priya matters" */
  label: string
}

export const WEIGHT_TTL_DAYS = 60
const WEIGHT_TTL_MS = WEIGHT_TTL_DAYS * 86_400_000
/** a correction, not an override: the largest kind base is 100 */
export const MAX_WEIGHT_DELTA = 100
export const MAX_WEIGHTS = 200
const MAX_VALUE = 120
const MAX_REASON = 120

// Exhaustive on purpose: a new kind is a compile error here until it's listed.
const KINDS: Record<ItemKind, true> = {
  'review-requested': true,
  'reply-needed': true,
  'own-pr-approved': true,
  'own-pr-conflicting': true,
  'own-pr-stale': true,
  'own-pr-open': true,
  mention: true,
  'slack-reply-pending': true,
  'slack-mention': true,
  'ticket-assigned': true,
  'job-hit': true,
  digest: true,
  manual: true,
  fyi: true,
}

const norm = (s: string) => s.trim().replace(/^@/, '').toLowerCase()

/** Split and normalize a key, or explain what's wrong with it. */
export function parseWeightKey(raw: unknown): { ok: true; scope: WeightScope; value: string; key: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'key must be person:<login>, repo:<owner/repo> or kind:<kind>' }
  const at = raw.indexOf(':')
  const scope = at > 0 ? raw.slice(0, at).trim().toLowerCase() : ''
  if (scope !== 'person' && scope !== 'repo' && scope !== 'kind') {
    return { ok: false, error: 'key must be person:<login>, repo:<owner/repo> or kind:<kind>' }
  }
  const value = norm(raw.slice(at + 1))
  if (!value) return { ok: false, error: `${scope}: needs a value` }
  if (value.length > MAX_VALUE) return { ok: false, error: `${scope}: value is too long` }
  if (scope === 'kind' && !(value in KINDS)) return { ok: false, error: `unknown kind: ${value}` }
  if (scope === 'repo' && /\s/.test(value)) return { ok: false, error: 'repo: no spaces' }
  return { ok: true, scope, value, key: `${scope}:${value}` }
}

/** Validate a weight from the wire. `now` stamps it. Anything off is an error, not a repair. */
export function weightFrom(raw: unknown, now: number): { ok: true; weight: ScoreWeight } | { ok: false; error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const k = parseWeightKey(r.key)
  if (!k.ok) return k
  const d = r.delta
  if (typeof d !== 'number' || !Number.isInteger(d) || d === 0 || Math.abs(d) > MAX_WEIGHT_DELTA) {
    return { ok: false, error: `delta must be a whole number from -${MAX_WEIGHT_DELTA} to ${MAX_WEIGHT_DELTA}, not 0` }
  }
  if (r.reason !== undefined && r.reason !== null && typeof r.reason !== 'string') return { ok: false, error: 'reason must be text' }
  const reason = typeof r.reason === 'string' ? r.reason.trim().replace(/\s+/g, ' ') : ''
  if (reason.length > MAX_REASON) return { ok: false, error: `reason is over ${MAX_REASON} characters` }
  return { ok: true, weight: { key: k.key, delta: d, setAt: new Date(now).toISOString(), ...(reason ? { reason } : {}) } }
}

/** When a weight stops counting, ms. */
export function expiresAt(w: ScoreWeight): number {
  return Date.parse(w.setAt) + WEIGHT_TTL_MS
}

/** Still counting at `now`? A weight with an unreadable date never counts. */
export function isLive(w: ScoreWeight, now: number): boolean {
  const set = Date.parse(w.setAt)
  return Number.isFinite(set) && now < set + WEIGHT_TTL_MS
}

/**
 * A stored list, read defensively: entries that don't parse are dropped, keys
 * are re-normalized, and the last entry for a key wins. Expired ones are kept
 * (the caller decides with `isLive`), so reading never loses data.
 */
export function readWeights(raw: unknown): ScoreWeight[] {
  if (!Array.isArray(raw)) return []
  const byKey = new Map<string, ScoreWeight>()
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const k = parseWeightKey(r.key)
    if (!k.ok || typeof r.delta !== 'number' || !Number.isFinite(r.delta) || typeof r.setAt !== 'string') continue
    byKey.delete(k.key)
    byKey.set(k.key, { key: k.key, delta: r.delta, setAt: r.setAt, ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason } : {}) })
  }
  return [...byKey.values()]
}

/** The live weights, newest first. */
export function liveWeights(weights: ScoreWeight[], now: number): ScoreWeight[] {
  return weights.filter((w) => isLive(w, now)).sort((a, b) => Date.parse(b.setAt) - Date.parse(a.setAt) || a.key.localeCompare(b.key))
}

/**
 * Add or replace (same key) a weight. Expired ones are pruned on the way, and
 * the list is capped: past MAX_WEIGHTS the oldest go.
 */
export function putWeight(weights: ScoreWeight[], w: ScoreWeight, now: number): ScoreWeight[] {
  const rest = liveWeights(weights, now).filter((x) => x.key !== w.key)
  return [w, ...rest].slice(0, MAX_WEIGHTS)
}

/** Remove by key (normalized first). Returns the list and whether anything went. */
export function dropWeight(weights: ScoreWeight[], key: string, now: number): { weights: ScoreWeight[]; removed: boolean } {
  const k = parseWeightKey(key)
  const live = liveWeights(weights, now)
  if (!k.ok) return { weights: live, removed: false }
  const next = live.filter((w) => w.key !== k.key)
  return { weights: next, removed: next.length !== live.length }
}

function matches(item: WorkItem, w: ScoreWeight): boolean {
  const k = parseWeightKey(w.key)
  if (!k.ok) return false
  if (k.scope === 'person') return norm(item.author ?? '') === k.value
  if (k.scope === 'repo') return norm(item.repo ?? '') === k.value
  return item.kind === k.value
}

/** "you said Priya matters": your words if you gave some, else what the weight says. */
export function weightLabel(w: ScoreWeight): string {
  const said = w.reason?.replace(/^you said\s+/i, '').trim()
  if (said) return `you said ${said}`
  const k = parseWeightKey(w.key)
  if (!k.ok) return 'you set this'
  const up = w.delta > 0
  if (k.scope === 'person') return `you said @${k.value} ${up ? 'matters' : 'can wait'}`
  if (k.scope === 'repo') return `you said ${k.value} ${up ? 'matters' : 'can wait'}`
  return `you said ${k.value.replace(/-/g, ' ')} items ${up ? 'matter' : 'can wait'}`
}

/** +12 / −8, the way a part of the sum reads. */
export function signed(points: number): string {
  return `${points < 0 ? '−' : '+'}${Math.abs(points)}`
}

/** The live weights that touch this item, as parts of its sum. */
export function weightParts(item: WorkItem, weights: readonly ScoreWeight[], now: number): WeightPart[] {
  const out: WeightPart[] = []
  for (const w of weights) {
    if (!isLive(w, now) || !matches(item, w)) continue
    out.push({ key: w.key, points: w.delta, label: weightLabel(w) })
  }
  return out
}

/** A weight as the list shows it: when it stops counting, and how it reads in the sum. */
export interface ScoreWeightView extends ScoreWeight {
  expiresAt: string
  label: string
}

export function viewOf(w: ScoreWeight): ScoreWeightView {
  return { ...w, expiresAt: new Date(expiresAt(w)).toISOString(), label: `${signed(w.delta)} ${weightLabel(w)}` }
}
