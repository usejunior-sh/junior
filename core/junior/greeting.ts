/**
 * The Junior page's headline: a muted greeting by time of day, then the news
 * in ink. And the "while you were away" window the brief covers. Pure and
 * browser-safe; time is always an argument, read in the runtime's local zone.
 */
import type { Voice } from './persona.js'

export type DayPart = 'morning' | 'afternoon' | 'evening'

/** 04:00–11:59 morning, 12:00–16:59 afternoon, the rest evening (a late night is still the day's end). */
export function dayPart(now: number): DayPart {
  const h = new Date(now).getHours()
  if (h >= 4 && h < 12) return 'morning'
  if (h >= 12 && h < 17) return 'afternoon'
  return 'evening'
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
/** "three" up to ten, digits after. */
export const numberWord = (n: number): string => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n))
export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

export type HeadlineInput = {
  now: number
  voice: Voice
  /** the persona's name */
  name: string
  /** what the user is called, when known */
  you: string | null
  firstOpen: boolean
  /** rows under Needs you */
  needs: number
  plan: { done: number; total: number }
}

export type Headline = { greet: string; news: string }

/**
 * One line: the greeting (muted), then the news (ink). First open introduces
 * Junior; the evening reports the plan; otherwise it counts what needs you.
 */
export function headline(h: HeadlineInput): Headline {
  const part = dayPart(h.now)
  const { voice, name, you } = h
  if (h.firstOpen) {
    if (voice === 'warm') return { greet: `Hi! I'm ${name},`, news: 'here to take work off your plate.' }
    if (voice === 'terse') return { greet: `${name}.`, news: 'Your junior engineer.' }
    return { greet: `Hi, I'm ${name},`, news: 'your junior engineer.' }
  }
  const greet =
    voice === 'warm'
      ? part === 'morning'
        ? you
          ? `Good morning, ${you}!`
          : 'Good morning!'
        : part === 'afternoon'
          ? 'Good afternoon!'
          : "That's a wrap."
      : voice === 'terse'
        ? part === 'morning'
          ? 'Morning.'
          : part === 'afternoon'
            ? 'Afternoon.'
            : 'Day done.'
        : part === 'morning'
          ? you
            ? `Morning, ${you}.`
            : 'Morning.'
          : part === 'afternoon'
            ? 'Afternoon.'
            : "That's the day."
  return { greet, news: news(h, part) }
}

function news(h: HeadlineInput, part: DayPart): string {
  const { needs, plan, voice } = h
  if (part === 'evening' && plan.total > 0) {
    if (voice === 'terse') return `${plan.done} out of ${plan.total}.`
    return `${plan.done} of ${plan.total} done${voice === 'warm' ? ' today' : ''}.`
  }
  if (needs > 0) {
    if (voice === 'terse') return `${needs} need${needs === 1 ? 's' : ''} you.`
    if (needs === 1) return voice === 'warm' ? 'Just one thing needs you.' : 'One thing needs you.'
    return `${cap(numberWord(needs))} things need you.`
  }
  if (voice === 'terse') return 'All clear.'
  return voice === 'warm' ? 'Nothing needs you right now.' : 'Nothing needs you.'
}

/** Local midnight at or before `now`. */
export function startOfDay(now: number): number {
  return new Date(now).setHours(0, 0, 0, 0)
}

/**
 * What the brief covers. Stored per browser: `seenAt` = the last time the page
 * was in front of you, `since` = the start of the window, `away` = that
 * window began with a real absence (as opposed to "so far today").
 */
export type SeenState = { seenAt: number; since: number; away: boolean }

/** An absence shorter than this is the same sitting: the brief doesn't reset under you. */
export const AWAY_GAP_MS = 2 * 60 * 60 * 1000

/**
 * The window to brief on when the page opens at `now`. A first visit covers
 * today so far; coming back after AWAY_GAP covers the absence; a shorter
 * break keeps the window it had, so the brief stays put while you work.
 */
export function awayWindow(prev: SeenState | null, now: number): SeenState {
  if (!prev || !Number.isFinite(prev.seenAt) || !Number.isFinite(prev.since) || prev.seenAt > now) {
    return { seenAt: now, since: startOfDay(now), away: false }
  }
  if (now - prev.seenAt >= AWAY_GAP_MS) return { seenAt: now, since: prev.seenAt, away: true }
  return { seenAt: now, since: Math.min(prev.since, now), away: prev.away }
}

/** "2 days", "5 hours", "20 minutes" — how long someone has waited, in words. */
export function waitedWords(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000))
  if (m < 60) return m <= 1 ? 'a minute' : `${m} minutes`
  const h = Math.floor(m / 60)
  if (h < 24) return h === 1 ? 'an hour' : `${h} hours`
  const d = Math.floor(h / 24)
  return d === 1 ? 'a day' : `${d} days`
}
