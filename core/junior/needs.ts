/**
 * Needs you: everything that holds Junior until you answer, as rows. Each
 * source is reduced to a small shape by the server and composed here, so a
 * new source (goal plans, when goals land) is one more list and one more
 * mapper, not a new page. Pure and browser-safe.
 *
 * Each row also leads with a move, like an item row on the Ledger
 * (core/junior/row-move.ts): a verb, then short reasons, 15 words or fewer
 * (`move`), over what it is about (`subject`).
 */
import { MAX_WORDS, wordCount } from '../work/next.js'

export type NeedsTarget = { kind: 'session'; id: string } | { kind: 'actions' }

/** A row's first line: the verb in ink, then reasons in mono. Verb first, 15 words or fewer. */
export type NeedsMove = { verb: string; reasons: string[] }

export type NeedsRow = {
  /** stable across refetches: `<kind>:<id>` */
  key: string
  kind: 'session' | 'plan' | 'gate' | 'revision' | 'sends'
  title: string
  /** the middle column: where it came from, what it is */
  meta: string
  /** the right column: cost, count, age */
  right: string
  /** the verb on the row */
  go: string
  /** line 1: what to do, and why */
  move: NeedsMove
  /** line 2: what it is about */
  subject: string
  target: NeedsTarget
  /** when it started waiting (epoch ms) */
  since: number
}

/** A session held on a prompt. */
export type BlockedSource = { id: string; title: string; waitingOn?: string; at: number }

/** Sends one session drafted that wait for your OK (queued actions). */
export type SendsSource = { sessionId: string; origin: string; titles: string[]; at: number }

/** A team run waiting on you: its card (proposed), a gate, or a change to its plan. */
export type TeamSource = {
  runId: string
  leadSessionId: string
  label: string
  goal: string
  state: 'proposed' | 'gate' | 'revision'
  steps: number
  team: string | null
  budgetUsd: number
  /** a gate's reason, a revision's why */
  reason?: string
  at: number
}

export type NeedsSources = {
  blocked: readonly BlockedSource[]
  teams: readonly TeamSource[]
  sends: readonly SendsSource[]
  // TODO(junior): goal plans waiting on you join here once goals land (feat/goals-and-teams).
}

/** "Permission: Bash" or "Question": what a held session is waiting on. */
export function waitingOnText(waitingOn: string | undefined): string {
  if (!waitingOn) return 'Waiting on you'
  if (waitingOn === 'AskUserQuestion') return 'Question'
  return `Permission: ${waitingOn.replace(/^mcp__.+?__/, '')}`
}

/** "PR #486 and a reply to Marcus wait for your OK". */
export function sendsTitle(titles: readonly string[]): string {
  const t = titles.filter(Boolean)
  if (t.length === 0) return 'A send waits for your OK'
  if (t.length === 1) return `${t[0]} waits for your OK`
  if (t.length === 2) return `${t[0]} and ${t[1]} wait for your OK`
  return `${t[0]} and ${t.length - 1} more wait for your OK`
}

/** "PR #486 and a reply to Marcus", "PR #486 and 2 more": the sends, without "wait for your OK". */
export function sendsSubject(titles: readonly string[]): string {
  const t = titles.filter(Boolean)
  if (t.length === 0) return 'A send'
  if (t.length === 1) return t[0]!
  if (t.length === 2) return `${t[0]} and ${t[1]}`
  return `${t[0]} and ${t.length - 1} more`
}

/** Free text as a reason: its first `n` words, with an ellipsis when cut. */
function clipReason(s: string | undefined, n = 8): string | null {
  const words = (s ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  return words.length <= n ? words.join(' ') : `${words.slice(0, n).join(' ')}…`
}

/** The move, with reasons dropped from the end until the line fits in 15 words. */
export function needsMove(verb: string, reasons: readonly (string | null | undefined)[]): NeedsMove {
  const kept: string[] = []
  for (const r of reasons) {
    if (!r) continue
    if (wordCount([verb, ...kept, r].join(' · ')) > MAX_WORDS) break
    kept.push(r)
  }
  return { verb, reasons: kept }
}

/** The move as one line: "Approve 2 sends · from the Babysit job". */
export const needsMoveText = (m: NeedsMove): string => [m.verb, ...m.reasons].join(' · ')

const money = (usd: number) => (usd >= 10 ? `~$${Math.round(usd)}` : `~$${usd.toFixed(usd >= 1 ? 0 : 2)}`)

function age(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000))
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/**
 * The rows, most holding first: a session stopped mid-turn, then plans and
 * gates (nothing starts without you), then sends. Oldest first within each.
 */
export function needsRows(s: NeedsSources, now: number): NeedsRow[] {
  const byAge = <T extends { at: number }>(xs: readonly T[]) => [...xs].sort((a, b) => a.at - b.at)
  const rows: NeedsRow[] = []
  for (const b of byAge(s.blocked)) {
    rows.push({
      key: `session:${b.id}`,
      kind: 'session',
      title: b.title,
      meta: waitingOnText(b.waitingOn),
      right: age(b.at, now),
      go: b.waitingOn === 'AskUserQuestion' ? 'Answer' : 'Open',
      move:
        b.waitingOn === 'AskUserQuestion'
          ? needsMove("Answer Junior's question", [])
          : needsMove("Answer Junior's chat", [b.waitingOn ? waitingOnText(b.waitingOn) : null]),
      subject: b.title,
      target: { kind: 'session', id: b.id },
      since: b.at,
    })
  }
  for (const t of byAge(s.teams)) {
    const target = { kind: 'session' as const, id: t.leadSessionId }
    if (t.state === 'proposed') {
      rows.push({
        key: `plan:${t.runId}`,
        kind: 'plan',
        title: `Review my plan: ${t.goal || t.label}`,
        meta: `${t.steps} ${t.steps === 1 ? 'step' : 'steps'}${t.team ? ` · ${t.team}` : ''}`,
        right: money(t.budgetUsd),
        go: 'Review',
        move: needsMove("Review Junior's plan", [`${t.steps} ${t.steps === 1 ? 'step' : 'steps'}`, t.team]),
        subject: t.goal || t.label,
        target,
        since: t.at,
      })
    } else if (t.state === 'gate') {
      rows.push({
        key: `gate:${t.runId}`,
        kind: 'gate',
        title: `${t.label}: a step waits for your OK`,
        meta: t.reason ?? '',
        right: age(t.at, now),
        go: 'Review',
        move: needsMove('Approve the team step', [clipReason(t.reason)]),
        subject: t.label,
        target,
        since: t.at,
      })
    } else {
      rows.push({
        key: `revision:${t.runId}`,
        kind: 'revision',
        title: `${t.label}: I'd like to change the plan`,
        meta: t.reason ?? '',
        right: age(t.at, now),
        go: 'Review',
        move: needsMove("Review Junior's plan change", [clipReason(t.reason)]),
        subject: t.label,
        target,
        since: t.at,
      })
    }
  }
  for (const a of byAge(s.sends)) {
    rows.push({
      key: `sends:${a.sessionId}`,
      kind: 'sends',
      title: sendsTitle(a.titles),
      meta: `from ${a.origin}`,
      right: `${a.titles.length} ${a.titles.length === 1 ? 'send' : 'sends'}`,
      go: 'Review',
      move: needsMove(a.titles.length > 1 ? `Approve ${a.titles.length} sends` : 'Approve the send', [clipReason(`from ${a.origin}`)]),
      subject: sendsSubject(a.titles),
      target: { kind: 'actions' },
      since: a.at,
    })
  }
  return rows
}
