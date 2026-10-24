/**
 * The reason chip's corrections (.docs/overnight-2026-10-24/designs/reason-chip.md).
 *
 * A ranked row shows its score as a sum (rankParts, score.ts). When the order
 * is wrong, three fixed corrections say so, each one a weight (weights.ts):
 *   This person matters  person:<author>  +20
 *   Not important        kind:<kind>      −20
 *   Not mine             repo:<repo>      −40
 * Fixed sizes, no number field. A correction already set (a weight part with
 * its key and sign on this row) is "pressed", and pressing it again clears it.
 *
 * Pure and browser-safe: time is an argument, nothing here talks to the server.
 */
import { isBotLogin } from './status.js'
import type { RankPart, ScoredItem } from './types.js'
import { parseWeightKey, signed, type ScoreWeight } from './weights.js'

export type CorrectionId = 'matters' | 'not-important' | 'not-mine'

export interface Correction {
  id: CorrectionId
  /** the button: "This person matters" */
  label: string
  /** the weight key it sets: `person:priya` */
  key: string
  delta: number
  /** stored with the weight, so its label reads "you said acme/web isn't mine" */
  reason?: string
  /** what it does, under the button: "+20 on every item from @priya" */
  effect: string
  /** a weight with this key and sign already counts on this row */
  pressed: boolean
  /** when the pressed weight was set, ISO, when the caller knows its weights */
  setAt?: string
}

export const MATTERS_DELTA = 20
export const NOT_IMPORTANT_DELTA = -20
export const NOT_MINE_DELTA = -40

/** Kinds a kind-wide weight would be a blunt tool on: a job's finds are tuned in its file, your own to-dos have priority. */
const NO_KIND_WEIGHT = new Set(['manual', 'job-hit'])

type Row = Pick<ScoredItem, 'kind' | 'author' | 'repo' | 'rankParts'>

const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/^@/, '').toLowerCase()

/** "review requested": a kind in words, the way weightLabel says it. */
export const kindWords = (kind: string) => kind.replace(/-/g, ' ')

/**
 * The corrections that apply to this row, in button order. A correction whose
 * key can't be formed is left out: no author (or it's you, Junior or a bot),
 * a manual or job-hit kind, no repo. `me` is your login; null when unknown.
 * `weights` (optional) fills in when a pressed one was set.
 */
export function correctionsFor(item: Row, me: string | null, weights: readonly ScoreWeight[] = []): Correction[] {
  const out: Correction[] = []
  const parts = item.rankParts ?? []
  const make = (id: CorrectionId, label: string, rawKey: string, delta: number, effect: (value: string) => string, reason?: (value: string) => string) => {
    const k = parseWeightKey(rawKey)
    if (!k.ok) return
    const pressed = parts.some((p) => p.weight === k.key && Math.sign(p.points) === Math.sign(delta))
    const setAt = pressed ? weights.find((w) => w.key === k.key)?.setAt : undefined
    out.push({ id, label, key: k.key, delta, effect: effect(k.value), pressed, ...(reason ? { reason: reason(k.value) } : {}), ...(setAt ? { setAt } : {}) })
  }
  const author = norm(item.author)
  if (author && author !== norm(me) && author !== 'junior' && !isBotLogin(author)) {
    make('matters', 'This person matters', `person:${author}`, MATTERS_DELTA, (v) => `${signed(MATTERS_DELTA)} on every item from @${v}`)
  }
  if (!NO_KIND_WEIGHT.has(item.kind)) {
    make('not-important', 'Not important', `kind:${item.kind}`, NOT_IMPORTANT_DELTA, (v) => `${signed(NOT_IMPORTANT_DELTA)} on every ${kindWords(v)} item`)
  }
  const repo = norm(item.repo)
  if (repo) {
    make('not-mine', 'Not mine', `repo:${repo}`, NOT_MINE_DELTA, (v) => `${signed(NOT_MINE_DELTA)} on everything in ${v}`, (v) => `${v} isn't mine`)
  }
  return out
}

/** A part as the popover shows it: whole points. */
export interface ShownPart extends RankPart {
  shown: number
}

/**
 * The parts rounded to whole points, and a total that is the sum of what's
 * shown, so the sum on screen always adds up. Ranking keeps the exact score.
 */
export function displayParts(parts: readonly RankPart[]): { parts: ShownPart[]; total: number } {
  const shown = parts.map((p) => ({ ...p, shown: Math.round(p.points) || 0 }))
  return { parts: shown, total: shown.reduce((s, p) => s + p.shown, 0) }
}

/** A row carries a weight you set: it gets the quiet "you set this" mark. */
export const isAdjusted = (item: Pick<ScoredItem, 'rankParts'>): boolean => !!item.rankParts?.some((p) => p.weight)

/** "today", "3d ago", "2w ago": how long since a weight was set. */
export function setAgo(setAt: string, now: number): string {
  const days = Math.floor((now - Date.parse(setAt)) / 86_400_000)
  if (!Number.isFinite(days) || days < 1) return 'today'
  if (days < 14) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

/** What a pressed correction says under it: "Set 3d ago. Press again to clear." */
export function pressedLine(setAt: string | undefined, now: number): string {
  if (!setAt) return 'Press again to clear.'
  const ago = setAgo(setAt, now)
  return `Set ${ago}. Press again to clear.`
}

/** "person", "repo", "kind": the scope word the notebook shows. */
export function scopeOf(key: string): string {
  const k = parseWeightKey(key)
  return k.ok ? k.scope : 'weight'
}

/** "Dec 19", local time: the day a weight stops counting. */
export function dayOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
