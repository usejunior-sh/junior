/**
 * The brief: one paragraph, like a person catching you up. Composed
 * deterministically from facts the server gathered (no model in v1): what
 * finished while you were away, what came in by source, and who you are
 * blocking. References come out as segments the page renders as inline
 * buttons. Three voices. Pure and browser-safe.
 *
 * TODO(junior): an LLM-written brief is out of scope until Samar decides it.
 */
import { cap, numberWord, waitedWords } from './greeting.js'
import type { Voice } from './persona.js'

/** What a reference in the brief opens. */
export type BriefTarget =
  | { kind: 'session'; id: string }
  | { kind: 'item'; id: string }
  | { kind: 'job'; id: string }
  | { kind: 'actions' }

export type BriefRef = { label: string; target: BriefTarget }
/** Plain text, or a reference rendered as an underlined button. */
export type Segment = string | BriefRef

/** Something Junior finished in the window. */
export type Finished =
  /** a work item whose session or team ended and now waits on your review */
  | { kind: 'item'; itemId: string; title: string }
  /** a job's runs that ended ok in the window, folded per job */
  | { kind: 'job'; jobId: string; title: string; runs: number; filed: number }

/** Someone waiting on you: a review request, a question, a decision. */
export type Blocking = {
  itemId: string
  who: string
  ask: 'review' | 'reply' | 'decide'
  /** where, short: "#479", "#api", "NOV-123" */
  where: string
  since: number
}

export type BriefFacts = {
  /** the window's start (epoch ms) */
  since: number
  /** the window began with a real absence ("while you were away"), not "so far today" */
  away: boolean
  finished: Finished[]
  /** outbound actions that went out in the window */
  sent: number
  /** items that came in, by source, biggest first */
  arrived: { label: string; count: number }[]
  /** oldest first */
  blocking: Blocking[]
}

/** At most this many of anything is named in a sentence; the rest is counted. */
const MAX_LISTED = 2

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** "A", "A and B", "A, B and C", over segments, so a reference stays a reference. `and = ','` = a plain list. */
function joinList(parts: Segment[][], and = 'and'): Segment[] {
  const out: Segment[] = []
  const last = and === ',' ? ', ' : ` ${and} `
  parts.forEach((p, i) => {
    if (i > 0) out.push(i === parts.length - 1 ? last : ', ')
    out.push(...p)
  })
  return out
}

/** The first MAX_LISTED, then the rest as one counted part ("two more"). */
function capped<T>(xs: readonly T[], each: (x: T, i: number) => Segment[], more: (n: number) => string): Segment[][] {
  const shown = xs.slice(0, MAX_LISTED).map(each)
  if (xs.length > MAX_LISTED) shown.push([more(xs.length - MAX_LISTED)])
  return shown
}

/** "#477" and "NOV-123" are things: on. "#api" is a place: in. */
const prep = (where: string) => (/^#\d+$/.test(where) || /^[A-Z][A-Z0-9]*-\d+$/.test(where) || !where.startsWith('#') ? 'on' : 'in')

const ASK_PHRASE: Record<Blocking['ask'], (where: string) => string> = {
  review: (w) => `your review ${prep(w)} ${w}`,
  reply: (w) => `a reply ${prep(w)} ${w}`,
  decide: (w) => `a decision ${prep(w)} ${w}`,
}

type ItemDone = Extract<Finished, { kind: 'item' }>
type JobDone = Extract<Finished, { kind: 'job' }>

const itemRef = (f: ItemDone): Segment[] => [{ label: f.title, target: { kind: 'item', id: f.itemId } }]
const jobRef = (f: JobDone): BriefRef => ({ label: f.title, target: { kind: 'job', id: f.jobId } })
const personRef = (b: Blocking): BriefRef => ({ label: b.who, target: { kind: 'item', id: b.itemId } })

/** One ask per person, their longest wait, oldest first. Someone with three asks is one person blocked. */
export function byPerson(b: readonly Blocking[]): Blocking[] {
  const first = new Map<string, Blocking>()
  for (const x of [...b].sort((a, c) => a.since - c.since)) {
    const k = x.who.toLowerCase()
    if (!first.has(k)) first.set(k, x)
  }
  return [...first.values()]
}

/** Jobs, busiest first: what they filed, then how often they ran. */
const busiest = (jobs: JobDone[]) => [...jobs].sort((a, b) => b.filed - a.filed || b.runs - a.runs || a.title.localeCompare(b.title))

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${numberWord(n)} times`)

/** Normalise what a composer emits: adjacent strings merged, empty strings dropped, no trailing space. */
function tidy(segs: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    if (typeof s === 'string') {
      if (!s) continue
      const last = out[out.length - 1]
      if (typeof last === 'string') out[out.length - 1] = last + s
      else out.push(s)
    } else out.push(s)
  }
  const end = out[out.length - 1]
  if (typeof end === 'string') out[out.length - 1] = end.trimEnd()
  return out
}

/**
 * The brief as segments, in `voice`, at `now`. At most four short sentences:
 * what finished (items, then jobs), what went out, what came in, who waits on
 * you. Two of anything are named; the rest are counted.
 */
export function composeBrief(f: BriefFacts, voice: Voice, now: number): Segment[] {
  if (voice === 'terse') return tidy(terse(f, now))
  const warm = voice === 'warm'
  const out: Segment[] = []
  const items = f.finished.filter((x): x is ItemDone => x.kind === 'item')
  const jobs = busiest(f.finished.filter((x): x is JobDone => x.kind === 'job'))
  const lead = f.away ? 'while you were away' : 'so far today'

  if (items.length) {
    const list = joinList(capped(items, itemRef, (n) => `${numberWord(n)} more`))
    out.push(warm ? `Good news first: ${lead} I finished ` : `${cap(lead)} I finished `, ...list, `. ${plural(items.length, 'It waits', 'They wait')} for your review. `)
  }
  if (jobs.length) {
    const top = jobs[0]
    out.push(jobs.length === 1 ? 'The ' : '', jobRef(top), `${jobs.length === 1 ? ' job' : ''} ran ${times(top.runs)}`)
    out.push(top.filed ? ` and filed ${numberWord(top.filed)} ${plural(top.filed, 'item', 'items')}` : '')
    out.push(jobs.length > 1 ? `; ${numberWord(jobs.length - 1)} other ${plural(jobs.length - 1, 'job', 'jobs')} ran too. ` : '. ')
  }
  if (f.sent > 0) {
    out.push({ label: `${cap(numberWord(f.sent))} ${plural(f.sent, 'send', 'sends')}`, target: { kind: 'actions' } }, ' went out. ')
  }

  const total = f.arrived.reduce((n, a) => n + a.count, 0)
  if (total > 0) {
    const named = f.arrived.slice(0, 3).map((a): Segment[] => [`${f.arrived.length === 1 ? '' : `${a.count} `}from ${a.label}`])
    const rest = f.arrived.slice(3).reduce((n, a) => n + a.count, 0)
    if (rest) named.push([`${rest} from elsewhere`])
    out.push(`${cap(numberWord(total))} new ${plural(total, 'item', 'items')} came in`, f.arrived.length === 1 ? ' ' : warm ? ', ' : ': ', ...joinList(named), '. ')
  } else if (out.length) {
    out.push('Nothing new came in. ')
  }

  const people = byPerson(f.blocking)
  if (people.length) {
    const each = (b: Blocking, i: number): Segment[] => [personRef(b), `${i === 0 ? ' has waited ' : ' '}${waitedWords(b.since, now)} for ${ASK_PHRASE[b.ask](b.where)}`]
    const list = joinList(capped(people, each, (n) => `${numberWord(n)} more`))
    if (warm) out.push(`${cap(numberWord(people.length))} ${plural(people.length, 'person is', 'people are')} waiting on you${items.length ? ', though' : ''}: `, ...list, '.')
    else out.push(`You're blocking ${numberWord(people.length)} ${plural(people.length, 'person', 'people')}: `, ...list, '.')
  } else if (out.length) {
    out.push(warm ? 'And nobody is waiting on you.' : 'Nobody is waiting on you.')
  }

  if (!out.length) return [warm ? 'All quiet so far. Nothing new came in, and nobody is waiting on you.' : 'Quiet so far. Nothing finished, nothing new, and nobody is waiting on you.']
  return tidy(out)
}

function terse(f: BriefFacts, now: number): Segment[] {
  const out: Segment[] = []
  const items = f.finished.filter((x): x is ItemDone => x.kind === 'item')
  const jobs = busiest(f.finished.filter((x): x is JobDone => x.kind === 'job'))
  const more = (n: number) => `+${n}`
  if (items.length) out.push('Done: ', ...joinList(capped(items, itemRef, more), ','), '. ')
  if (jobs.length) out.push('Jobs: ', ...joinList(capped(jobs, (j) => [jobRef(j), ` ×${j.runs}${j.filed ? ` (${j.filed} filed)` : ''}`], more), ','), '. ')
  if (f.sent > 0) out.push({ label: `Sent: ${f.sent}`, target: { kind: 'actions' } }, '. ')
  if (f.arrived.length) out.push('In: ', f.arrived.map((a) => `${a.count} ${a.label.replace(/^the /, '')}`).join(', '), '. ')
  const people = byPerson(f.blocking)
  if (people.length) out.push('Blocking: ', ...joinList(capped(people, (b) => [personRef(b), ` (${b.where}, ${shortAge(b.since, now)})`], more), ','), '.')
  if (!out.length) return ['Quiet.']
  return out
}

function shortAge(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** The brief as plain text, for tests and for a session's context. */
export function briefText(segs: Segment[]): string {
  return segs.map((s) => (typeof s === 'string' ? s : s.label)).join('')
}
