/**
 * Next move: what to do on an item, and who makes the move, apart from its
 * rank. The score (score.ts) orders rows; this says what each row asks:
 *
 *   "Answer Priya · waited 2d · blocks release-4.2"
 *
 * Pure, browser-safe, no model output; time is an argument.
 *
 * The owner is read off whose turn it is (turn.ts), so a row's next move and
 * the tab it shows on can never disagree:
 *
 *   you      → you          Needs you
 *   junior   → junior       With Junior
 *   others   → person(name) Waiting   (name null: reviewers, the world)
 *
 * The action comes from one ordered table, NEXT_RULES, and the first match
 * wins. The order is a product opinion, so it lives in one place:
 *
 *   needs your decision → owes a reply → changes requested → conflict →
 *   red CI → needs review → ready to merge → fallback
 *
 * The fallback reads the turn: a finished run to read, something broke,
 * Junior paused, waiting on someone, else the item's own ask.
 *
 * The line is verb first and 15 words or fewer. When it runs long, reasons
 * drop from the end; the verb phrase always stays.
 */
import { askOf, type Ask } from './asks.js'
import type { ItemFlow } from './flow.js'
import { turnOf, type TurnContext, type TurnItem, type TurnOf, type TurnReason, type WhoseTurn } from './turn.js'
import type { WorkItem } from './types.js'

/** What the next move is. One per item. */
export type NextAction =
  | 'decide' // needs your decision: a prompt, a held send, Junior asks, a first pass to check
  | 'reply' // someone waits on your answer
  | 'changes' // changes requested on your PR
  | 'conflict' // your PR conflicts with its base
  | 'ci' // your PR's CI is red
  | 'review' // someone asked for a review
  | 'merge' // approved, unmerged
  | 'result' // a run finished: read what Junior did
  | 'fix' // something broke: a brief or a chat failed
  | 'resume' // you paused Junior on it
  | 'wait' // someone else has the move
  | 'do' // whatever the item itself asks

/** Who makes the move. A person's name is null when nobody is named (reviewers, the world). */
export type NextOwner = { kind: 'you' } | { kind: 'junior' } | { kind: 'person'; name: string | null }

export interface NextMove {
  action: NextAction
  owner: NextOwner
  /** whose turn it is, and why (turn.ts); the owner is read off it */
  turn: TurnOf
  /** the verb phrase: "Answer Priya", "Fix red CI" */
  verb: string
  /** short parts after it, most telling first: "waited 2d", "blocks release-4.2" */
  reasons: string[]
  /** the row's line, verb first, 15 words or fewer */
  text: string
}

/** What the rules read off an item. */
export type NextItem = TurnItem &
  Pick<WorkItem, 'author'> &
  Partial<Pick<WorkItem, 'updatedAt' | 'priority' | 'isDraft'>> & { flow?: ItemFlow }

/** What the item can't say about itself. */
export interface NextContext extends TurnContext {
  /** what it holds up, in a short name the caller resolved: "release-4.2", "NOV-412" */
  blocks?: string
}

/** The longest a line may run, in words (brand copy rule). */
export const MAX_WORDS = 15

/** Every word a line may open with. A test holds every line to this list. */
export const NEXT_VERBS: ReadonlySet<string> = new Set([
  'Accept',
  'Address',
  'Answer',
  'Approve',
  'Check',
  'Decide',
  'Do',
  'Fix',
  'Leave',
  'Make',
  'Merge',
  'Nudge',
  'Pick',
  'Read',
  'Resolve',
  'Resume',
  'Retry',
  'Review',
  'Send',
  'Skim',
  'Wait',
  'Work',
])

/** What every rule and phrase reads, worked out once. */
interface Facts {
  item: NextItem
  ctx: NextContext
  turn: TurnOf
  ask: Ask
  /** the person behind it, first name; null on your own to-dos and your own PRs */
  name: string | null
  ownPr: boolean
  /** not someone else's move */
  active: boolean
  now: number
}

/** Reasons where something holds until you answer (turn.ts). */
const DECISION_REASONS: ReadonlySet<TurnReason> = new Set(['session-blocked', 'held-send', 'junior-asks', 'first-pass-ready', 'task-on-you'])

/**
 * The rule order, first match wins. Every rule but `wait` and the fallback
 * stands aside when someone else has the move: their row says who to wait on.
 */
export const NEXT_RULES: readonly { action: NextAction; when: (x: Facts) => boolean }[] = [
  { action: 'decide', when: (x) => x.turn.turn === 'you' && (DECISION_REASONS.has(x.turn.reason) || x.ask === 'decide') },
  { action: 'reply', when: (x) => x.active && x.ask === 'reply' && x.item.kind !== 'reply-needed' },
  { action: 'changes', when: (x) => x.active && x.item.kind === 'reply-needed' },
  { action: 'conflict', when: (x) => x.active && (x.item.kind === 'own-pr-conflicting' || x.item.flow?.next === 'resolve conflicts') },
  { action: 'ci', when: (x) => x.active && ((x.ownPr && !!x.item.ciFailing) || x.item.flow?.next === 'fix CI') },
  { action: 'review', when: (x) => x.active && x.ask === 'review' },
  // merging is always yours (turn.ts): while Junior works the PR, its row says so instead
  { action: 'merge', when: (x) => x.turn.turn === 'you' && (x.item.kind === 'own-pr-approved' || x.item.flow?.next === 'merge') },
  // fallback
  { action: 'result', when: (x) => x.turn.reason === 'result-ready' },
  { action: 'fix', when: (x) => x.turn.reason === 'broken' },
  { action: 'resume', when: (x) => x.turn.reason === 'paused' },
  { action: 'wait', when: (x) => x.turn.turn === 'others' },
  { action: 'do', when: () => true },
]

/** "Priya Shah" → "Priya", "@niraj" → "niraj"; a to-do you wrote, or your own PR → null. */
function personOf(item: NextItem): string | null {
  if (item.source === 'manual' || item.kind.startsWith('own-pr-') || item.kind === 'reply-needed') return null
  const first = item.author.trim().replace(/^@/, '').split(/\s+/)[0]
  return first || null
}

/** What the thing is called where it lives. */
function noun(item: NextItem): string {
  if (item.source === 'github') return 'PR'
  if (item.source === 'slack') return 'thread'
  if (item.source === 'linear') return 'ticket'
  return 'ask'
}

const nameOr = (x: Facts, withName: (n: string) => string, without: string) => (x.name ? withName(x.name) : without)

/** The thing itself, as the object of a verb: "the ticket", "Priya's mention", "your PR". */
function objectOf(x: Facts): string {
  const k = x.item.kind
  if (x.ownPr || k === 'reply-needed') return 'your PR'
  if (k === 'ticket-assigned') return 'the ticket'
  if (k === 'manual') return 'the to-do'
  if (k === 'digest') return 'the digest'
  if (k === 'fyi') return 'the update'
  if (k === 'job-hit') return "the job's find"
  if (k === 'mention' || k === 'slack-mention') return nameOr(x, (n) => `${n}'s mention`, 'the mention')
  return nameOr(x, (n) => `${n}'s ${noun(x.item)}`, `the ${noun(x.item)}`)
}

/** The fallback: what the item asks of you, or, while Junior holds it, Junior working on it. */
const doVerb = (x: Facts): string => (x.turn.turn === 'junior' ? `Work on ${objectOf(x)}` : askVerb(x))

/** The verb phrase for what an item asks, used by the ask rules and the fallback. */
function askVerb(x: Facts): string {
  const k = x.item.kind
  switch (x.ask) {
    case 'review':
      return nameOr(x, (n) => `Review ${n}'s ${noun(x.item)}`, `Review the ${noun(x.item)}`)
    case 'reply':
      return nameOr(x, (n) => `Answer ${n}`, 'Send the reply')
    case 'decide':
      return nameOr(x, (n) => `Decide for ${n}`, 'Make the call')
    case 'follow-up':
      return nameOr(x, (n) => `Nudge ${n}`, 'Nudge the reviewers')
    case 'do':
      if (k === 'ticket-assigned') return 'Work the ticket'
      if (k === 'manual') return 'Do the to-do'
      return nameOr(x, (n) => `Do ${n}'s ask`, 'Do the task')
    case 'read':
      if (k === 'digest') return 'Read the digest'
      if (k === 'fyi') return 'Skim the update'
      if (k === 'job-hit') return "Read the job's find"
      return nameOr(x, (n) => `Read ${n}'s mention`, 'Read the mention')
  }
}

/** The decision waiting on you, by what holds. */
function decideVerb(x: Facts): string {
  const next = x.item.flow?.next
  switch (x.turn.reason) {
    case 'session-blocked':
      return "Answer Junior's chat"
    case 'held-send': {
      // the flow knows a send is held, not how many: the queue's count wins
      const n = Math.max(1, x.ctx.heldSends ?? 1)
      return n === 1 ? 'Approve the send' : `Approve ${n} sends`
    }
    case 'first-pass-ready':
      return "Check Junior's first pass"
    case 'task-on-you': {
      const t = x.item.tasks?.next
      if (t?.error) return "Check Junior's failed task"
      if (t?.step === 'request-review') return 'Pick a reviewer'
      if (t?.step === 'send-reply') return "Send Junior's draft reply"
      return 'Answer Junior on a task'
    }
    case 'junior-asks':
      if (next === 'approve the team') return 'Approve the team'
      if (next === 'approve the step') return 'Approve the team step'
      if (next === 'review the plan') return "Review Junior's plan"
      if (next === 'resume the team') return 'Resume the team'
      return 'Answer Junior'
    default:
      return askVerb(x)
  }
}

/** Who you wait on, and the phrase. */
function waitVerb(x: Facts): string {
  const f = x.item.flow
  switch (x.turn.reason) {
    case 'reviewers':
      return 'Wait on reviewers'
    case 'set-waiting':
      return f?.note ? `Wait on ${clip(f.note, 8)}` : 'Wait on someone'
    case 'world':
      return 'Wait on an outside change'
    case 'snoozed':
    case 'closed':
      return 'Leave it'
    default:
      return nameOr(x, (n) => `Wait on ${n}`, 'Wait on someone')
  }
}

const RESULT_VERB: Record<string, string> = {
  'read brief': 'Read the brief',
  'accept the result': "Accept the team's result",
}

const FIX_VERB: Record<string, string> = {
  'brief failed': 'Retry the brief',
  'session failed': 'Check the failed chat',
}

const VERB: Record<NextAction, (x: Facts) => string> = {
  decide: decideVerb,
  reply: askVerb,
  changes: () => 'Address the requested changes',
  conflict: () => 'Resolve conflicts',
  ci: () => 'Fix red CI',
  review: askVerb,
  merge: () => 'Merge your PR',
  result: (x) => RESULT_VERB[x.item.flow?.next ?? ''] ?? "Review Junior's work",
  fix: (x) => FIX_VERB[x.item.flow?.broken ?? ''] ?? 'Check what broke',
  resume: () => 'Resume Junior, or do it yourself',
  wait: waitVerb,
  do: doVerb,
}

function ownerOf(x: Facts): NextOwner {
  if (x.turn.turn === 'you') return { kind: 'you' }
  if (x.turn.turn === 'junior') return { kind: 'junior' }
  // a person is named only where the item's author holds the move
  const named = x.turn.reason === 'review-posted' || x.turn.reason === 'follow-up'
  return { kind: 'person', name: named ? x.name : null }
}

/** "3h", "2d"; under an hour says nothing. */
function age(ms: number): string | null {
  if (!(ms >= 3_600_000)) return null
  return ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`
}

function sinceOf(item: NextItem): number {
  const s = item.flow?.since
  if (s && s > 0) return s
  const t = item.updatedAt ? Date.parse(item.updatedAt) : NaN
  return Number.isFinite(t) ? t : NaN
}

const HUMAN_ASKS: ReadonlySet<Ask> = new Set(['review', 'reply', 'decide'])

function reasonsOf(x: Facts, action: NextAction): string[] {
  const { item, turn } = x
  const out: string[] = []
  const a = age(x.now - sinceOf(item))
  if (turn.turn === 'junior') out.push('with Junior')
  else if (turn.turn === 'others') {
    if (turn.reason === 'review-posted') out.push('review posted')
    if (a && turn.reason !== 'snoozed' && turn.reason !== 'closed') out.push(`waiting ${a}`)
    if (turn.reason === 'snoozed') out.push('snoozed')
    if (turn.reason === 'closed') out.push('closed')
  } else if (a) {
    const person = x.name !== null && (item.peopleWaiting > 0 || HUMAN_ASKS.has(x.ask))
    out.push(person ? `waited ${a}` : `open ${a}`)
  }
  if (x.ctx.blocks?.trim()) out.push(`blocks ${clip(x.ctx.blocks.trim(), 3)}`)
  if (item.peopleWaiting > 1) out.push(`${item.peopleWaiting} waiting`)
  if (item.priority === 1) out.push('urgent')
  else if (item.priority === 2) out.push('high priority')
  // red CI that isn't the move itself
  const red = (x.ownPr || item.kind === 'reply-needed') && item.ciFailing
  if (red && action !== 'ci' && action !== 'decide') out.push('CI red too')
  const broken = item.flow?.broken
  if (broken && broken !== 'CI failing' && action !== 'fix') out.push(broken)
  const paused = item.handoff === 'paused' || item.junior?.stage === 'paused'
  if (paused && action !== 'resume') out.push('Junior paused')
  if (item.isDraft && x.ownPr) out.push('draft')
  return out
}

/** The first `n` words of `s`. */
function clip(s: string, n: number): string {
  const words = s.trim().split(/\s+/)
  return words.length <= n ? words.join(' ') : words.slice(0, n).join(' ')
}

/** Words in a line, not counting the dots between parts. */
export function wordCount(line: string): number {
  return line.split(/\s+/).filter((w) => w && w !== '·').length
}

/** The row's line: verb first, then reasons, dropped from the end until it fits in 15 words. */
export function nextMoveLine(verb: string, reasons: readonly string[]): string {
  const head = clip(verb, MAX_WORDS)
  let line = head
  for (const r of reasons) {
    const next = `${line} · ${r}`
    if (wordCount(next) > MAX_WORDS) break
    line = next
  }
  return line
}

function factsOf(item: NextItem, ctx: NextContext, now: number): Facts {
  const turn = turnOf(item, ctx)
  const ask = askOf({ kind: item.kind, ...(item.ask !== undefined ? { ask: item.ask } : {}) })
  return { item, ctx, turn, ask, name: personOf(item), ownPr: item.kind.startsWith('own-pr-'), active: turn.turn !== 'others', now }
}

/** The next move on an item, and who makes it. Total: any item shape gets one answer. */
export function nextMove(item: NextItem, ctx: NextContext = {}, now = Date.now()): NextMove {
  const x = factsOf(item, ctx, now)
  const action = NEXT_RULES.find((r) => r.when(x))!.action
  const verb = VERB[action](x)
  const reasons = reasonsOf(x, action)
  return { action, owner: ownerOf(x), turn: x.turn, verb, reasons, text: nextMoveLine(verb, reasons) }
}

/** The owner as a row shows it: "You", "Junior", "Priya", "Others". */
export function ownerLabel(o: NextOwner): string {
  return o.kind === 'you' ? 'You' : o.kind === 'junior' ? 'Junior' : (o.name ?? 'Others')
}

const TURN_ORDER: Record<WhoseTurn, number> = { you: 0, junior: 1, others: 2 }

/**
 * Rows by turn (you, Junior, others), then by score within a turn, then id,
 * so the order is total. The next move never reorders a turn: the score does.
 */
export function byTurnThenScore(a: { turn: WhoseTurn; score: number; id: string }, b: { turn: WhoseTurn; score: number; id: string }): number {
  return TURN_ORDER[a.turn] - TURN_ORDER[b.turn] || b.score - a.score || a.id.localeCompare(b.id)
}
