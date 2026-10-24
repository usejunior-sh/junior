/**
 * What you can do to one work item, as the ⌘K palette's "This item" group
 * and the Junior page's H / P / X keys see it. The rules mirror `primaryOf`
 * in JuniorLedger.tsx, so the palette and the row never disagree. Pure and
 * store-free, so the node tests can load it (handoff.ts re-exports VERB).
 * Design note: .docs/overnight-2026-10-24/designs/palette-cmdk.md.
 */
import type { HandoffReadiness, ScoredItem } from '../../shared/protocol.js'
import { playbookOf } from './itemRef.js'

/** The verb on a suggestion's button. */
export const VERB: Record<string, string> = { babysit: 'Babysit', review: 'First pass', answer: 'Hand off', 'debug-fix': 'Hand off', investigate: 'Hand off' }

type Verbable = Pick<ScoredItem, 'handoff' | 'junior' | 'suggestion' | 'reason' | 'source' | 'label'>

/**
 * A hand-off, when one applies: the playbook to send (none = the server picks
 * by the item's reason) and the word on the button. Null once the item is
 * with Junior (handed off, paused, or Junior has a stage on it).
 */
export function handOffOf(i: Verbable): { playbook?: string; word: string } | null {
  if (i.handoff === 'on' || i.handoff === 'paused' || i.junior) return null
  if (i.suggestion) {
    const pb = i.suggestion.playbook
    return { ...(pb === 'babysit' || pb === 'review' ? {} : { playbook: pb }), word: VERB[pb] ?? 'Hand off' }
  }
  if (i.reason === 'your-pr') return { word: 'Babysit' }
  if (i.reason === 'review-requested') return { word: 'First pass' }
  return { playbook: playbookOf(i), word: 'Hand off' }
}

/** Pause while Junior is working or watching it; resume once paused. */
export function pauseOf(i: Pick<ScoredItem, 'handoff' | 'junior'>): 'pause' | 'resume' | null {
  if (i.handoff === 'paused') return 'resume'
  if (i.handoff === 'on' && (i.junior?.stage === 'working' || i.junior?.stage === 'watching')) return 'pause'
  return null
}

export type ItemVerbId = 'handoff' | 'snooze' | 'not-now' | 'pause' | 'resume' | 'approve' | 'open' | 'done'

export type ItemVerb = {
  id: ItemVerbId
  label: string
  /** the Junior page key that does the same on an open row */
  key?: string
  /** right-aligned, quiet: the hand-off word, the sends waiting */
  hint?: string
  /** a hand-off's playbook */
  playbook?: string
}

/** "1 send waits", "3 sends wait". */
export const sendsHint = (n: number) => (n === 1 ? '1 send waits' : `${n} sends wait`)

/**
 * The verbs that apply, in the palette's order. `held` is how many sends wait
 * on the item for approval (0 or unknown: no Approve send…, which only opens
 * the card; nothing is approved from a palette row).
 */
export function verbsOf(i: Verbable, held = 0): ItemVerb[] {
  const out: ItemVerb[] = []
  const h = handOffOf(i)
  if (h) out.push({ id: 'handoff', label: 'Hand off to Junior', key: 'h', ...(h.word !== 'Hand off' ? { hint: h.word } : {}), ...(h.playbook ? { playbook: h.playbook } : {}) })
  out.push({ id: 'snooze', label: 'Snooze…', key: 's' })
  if (i.suggestion) out.push({ id: 'not-now', label: 'Not this one', key: 'x' })
  const p = pauseOf(i)
  if (p === 'pause') out.push({ id: 'pause', label: 'Pause Junior', key: 'p' })
  if (p === 'resume') out.push({ id: 'resume', label: 'Resume Junior', key: 'p' })
  if (held > 0) out.push({ id: 'approve', label: 'Approve send…', hint: sendsHint(held) })
  out.push({ id: 'open', label: 'Open', key: 'o' })
  out.push({ id: 'done', label: 'Done', key: 'd' })
  return out
}

/** The status line after a hand-off went through. */
export function handedOffLine(title: string, readiness?: HandoffReadiness): string {
  if (readiness?.state === 'watch-off') return readiness.watch === 'babysit' ? 'Handed off. Babysitting is off, so nothing runs yet.' : 'Handed off. Reviews are off, so nothing runs yet.'
  return `Handed off: ${title.replace(/[.!?]+$/, '')}.`
}

/** The server's error line as a sentence: "no such item" → "No such item."; nothing → the fallback. */
export function verbErrorLine(err: string | null | undefined): string {
  const s = (err ?? '').trim()
  if (!s) return 'That didn’t go through.'
  const t = s.charAt(0).toUpperCase() + s.slice(1)
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/**
 * Sends held on an item, for Approve send…: how many, and the chat where the
 * oldest one's card waits.
 */
export function heldSends(actions: readonly { status: string; sessionId: string; attemptedAt: number }[]): { count: number; sessionId: string | null } {
  const held = actions.filter((a) => a.status === 'needs_you')
  if (!held.length) return { count: 0, sessionId: null }
  const oldest = held.reduce((o, a) => (a.attemptedAt < o.attemptedAt ? a : o))
  return { count: held.length, sessionId: oldest.sessionId || null }
}

// ---------------------------------------------------------------------------
// The palette's list: today's substring filter, section order, a cap per section
// ---------------------------------------------------------------------------

/** Each section shows at most this many rows; past it, one line says how many more. */
export const SECTION_CAP = 50

export type Listable<S extends string> = { id: string; section: S; label: string; hint?: string }

/** A substring over label + hint, sorted by section (stable within one). */
export function filterCommands<S extends string, C extends Listable<S>>(commands: readonly C[], query: string, order: readonly S[]): C[] {
  const q = query.trim().toLowerCase()
  const matched = q ? commands.filter((c) => (c.label + ' ' + (c.hint ?? '')).toLowerCase().includes(q)) : commands
  return [...matched].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section))
}

/** The filtered list cut into sections, each capped, with how many it left out. */
export function sectionsOf<S extends string, C extends Listable<S>>(list: readonly C[], cap = SECTION_CAP): { section: S; rows: C[]; more: number }[] {
  const out: { section: S; rows: C[]; more: number }[] = []
  for (const c of list) {
    let g = out[out.length - 1]
    if (!g || g.section !== c.section) out.push((g = { section: c.section, rows: [], more: 0 }))
    if (g.rows.length < cap) g.rows.push(c)
    else g.more++
  }
  return out
}

/** "38 more. Type to narrow." */
export const moreLine = (n: number) => `${n} more. Type to narrow.`
