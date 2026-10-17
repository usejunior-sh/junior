/**
 * How a queued action reads, wherever it shows up. The Actions page's tabs,
 * the stub card's payload, whether a closed row may carry a quick ✓, the
 * "#a1b2c3" an agent is told. Pure and browser-safe: the web imports it, and
 * the server says the same short id in the message it hands the agent.
 */
import type { ActionKind, ActionStatus } from './types.js'

/** The Actions page's tabs: Needs you · Scheduled · Sent · Stopped. */
export type ActionTab = 'needs_you' | 'scheduled' | 'sent' | 'stopped'
export const ACTION_TABS: readonly ActionTab[] = ['needs_you', 'scheduled', 'sent', 'stopped']
export const TAB_LABEL: Record<ActionTab, string> = { needs_you: 'Needs you', scheduled: 'Scheduled', sent: 'Sent', stopped: 'Stopped' }

/** Which tab a status lives under. Stopped = it didn't (or may not have) gone out. */
export function tabOf(status: ActionStatus): ActionTab {
  switch (status) {
    case 'needs_you':
      return 'needs_you'
    case 'scheduled':
    case 'sending':
      return 'scheduled'
    case 'succeeded':
    case 'attempted':
      return 'sent'
    default:
      return 'stopped'
  }
}

/**
 * May a closed row approve with one click? Only for what is cheap to take
 * back. A ticket, a post (drafts), an update. Anything that reaches a person
 * (a message, an email, a comment) or can't be undone (a PR, a merge) has to
 * be opened and read first.
 */
export const QUICK_APPROVE_KINDS: readonly ActionKind[] = ['ticket', 'post', 'update']
export const quickApprovable = (kind: ActionKind): boolean => QUICK_APPROVE_KINDS.includes(kind)

/**
 * "#a1b2c3": six characters of a 32-bit FNV-1a hash of the record's id. Stable
 * (the id is `<session>:<tool_use>`), so the agent's message and every card
 * name the same action.
 */
export function shortActionId(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(7, '0').slice(-6)
}

/** The fields that hold what a person will read, best first. */
const READABLE_KEYS = ['text', 'body', 'message', 'markdown', 'content', 'comment', 'description', 'title', 'subject', 'summary', 'name']
/** Where it goes: shown above the text, never as the text. */
const TARGET_KEYS = ['to', 'channel', 'channel_name', 'channel_id', 'recipient', 'recipients', 'repo', 'team', 'project', 'issue', 'pr', 'thread_ts']

export type Payload = {
  /** what it goes to: "to: niraj@…", "channel: C0123" */
  target: Array<{ key: string; text: string }>
  /** the readable fields, in reading order (a title before its body) */
  fields: Array<{ key: string; text: string }>
  /** no readable field: the args as formatted JSON */
  json: string | null
}

/**
 * The draft, readably: the args' main string fields (a post's text, an
 * email's subject and body, a ticket's title and description), or the args
 * as formatted JSON when none of them is there.
 */
export function payloadOf(args: Record<string, unknown>): Payload {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null)
  const found = READABLE_KEYS.filter((k) => str(args[k]) !== null)
  // A title and a body read best title first; the rest by preference.
  const order = (k: string) => (k === 'title' || k === 'subject' || k === 'name' ? 0 : 1)
  const fields = [...found]
    .sort((a, b) => order(a) - order(b))
    .slice(0, 3)
    .map((key) => ({ key, text: str(args[key])! }))
  const target = TARGET_KEYS.flatMap((key) => {
    const v = args[key]
    if (Array.isArray(v)) {
      const list = v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
      return list.length ? [{ key, text: list.join(', ') }] : []
    }
    const s = str(v)
    return s !== null && s.length <= 200 ? [{ key, text: s }] : []
  }).slice(0, 2)
  return { target, fields, json: fields.length ? null : JSON.stringify(args, null, 2) }
}

/**
 * A countdown, readable at any length: "in 9s", "in 4m 10s", "in 2h 58m",
 * "in 3d 4h". Rounded up, so it never says "in 0s" while time is left.
 */
export function countdownText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s < 60) return `in ${s}s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const r = s % 60
    return r ? `in ${m}m ${r}s` : `in ${m}m`
  }
  if (s < 86_400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m ? `in ${h}h ${m}m` : `in ${h}h`
  }
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  return h ? `in ${d}d ${h}h` : `in ${d}d`
}
