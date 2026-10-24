/**
 * Promises become items owed to someone (plan item `promise-items-core`).
 *
 * A source brings in a thread plus the user's own messages in it: a job
 * run (any MCP source it reads, `yours` on upsert_work_item) or the
 * built-in Slack rows (core/sources/slack.ts). promises.ts finds the
 * sentences that promise something; each becomes one `promise` item:
 *
 *   id        promise:<thread>~<hash of the quote>. The same words in the
 *             same thread are one item however often a run re-reads them
 *             (dedupe by thread + quote); new words are a new promise.
 *   title     the quote, exactly as written
 *   author    who it is owed to, when the text says ("" otherwise)
 *   refs      [thread], so the promise links to the thread's own item
 *   dueAt     the day the text names ("tomorrow", "by Friday")
 *   updatedAt when it was said: a re-read never reopens a promise you
 *             closed; saying the same words again later does
 *
 * "Not a promise" (server/inbox/promises.ts) writes a `not-a-promise` event
 * on the item with its thread; `suppressedThreads` reads those back and that
 * thread files no more promises.
 *
 * Pure and browser-safe: the reference time is always an argument.
 */
import { detectPromises } from './promises.js'
import { startOfDay } from './due.js'
import type { PromiseFacts, WorkItem, WorkSource } from './types.js'

export const PROMISE_ID_PREFIX = 'promise:'

/** The user's messages read per thread; a longer list keeps the newest. */
export const MAX_MESSAGES_PER_THREAD = 20

/** One message the user wrote in a thread. */
export interface SaidMessage {
  /** the message, verbatim */
  text: string
  /** when it was sent, epoch ms */
  at: number
  /** who the message replies to: "you" in the promise means them */
  replyTo?: string
}

/** A thread and the user's own messages in it, as a source brought them in. */
export interface PromiseThread {
  /** the thread's own item id ("slack:C1/p2", "github:o/r#3", "web:sentry.io/…") */
  thread: string
  /** the source the thread's item is filed under (a job's `source:` included) */
  source: WorkSource
  /** the thread's link */
  url: string
  /** where it lives: "#channel", "owner/repo", the site */
  place: string
  /** the user's own messages in it; anyone else's text never belongs here */
  messages: SaidMessage[]
  /** the job that brought it in, when one did */
  jobId?: string
}

/** The words that decide whether two quotes are the same promise. */
export function quoteKey(quote: string): string {
  return quote
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[\s.!…]+$/, '')
    .trim()
}

/** FNV-1a, 32 bits, as 8 hex digits. Two seeds make the id's 16. */
function fnv(s: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** One id per thread + quote. */
export function promiseItemId(thread: string, quote: string): string {
  const key = quoteKey(quote)
  return `${PROMISE_ID_PREFIX}${thread}~${fnv(key, 0x811c9dc5)}${fnv(key, 0x050c5d1f)}`
}

export const isPromiseItemId = (id: string): boolean => id.startsWith(PROMISE_ID_PREFIX)

/**
 * The threads you said hold no promises: the `thread` on each
 * `not-a-promise` event's detail.
 */
export function suppressedThreads(events: readonly { detail?: Record<string, unknown> }[]): Set<string> {
  const out = new Set<string>()
  for (const e of events) {
    const t = e.detail?.thread
    if (typeof t === 'string' && t) out.add(t)
  }
  return out
}

/** Messages worth reading: real text and time, newest kept, oldest first. */
function said(messages: readonly SaidMessage[]): SaidMessage[] {
  const ok = messages.filter((m) => m && typeof m.text === 'string' && m.text.trim() && Number.isFinite(m.at))
  ok.sort((a, b) => a.at - b.at)
  return ok.slice(-MAX_MESSAGES_PER_THREAD)
}

/**
 * The promise items a thread's messages make, one per thread + quote. A
 * thread you marked "not a promise" makes none. The same quote said twice
 * is one item, carrying the later time.
 */
export function promiseItemsFrom(t: PromiseThread, suppressed: ReadonlySet<string> = new Set()): WorkItem[] {
  if (!t.thread || suppressed.has(t.thread)) return []
  const byId = new Map<string, WorkItem>()
  for (const m of said(t.messages)) {
    for (const hit of detectPromises(m.text, true, m.at, m.replyTo ? { replyTo: m.replyTo } : {})) {
      const id = promiseItemId(t.thread, hit.quote)
      const iso = new Date(m.at).toISOString()
      const facts: PromiseFacts = {
        quote: hit.quote,
        thread: t.thread,
        saidAt: m.at,
        ...(hit.owedTo ? { owedTo: hit.owedTo } : {}),
        ...(hit.due ? { dueAt: hit.due.at } : {}),
      }
      const prev = byId.get(id)
      byId.set(id, {
        id,
        source: t.source,
        kind: 'promise',
        title: hit.quote,
        url: t.url,
        repo: t.place,
        author: hit.owedTo ?? '',
        // someone is counting on it when it is owed to someone
        peopleWaiting: hit.owedTo ? 1 : 0,
        createdAt: prev?.createdAt ?? iso,
        updatedAt: iso,
        refs: [t.thread],
        ...(hit.due ? { dueAt: startOfDay(hit.due.at) } : {}),
        ...(t.jobId ? { jobId: t.jobId } : {}),
        why: hit.owedTo ? `you told ${hit.owedTo} you would` : 'you said you would',
        promise: facts,
      })
    }
  }
  return [...byId.values()]
}

/** Raw `yours` messages from a tool call or a scan row → said messages; anything malformed is dropped. */
export function saidFrom(raw: unknown, now: number): SaidMessage[] {
  if (!Array.isArray(raw)) return []
  const out: SaidMessage[] = []
  for (const r of raw) {
    if (typeof r === 'string') {
      if (r.trim()) out.push({ text: r, at: now })
      continue
    }
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.text !== 'string' || !o.text.trim()) continue
    const parsed = typeof o.at === 'string' ? Date.parse(o.at) : typeof o.at === 'number' ? o.at : NaN
    // a time in the future is a model's guess, not when it was said
    const at = Number.isFinite(parsed) && parsed <= now ? parsed : now
    const replyTo = typeof o.replyTo === 'string' && o.replyTo.trim() ? o.replyTo.trim() : undefined
    out.push({ text: o.text, at, ...(replyTo ? { replyTo } : {}) })
  }
  return out
}

/**
 * The thread a filed row stands for, with the user's own messages in it:
 * the row's own id, source (a job's `source:` included), link and place.
 */
export function promiseThreadOf(item: Pick<WorkItem, 'id' | 'source' | 'url' | 'repo'>, yours: unknown, now: number, jobId?: string): PromiseThread {
  return {
    thread: item.id,
    source: item.source,
    url: item.url,
    place: item.repo,
    messages: saidFrom(yours, now),
    ...(jobId ? { jobId } : {}),
  }
}
