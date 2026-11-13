/**
 * What Junior says in the sidebar: one line, picked by what matters most right
 * now, with the face that goes with it (.docs/redesign-b2-plan.md, "Junior's
 * card"). The order, first match wins:
 *
 *   1 needs you       two or more things wait on the user (orange)
 *   2 one question    exactly one thing waits, so Junior names it (orange)
 *   3 stuck           something broke: an agent gave up, a job failed
 *   4 ready for you   a thread finished its part and you haven't looked yet
 *   5 handed off      a few seconds after the user hands something over
 *   6 working         nothing waits; the team is on N things
 *   7 greeting        the first open of the day, nothing else going on
 *   8 all clear       nothing at all
 *
 * Needs you outranks stuck, as railMood() does: the user's turn first.
 * Orange is only ever the `lead`, so only "needs you" lines carry it.
 * Lines follow the brand's copy rules: short, common words, no "done" for
 * work that still waits on the user. Pure and browser-safe; time is an argument.
 */
import type { Mood } from './mood.js'
import { cap, dayPart, numberWord } from './greeting.js'

export type SayNeed = {
  /** what waits, as a short phrase: "Reviewer's question on #512", "PR #486 waits for your OK" */
  title: string
  /** a question (AskUserQuestion) rather than a permission or a send */
  question?: boolean
  /** the agent it comes from, when one is asking: "Reviewer" */
  from?: string
  /** when it started waiting (epoch ms) */
  since?: number
}

export type SaySignals = {
  /** what the user is called, for the greeting; null = no name */
  you: string | null
  /** everything waiting on the user, oldest first or in any order */
  needs: readonly SayNeed[]
  /** something broke; the title of the first broken thing when known */
  stuck: { title?: string } | null
  /** threads and runs in flight that don't wait on the user */
  working: number
  /** threads that finished their part, that you haven't opened since */
  ready?: readonly { title: string }[]
  /** the user just handed something over (the client keeps this for a few seconds) */
  handedOff?: { to: string; title: string } | null
  /** the first time the app is open today */
  firstOpenToday?: boolean
  now: number
}

export type SayKind = 'needs' | 'one' | 'stuck' | 'ready' | 'handedOff' | 'working' | 'greeting' | 'clear'

export type Say = {
  kind: SayKind
  mood: Mood
  /** said in orange, first: only for things waiting on the user */
  lead?: string
  /** the rest of the line, in ink */
  rest: string
}

/** "40 minutes", "2 hours", "3 days": how long the oldest thing has waited; null under a minute. */
export function waitedFor(since: number, now: number): string | null {
  const m = Math.floor((now - since) / 60_000)
  if (m < 1) return null
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

const things = (n: number) => `${cap(numberWord(n))} thing${n === 1 ? '' : 's'}`
const endDot = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`)

export function juniorSays(s: SaySignals): Say {
  const n = s.needs.length
  if (n >= 2) {
    const oldest = Math.min(...s.needs.map((x) => x.since ?? s.now))
    const waited = waitedFor(oldest, s.now)
    const tail = s.working > 0 ? `${cap(numberWord(s.working))} more ${s.working === 1 ? 'is' : 'are'} with the team.` : waited ? `The oldest has waited ${waited}.` : 'Nothing else is running.'
    return { kind: 'needs', mood: 'needs', lead: `${things(n)} need you.`, rest: tail }
  }
  if (n === 1) {
    const one = s.needs[0]
    if (one.question && one.from) return { kind: 'one', mood: 'needs', lead: `${one.from} has a question`, rest: `on ${endDot(one.title)}` }
    if (one.question) return { kind: 'one', mood: 'needs', lead: 'A question waits for you', rest: `on ${endDot(one.title)}` }
    return { kind: 'one', mood: 'needs', lead: 'One thing needs you:', rest: endDot(one.title) }
  }
  if (s.stuck) {
    return { kind: 'stuck', mood: 'stuck', rest: s.stuck.title ? `${endDot(s.stuck.title)} Take a look?` : 'Something stopped and needs a look.' }
  }
  const ready = s.ready ?? []
  if (ready.length === 1) return { kind: 'ready', mood: 'done', rest: `${ready[0].title} is ready for you to look at.` }
  if (ready.length > 1) return { kind: 'ready', mood: 'done', rest: `${cap(numberWord(ready.length))} threads are ready for you to look at.` }
  if (s.handedOff) return { kind: 'handedOff', mood: 'think', rest: `Got it. ${s.handedOff.to} has ${s.handedOff.title} now.` }
  if (s.working > 0) return { kind: 'working', mood: 'working', rest: `Nothing needs you. The team is on ${numberWord(s.working)} thing${s.working === 1 ? '' : 's'}.` }
  if (s.firstOpenToday) {
    const part = dayPart(s.now)
    return { kind: 'greeting', mood: 'hello', rest: `${cap(`good ${part}`)}${s.you ? `, ${s.you}` : ''}. Nothing needs you yet.` }
  }
  return { kind: 'clear', mood: 'hello', rest: 'All clear. Nothing needs you.' }
}
