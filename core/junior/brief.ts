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
import { quieted, readyOf } from './ledger.js'
import { checksPhrase, mainRedEvidence } from './main-red.js'
import { sourceOf } from '../../shared/sources.js'
import type { ScoredItem } from '../work/types.js'

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
  if (f.arrived.length) out.push('In: ', f.arrived.map((a) => `${a.count} ${a.label.replace(/^(the|a) /, '')}`).join(', '), '. ')
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

/* ------------------------------------------------------------------------ *
 * The cited brief (plan item `cited-brief`): three short lines on an open
 * Needs you card, each ending in a link to where the fact came from.
 *
 *   Waiting     Priya asked for your review. Dev asked in Slack too.   #412 ↗  Slack ↗
 *   Last time   You marked it done. New activity brought it back.      #412 ↗
 *   Now         CI is failing on this PR.                              checks ↗
 *
 * Built only from facts the item already carries: no model call, and no
 * Junior-written text (its decisions and summaries are skipped). A line with
 * no valid link is dropped. Pure and browser-safe; time is an argument.
 * ------------------------------------------------------------------------ */

export type BriefLineId = 'waiting' | 'last' | 'now'

/** A link at the end of a brief line: an `https://` page, or an item page in the app (`#/item/…`). */
export type Cite = { label: string; href: string; external: boolean; aria: string }

/** One brief line: 1 or 2 cites, never 0. `full` is the uncut text, for a title. */
export type BriefLine = { id: BriefLineId; text: string; full: string; cites: Cite[] }

export type BriefItem = Pick<
  ScoredItem,
  'id' | 'source' | 'reason' | 'author' | 'url' | 'peopleWaiting' | 'linked' | 'seen' | 'tasks' | 'memory' | 'returned' | 'notUseful' | 'updatedAt' | 'ciFailing' | 'repo'
>

const HTTPS = /^https:\/\/\S+$/
const GITHUB_PR = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The item's own page in the app: the same route as web/src/hooks.ts itemHash. */
export const itemPageHref = (id: string): string => `#/item/${encodeURIComponent(id)}`

const nameOf = (author: string | undefined): string => (author ?? '').trim().replace(/^@/, '')
const samePerson = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The first `n` words, with "…" when cut. */
function words(s: string, n: number): { text: string; cut: boolean } {
  const w = s.trim().split(/\s+/).filter(Boolean)
  return w.length > n ? { text: `${w.slice(0, n).join(' ')}…`, cut: true } : { text: w.join(' '), cut: false }
}

/** Ends a sentence once: "keep it" → "keep it.", "keep it!" stays, "keep it…" stays. */
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s.replace(/[,;:]+$/, '')}.`)

/** The link to the item at its source: "#412" on GitHub, "Slack", or the source's name. Null on a bad url. */
function sourceCite(i: Pick<BriefItem, 'id' | 'source' | 'repo' | 'url'>): Cite | null {
  if (!HTTPS.test(i.url ?? '')) return null
  const d = sourceOf(i.source)
  if (d.id === 'github') {
    const ref = d.ref({ id: i.id, source: i.source, repo: i.repo, url: i.url })
    return ref ? { label: ref, href: i.url, external: true, aria: `Open ${ref} on GitHub` } : { label: 'GitHub', href: i.url, external: true, aria: 'Open in GitHub' }
  }
  if (d.id === 'slack') return slackCite(i.url)
  return { label: d.label, href: i.url, external: true, aria: `Open in ${d.label}` }
}

const slackCite = (url: string): Cite | null => (HTTPS.test(url) ? { label: 'Slack', href: url, external: true, aria: 'Open the Slack thread' } : null)

const internalCite = (id: string, what: 'notes' | 'tasks'): Cite => ({ label: what, href: itemPageHref(id), external: false, aria: `Open its ${what} in Junior` })

/** A part of a line: a sentence and the cite that backs it. */
type Part = { text: string; cite: Cite }

function line(id: BriefLineId, parts: Part[], tail = '', full?: string): BriefLine {
  const text = [...parts.map((p) => p.text), tail].filter(Boolean).join(' ')
  const cites: Cite[] = []
  for (const p of parts) if (!cites.some((c) => c.href === p.cite.href && c.label === p.cite.label)) cites.push(p.cite)
  return { id, text, full: full ?? text, cites }
}

/** Who waits on you, and why. Omitted on your own PR, a job's find and your own to-do. */
function waitingLine(i: BriefItem, me: string | null): BriefLine | null {
  if (i.reason === 'your-pr' || i.reason === 'found' || i.reason === 'you-added') return null
  const author = nameOf(i.author)
  const mine = !!me && !!author && samePerson(author, nameOf(me))
  const own = sourceCite(i)

  let primary: Part | null = null
  if (author && !mine && own) {
    const d = sourceOf(i.source)
    if (i.reason === 'review-requested') primary = { text: `${author} asked for your review.`, cite: own }
    else if (i.reason === 'asked' && d.id === 'slack') {
      const where = d.ref({ id: i.id, source: i.source, repo: i.repo, url: i.url }) ?? 'Slack'
      primary = { text: `${author} asked you in ${where}.`, cite: own }
    } else if (i.reason === 'asked') primary = { text: `${author} is waiting on you.`, cite: own }
    else if (i.reason === 'mentioned') primary = { text: `${author} mentioned you here.`, cite: own }
    else if (i.reason === 'assigned') primary = { text: `${author} opened it. It's assigned to you.`, cite: own }
  }

  // Slack askers on linked items, not the person already named, each with a working link
  const askers: { name: string; cite: Cite }[] = []
  for (const l of i.linked ?? []) {
    if (l.source !== 'slack') continue
    const name = nameOf(l.author)
    const cite = slackCite(l.url)
    if (!name || !cite || (me && samePerson(name, nameOf(me)))) continue
    if ((primary && samePerson(name, author)) || askers.some((a) => samePerson(a.name, name))) continue
    askers.push({ name, cite })
  }

  const parts: Part[] = []
  if (primary) parts.push(primary)
  const slack = askers[0]
  if (slack) parts.push({ text: primary ? `${slack.name} asked in Slack too.` : `${slack.name} asked about this in Slack.`, cite: slack.cite })
  if (!parts.length) return null

  const more = Math.max(0, (i.peopleWaiting ?? 0) - parts.length)
  return line('waiting', parts, more === 0 ? '' : more === 1 ? '1 more waits too.' : `${more} more wait too.`)
}

/** "Oct 20", or "Oct 20, 2025" when it isn't this year. */
function dayOf(at: number, now: number): string {
  const d = new Date(at)
  const s = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(now).getFullYear() ? s : `${s}, ${d.getFullYear()}`
}

/** What happened last time: you closed it, you quieted it, you decided something, or Junior finished a step. */
function lastLine(i: BriefItem, now: number): BriefLine | null {
  const own = sourceCite(i)
  if (i.returned && own) return line('last', [{ text: 'You marked it done. New activity brought it back.', cite: own }])
  if (i.notUseful && !quieted(i) && own) return line('last', [{ text: 'You marked it not useful. Something new happened since.', cite: own }])

  // yours only: Junior's decisions are model-written, and this brief carries none
  const mine = (i.memory?.decisions ?? []).filter((d) => d.by === 'you' && d.text?.trim() && Number.isFinite(d.at))
  const newest = mine.reduce<(typeof mine)[number] | null>((a, d) => (!a || d.at >= a.at ? d : a), null)
  if (newest) {
    const cut = words(newest.text, 10)
    const lead = `${dayOf(newest.at, now)}, you decided: `
    return line('last', [{ text: lead + (cut.cut ? cut.text : sentence(cut.text)), cite: internalCite(i.id, 'notes') }], '', lead + sentence(newest.text.trim()))
  }

  // the task's title only: what follows " ✓" is the run's own summary
  const done = i.tasks?.lastDone?.split(' ✓')[0]?.trim()
  if (done) {
    const cut = words(done, 8)
    const text = `Last finished: ${cut.cut ? cut.text : sentence(cut.text)}`
    return line('last', [{ text, cite: internalCite(i.id, 'tasks') }], '', `Last finished: ${sentence(done)}`)
  }
  return null
}

/** What matters now: main red too, red checks, CI failing, or a conflict. Never repeats the Ready line. */
function nowLine(i: BriefItem, now: number): BriefLine | null {
  const ev = mainRedEvidence(i.seen, now)
  if (ev?.url) return line('now', [{ text: ev.text, cite: { label: "main's run", href: ev.url, external: true, aria: ev.linkLabel } }])
  // the Ready chips already say what's left on your PR
  if (readyOf(i)) return null
  const url = i.url ?? ''
  const checks: Cite | null = GITHUB_PR.test(url) ? { label: 'checks', href: `${url}/checks`, external: true, aria: 'Open the checks on GitHub' } : null
  const red = (i.seen?.red ?? []).filter((c) => c.trim())
  if (checks && red.length) return line('now', [{ text: red.length === 1 ? `${checksPhrase(red)} is red on this PR.` : `${red.length} checks are red on this PR.`, cite: checks }])
  if (checks && i.ciFailing) return line('now', [{ text: 'CI is failing on this PR.', cite: checks }])
  const own = sourceCite(i)
  if (i.seen?.rebase === 'conflict' && own) return line('now', [{ text: 'It has merge conflicts with its base.', cite: own }])
  return null
}

/**
 * The open card's cited brief: Waiting, Last time, Now, in that order, each
 * omitted when nothing backs it with a link. `me` is your login, so your own
 * asks and PRs name nobody. 0–3 lines.
 */
export function briefLines(i: BriefItem, me: string | null, now: number): BriefLine[] {
  return [waitingLine(i, me), lastLine(i, now), nowLine(i, now)].filter((l): l is BriefLine => !!l && l.cites.length > 0)
}
