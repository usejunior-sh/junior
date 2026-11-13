/**
 * Junior's work log: one dated line per thread it started from its own chat,
 * saying what that thread last reported. It is how Junior's chat knows what
 * got done on earlier days without re-reading those threads: the recent lines
 * ride its system prompt at spawn, and read_work_log reads further back.
 *
 * One entry per thread, kept up to date: a thread that replies again moves to
 * the top with its newest line. Stored as `<workspace>/worklog.json`, read
 * strictly: a row with an unknown key or a bad field is dropped and reported.
 * Capped by count and by age, so the file and the prompt both stay small.
 *
 * Pure and browser-safe; time is always an argument.
 */
import { dayKey } from './today.js'

export type WorklogEntry = {
  /** the thread's session id */
  sessionId: string
  /** the thread's title, as the sidebar shows it */
  title: string
  /** the agent's label it talked as; absent = plain Junior */
  agent?: string
  /** what it last reported: the first sentence of its reply */
  said: string
  /** ms, when that report landed */
  at: number
}

/** Entries kept at once; past this, the oldest go. */
export const WORKLOG_MAX = 200
/** An entry older than this goes. */
export const WORKLOG_KEEP_DAYS = 30
/** Days of entries the prompt carries. */
export const WORKLOG_PROMPT_DAYS = 7
/** Lines the prompt carries at most. */
export const WORKLOG_PROMPT_MAX = 20
/** The longest `said` kept. threadReportLine already cuts near here. */
export const WORKLOG_SAID_MAX = 240

const DAY_MS = 86_400_000
const KEYS = ['sessionId', 'title', 'agent', 'said', 'at'] as const

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** Parse the file. Bad rows are dropped and named in `errors`, never guessed at. */
export function parseWorklog(text: string): { entries: WorklogEntry[]; errors: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { entries: [], errors: ['not JSON'] }
  }
  if (!Array.isArray(raw)) return { entries: [], errors: ['not a list'] }
  const entries: WorklogEntry[] = []
  const errors: string[] = []
  raw.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return errors.push(`row ${i}: not an object`)
    const o = r as Record<string, unknown>
    const extra = Object.keys(o).find((k) => !(KEYS as readonly string[]).includes(k))
    if (extra) return errors.push(`row ${i}: unknown key ${extra}`)
    if (typeof o.sessionId !== 'string' || !o.sessionId) return errors.push(`row ${i}: bad sessionId`)
    if (typeof o.title !== 'string') return errors.push(`row ${i}: bad title`)
    if (o.agent !== undefined && typeof o.agent !== 'string') return errors.push(`row ${i}: bad agent`)
    if (typeof o.said !== 'string') return errors.push(`row ${i}: bad said`)
    if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return errors.push(`row ${i}: bad at`)
    entries.push({ sessionId: o.sessionId, title: o.title, ...(o.agent ? { agent: o.agent } : {}), said: o.said, at: o.at })
  })
  return { entries, errors }
}

export const serializeWorklog = (entries: readonly WorklogEntry[]): string => `${JSON.stringify(entries, null, 2)}\n`

/** Newest first, nothing past the age or count cap. */
export function trimWorklog(entries: readonly WorklogEntry[], now: number): WorklogEntry[] {
  const cutoff = now - WORKLOG_KEEP_DAYS * DAY_MS
  return [...entries]
    .filter((e) => e.at >= cutoff)
    .sort((a, b) => b.at - a.at)
    .slice(0, WORKLOG_MAX)
}

/** Record a thread's latest report: its entry is replaced and moves to the top. */
export function noteWork(entries: readonly WorklogEntry[], entry: WorklogEntry, now: number): WorklogEntry[] {
  const clean: WorklogEntry = {
    sessionId: entry.sessionId,
    title: oneLine(entry.title, 120) || 'Untitled thread',
    ...(entry.agent ? { agent: oneLine(entry.agent, 60) } : {}),
    said: oneLine(entry.said, WORKLOG_SAID_MAX),
    at: entry.at,
  }
  return trimWorklog([clean, ...entries.filter((e) => e.sessionId !== entry.sessionId)], now)
}

/** Entries from the last `days` days, newest first, at most `max`. */
export function recentWork(entries: readonly WorklogEntry[], now: number, days = WORKLOG_PROMPT_DAYS, max = WORKLOG_PROMPT_MAX): WorklogEntry[] {
  const cutoff = now - days * DAY_MS
  return trimWorklog(entries, now)
    .filter((e) => e.at >= cutoff)
    .slice(0, max)
}

/** One entry as a line: `- 2026-11-14 · Fix composer width (Reviewer): Fixed it.` */
export function worklogLine(e: WorklogEntry): string {
  return `- ${dayKey(e.at)} · ${e.title}${e.agent ? ` (${e.agent})` : ''}${e.said ? `: ${e.said}` : ''}`
}

/** The system-prompt block: the recent lines, or nothing when there are none. */
export function worklogAppend(entries: readonly WorklogEntry[], now: number): string {
  const recent = recentWork(entries, now)
  if (!recent.length) return ''
  return `\n\n## Work log\nWhat your threads last reported, newest first, as of when this chat started. read_work_log reads further back.\n${recent.map(worklogLine).join('\n')}`
}
