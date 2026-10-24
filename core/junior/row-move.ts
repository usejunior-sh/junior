/**
 * The Ledger row's first line: the next move (core/work/next.ts), split the
 * way a row shows it (.docs/overnight-2026-10-24/designs/next-move-rows.md).
 *
 *   Answer Priya · 2 waiting · urgent            ← verb in ink, reasons in mono ash
 *   Is the 4.2 release checklist final?          ← the item's title, quieter
 *
 * The server makes each item's move with what only it knows (a chat on a
 * prompt, sends held for the item) and serves it on the day (`servedMoves`).
 * The row takes it while it still matches the item it sees (`moveKey`); else
 * it makes the move again in the browser with the served context, so a row
 * never waits on a fetch and never shows a stale move (`rowMove`).
 *
 * Two reasons leave the line because the row already says them in a column:
 * the age (the age column shows that same number) and "with Junior" (the sky
 * state column says it; a phone hides that column, so there it stays).
 *
 * ⏎ takes the move's verb only where pressing it finishes the move: opening
 * to read, or resuming (`enterVerb`). It never names a move it can't finish.
 *
 * Pure and browser-safe.
 */
import { nextMove, type NextAction, type NextContext, type NextItem } from '../work/next.js'
import type { TurnContext } from '../work/turn.js'
import { mainRedOnly } from '../work/handoff.js'

/** One item's move as the server made it, on the day (`JuniorDay.moves`). */
export type RowMove = {
  action: NextAction
  verb: string
  reasons: string[]
  text: string
  /** what the item looked like when the move was made (`moveKey`): a row whose item moved on makes its own */
  key: string
  /** what only the server knows about the item; a row remaking the move reuses it */
  ctx?: TurnContext
}

/** The item fields a move reads, plus its id. */
export type MoveItem = NextItem & { id: string; updatedAt: string }

/**
 * Everything on an item a move reads that can change while the day sits in
 * the browser: the source time, and Junior's state on it. Equal keys, same move.
 */
export function moveKey(i: MoveItem): string {
  const f = i.flow
  const t = i.tasks
  return [
    i.updatedAt,
    i.status ?? '',
    i.handoff ?? '',
    i.junior?.stage ?? '',
    i.junior?.readiness?.state ?? '',
    t?.review?.state ?? '',
    t?.next?.id ?? '',
    t?.next?.error ? 'err' : '',
    t?.needsYou ?? 0,
    f?.turn ?? '',
    f?.next ?? '',
    f?.broken ?? '',
    f?.overridden ? 'o' : '',
    i.ciFailing ? 'red' : '',
    mainRedOnly(i.seen) ? 'main-red' : '',
    i.seen?.graceUntil ?? '',
    i.seen?.fixes ?? '',
    i.peopleWaiting,
    i.priority ?? '',
  ].join('|')
}

/** The server's move per item, keyed by id. `ctxOf` gives what only the server knows. */
export function servedMoves(items: readonly MoveItem[], ctxOf: (id: string) => TurnContext | undefined, now: number): Record<string, RowMove> {
  const out: Record<string, RowMove> = {}
  for (const i of items) {
    const ctx = ctxOf(i.id)
    const m = nextMove(i, ctx ?? {}, now)
    out[i.id] = { action: m.action, verb: m.verb, reasons: m.reasons, text: m.text, key: moveKey(i), ...(ctx && (ctx.blocked || ctx.heldSends) ? { ctx } : {}) }
  }
  return out
}

/** What a row draws on its first line, and the words around it. */
export type RowLine = {
  action: NextAction
  verb: string
  /** the reasons the line holds, minus the age and "with Junior" */
  reasons: string[]
  /** "with Junior" was on the line: the state column says it, a phone shows it */
  withJunior: boolean
  /** the line's age ("2d"), for the age column; null under an hour */
  age: string | null
  /** the age in words for the age cell's hover: "Waited 2 days" */
  ageWords: string | null
  /** the full line, age included: the row's accessible name opens with it */
  text: string
}

const AGE = /^(waited|open|waiting) (\d+)([hd])$/
const WORD: Record<string, string> = { waited: 'Waited', open: 'Open', waiting: 'Waiting' }

/** "waited 2d" → "Waited 2 days". */
export function ageWords(reason: string): string | null {
  const m = AGE.exec(reason)
  if (!m) return null
  const n = Number(m[2])
  const unit = m[3] === 'd' ? 'day' : 'hour'
  return `${WORD[m[1]!]} ${n} ${unit}${n === 1 ? '' : 's'}`
}

/** The reasons that fit on the line: the parts of `text` after the verb. */
function fitted(verb: string, reasons: readonly string[], text: string): string[] {
  if (!text.startsWith(verb)) return []
  const parts = text.slice(verb.length).split(' · ').slice(1)
  return reasons.slice(0, parts.length)
}

/**
 * The row's line: the served move while it matches the item, else one made
 * here with the served context. Null when there is no verb to show: the row
 * falls back to its title-first shape, never blank.
 */
export function rowMove(item: MoveItem, served: RowMove | undefined, now: number): RowLine | null {
  let m: { action: NextAction; verb: string; reasons: string[]; text: string }
  // a grace window that has passed: the served line still says "fix after", so make it again
  const graceOver = typeof item.seen?.graceUntil === 'number' && item.seen.graceUntil <= now
  if (served && served.key === moveKey(item) && !graceOver) m = served
  else {
    try {
      m = nextMove(item, (served?.ctx ?? {}) as NextContext, now)
    } catch {
      return null
    }
  }
  const verb = m.verb?.trim()
  if (!verb) return null
  let age: string | null = null
  let words: string | null = null
  let withJunior = false
  const reasons: string[] = []
  for (const r of fitted(m.verb, m.reasons, m.text)) {
    const a = AGE.exec(r)
    if (a && age === null) {
      age = `${a[2]}${a[3]}`
      words = ageWords(r)
    } else if (r === 'with Junior') withJunior = true
    else reasons.push(r)
  }
  return { action: m.action, verb, reasons, withJunior, age, ageWords: words, text: m.text }
}

/** What ⏎ does when it takes the move's verb. */
export type EnterVerb = { label: string; does: 'open' | 'resume' }

const OPENS: Partial<Record<NextAction, readonly string[]>> = {
  decide: ["Check Junior's first pass"],
  result: ['Read the brief', "Review Junior's work"],
  fix: ['Check what broke', 'Check the failed chat'],
}

/**
 * ⏎'s label and deed where pressing it finishes the move, else null (⏎ keeps
 * today's label). `pausedHandoff`: only a paused hand-off resumes on ⏎, as today.
 */
export function enterVerb(move: Pick<RowLine, 'action' | 'verb'> | null, pausedHandoff: boolean): EnterVerb | null {
  if (!move) return null
  if (OPENS[move.action]?.includes(move.verb)) return { label: move.verb, does: 'open' }
  if (move.action === 'resume' && pausedHandoff) return { label: 'Resume Junior', does: 'resume' }
  return null
}

/** The row button's accessible name: the full line, then the title, the state and the ref, each a sentence. */
export function rowLabel(parts: readonly (string | null | undefined)[]): string {
  return parts
    .map((p) => p?.trim().replace(/[.\s]+$/, ''))
    .filter((p): p is string => !!p)
    .map((p) => `${p}.`)
    .join(' ')
}
