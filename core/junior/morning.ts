/**
 * The morning brief: what the Junior page's first tab shows, in four
 * sections ordered by urgency, people waiting on you, what's due today,
 * what's waiting for your review, and what happened while you were away,
 * plus the one thing to start with. Built from the ranked open inbox and the
 * brief's facts; deterministic, no model in the path. Pure and browser-safe;
 * time is always an argument.
 */
import { dueOf } from '../work/due.js'
import type { Ask } from '../work/asks.js'
import type { BriefFacts, Finished } from './brief.js'
import { waitedWords } from './greeting.js'
import { shortRef } from './today.js'

/** What the brief reads of an open, ranked item. */
export type MorningItem = {
  id: string
  title: string
  source: string
  kind: string
  repo: string
  author: string
  url: string
  refs?: string[]
  peopleWaiting: number
  createdAt: string
  ingestedAt?: number
  ask?: string
  group?: string
  status?: string
  dueAt?: number
  dueSource?: 'explicit' | 'you'
  flow?: { stage: string; turn: string; since: number }
}

/** One row in a section. */
export type MorningRow = {
  itemId: string
  title: string
  /** "#478", "NOV-140", "#api" */
  ref: string
  /** github, slack, linear, manual, job… */
  source: string
  /** the person behind it, when there is one */
  who: string | null
  /** when it started waiting (epoch ms) */
  since: number
  /** people: what they want, as a verb ("reply", "decide") */
  ask?: 'reply' | 'decide'
  /** due: whole days late; 0 = due today */
  late?: number
  /** review: Junior's own finished work, not a teammate's */
  mine?: boolean
}

export type MorningBrief = {
  people: MorningRow[]
  due: MorningRow[]
  review: MorningRow[]
  away: {
    since: number
    /** the window began with a real absence, not "so far today" */
    away: boolean
    /** what came in, by source, biggest first */
    arrived: BriefFacts['arrived']
    /** of what came in, how much was FYI: nothing asked of you */
    skipped: number
    /** jobs whose runs ended ok in the window */
    jobs: Extract<Finished, { kind: 'job' }>[]
    /** outbound actions that went out in the window */
    sent: number
  }
  /** the one thing to start with, and why */
  start: { itemId: string; title: string; why: string } | null
}

const PEOPLE_ASKS = new Set<string>(['reply', 'decide'])
const isOpen = (i: MorningItem) => (i.status ?? 'open') === 'open'
const myTurn = (i: MorningItem) => (i.flow?.turn ?? 'me') === 'me'
const arrivedAt = (i: MorningItem) => i.ingestedAt ?? (Date.parse(i.createdAt) || 0)
const waitingSince = (i: MorningItem) => Date.parse(i.createdAt) || 0

function row(i: MorningItem, extra: Partial<MorningRow> = {}): MorningRow {
  return { itemId: i.id, title: i.title, ref: shortRef(i), source: i.source, who: i.author || null, since: waitingSince(i), ...extra }
}

/**
 * The brief, from the open inbox and the facts the page already gathered.
 * Each item lands in at most one section: people first, then review, then
 * due, so a review request that is also due today reads as a review.
 */
export function morningBrief(input: { items: readonly MorningItem[]; facts: BriefFacts; now: number }): MorningBrief {
  const { items, facts, now } = input
  const open = items.filter((i) => isOpen(i) && i.kind !== 'digest')
  const taken = new Set<string>()

  // People waiting on you: a human asked something of you, a question, a decision. Oldest first.
  const people = open
    .filter((i) => i.source !== 'manual' && myTurn(i) && i.ask !== 'review' && (PEOPLE_ASKS.has(i.ask ?? '') || i.peopleWaiting > 0))
    .sort((a, b) => waitingSince(a) - waitingSince(b))
    .map((i) => row(i, { ask: i.ask === 'decide' ? 'decide' : 'reply' }))
  for (const r of people) taken.add(r.itemId)

  // To review: teammates' work you were asked to review, then Junior's own finished work.
  const asked = open
    .filter((i) => !taken.has(i.id) && myTurn(i) && i.ask === 'review')
    .sort((a, b) => waitingSince(a) - waitingSince(b))
    .map((i) => row(i))
  for (const r of asked) taken.add(r.itemId)
  const mine = open
    .filter((i) => !taken.has(i.id) && i.flow?.stage === 'review' && i.flow.turn === 'me' && i.kind !== 'own-pr-open')
    .sort((a, b) => (a.flow?.since ?? 0) - (b.flow?.since ?? 0))
    .map((i) => row(i, { mine: true, since: i.flow?.since ?? waitingSince(i), who: null }))
  for (const r of mine) taken.add(r.itemId)
  const review = [...asked, ...mine]

  // Due today: a day someone set (the source, or you) that is today or already past. Most late first.
  const due = open
    .filter((i) => !taken.has(i.id) && i.dueSource)
    .map((i) => ({ i, d: dueOf({ ask: (i.ask ?? 'do') as Ask, dueAt: i.dueAt, dueSource: i.dueSource }, now) }))
    .filter(({ d }) => d.section === 'today' && d.at != null)
    .sort((a, b) => b.d.late - a.d.late || a.i.title.localeCompare(b.i.title))
    .map(({ i, d }) => row(i, { late: d.late }))

  const skipped = open.filter((i) => i.source !== 'manual' && i.group === 'fyi' && arrivedAt(i) >= facts.since).length
  const jobs = facts.finished.filter((f): f is Extract<Finished, { kind: 'job' }> => f.kind === 'job')

  return {
    people,
    due,
    review,
    away: { since: facts.since, away: facts.away, arrived: facts.arrived, skipped, jobs, sent: facts.sent },
    start: startWith({ people, due, review }, now),
  }
}

/** The person who has waited longest, else the latest overdue thing, else the oldest review. */
export function startWith(b: Pick<MorningBrief, 'people' | 'due' | 'review'>, now: number): MorningBrief['start'] {
  const p = b.people[0]
  if (p) return { itemId: p.itemId, title: p.title, why: `${p.who ?? 'Someone'} has waited ${waitedWords(p.since, now)}` }
  const late = b.due.find((d) => (d.late ?? 0) > 0)
  if (late) return { itemId: late.itemId, title: late.title, why: `it was due ${late.late === 1 ? 'yesterday' : `${late.late} days ago`}` }
  const r = b.review.find((x) => !x.mine) ?? b.review[0]
  if (r) return { itemId: r.itemId, title: r.title, why: r.mine ? 'my work is ready for your review' : `${r.who ?? 'someone'} asked ${waitedWords(r.since, now)} ago` }
  const today = b.due[0]
  if (today) return { itemId: today.itemId, title: today.title, why: "it's due today" }
  return null
}

/** How many overdue things the headline counts. */
export const overdueCount = (b: Pick<MorningBrief, 'due'>): number => b.due.filter((d) => (d.late ?? 0) > 0).length
