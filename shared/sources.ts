/**
 * Where an item comes from, as an open registry. A source is any string: the
 * built-in scanners (GitHub, Slack), the sources jobs file today (Linear, the
 * web), your own to-dos, and any MCP server a job reads (Sentry, PagerDuty,
 * Notion…). Each known source has a descriptor here; every other string gets
 * the neutral one, so a new source shows up with a plain icon and a sensible
 * label instead of being forced into "job".
 *
 * Code asks the descriptor what a source can do (`canReply`, `watches`,
 * `yours`) rather than comparing the id to a string. Adding a source is one
 * entry in KNOWN.
 *
 * Pure and browser-safe: imported by core, server and web.
 */
import type { Playbook } from '../core/work/fields.js'

/** The sources Junior knows by name. */
export type KnownSource = 'github' | 'slack' | 'linear' | 'web' | 'job' | 'manual'

/**
 * Any source: a known one, or any other string (an MCP server's name). The
 * `string & {}` keeps editor completion for the known ids.
 */
export type WorkSource = KnownSource | (string & {})

/** Which icon a source draws; the web maps each key to a glyph. */
export type SourceIcon = 'pr' | 'hash' | 'ticket' | 'globe' | 'radar' | 'todo' | 'dot'

/** What one item is, where it lives. */
export type SourceShape = 'pr' | 'thread' | 'ticket' | 'page' | 'report' | 'todo' | 'item'

/**
 * How Junior sends a reply you approved on this source. Only Slack has one
 * today (server/playbooks/ops.ts sendReplyOp). Elsewhere the card shows the
 * draft, you copy it, send it, and mark it sent.
 */
export type ReplyRoute = {
  /** the route the server takes */
  via: 'slack-thread'
  /** where it lands, as a sentence ends: "in the Slack thread" */
  lands: string
}

/** What a ref parser reads of an item. */
export type RefItem = { id: string; source: string; repo: string; url: string; refs?: string[] }

export interface SourceDescriptor {
  /** the source string itself */
  id: string
  /** false = the neutral descriptor, for a source Junior doesn't know by name */
  known: boolean
  /** its proper name, for a chip or a heading: "GitHub", "Sentry" */
  label: string
  /** how it reads after "from": "GitHub", "the web", "a job", "your to-do" */
  from: string
  icon: SourceIcon
  shape: SourceShape
  /** what one item is called where it lives: "PR", "thread", "ticket", or "ask" */
  noun: string
  /** you wrote it yourself: nobody waits on it, nothing "came in" */
  yours: boolean
  /** the babysit and review watches can read its PRs (through `gh`) */
  watches: boolean
  /** a short ref for the item from its own fields ("#478", "NOV-140", "#api"); null = none here */
  ref: (item: RefItem) => string | null
  /** the web link for one of its canonical refs; null = it can't build one */
  link: (ref: string) => string | null
  /** what Junior starts on a hand-off when nothing else (reason, rule) decides; null = none */
  playbook: Playbook | null
  /**
   * The server has its own reply route there (sendReplyOp). This is not "a reply can go out":
   * a chat can still post on any source through its tools, held on an approval card.
   */
  canReply: boolean
  /** how, when it can */
  reply: ReplyRoute | null
}

const none = () => null

const GITHUB_ID = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/
const LINEAR_ID = /^linear:(.+)$/

const github: SourceDescriptor = {
  id: 'github',
  known: true,
  label: 'GitHub',
  from: 'GitHub',
  icon: 'pr',
  shape: 'pr',
  noun: 'PR',
  yours: false,
  watches: true,
  ref: (i) => {
    const m = GITHUB_ID.exec(i.id)
    return m ? `#${m[2]}` : null
  },
  // GitHub redirects /issues/N to /pull/N when N is a PR, so one form serves both
  link: (ref) => {
    const m = GITHUB_ID.exec(ref)
    return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null
  },
  playbook: null,
  canReply: false,
  reply: null,
}

const slack: SourceDescriptor = {
  id: 'slack',
  known: true,
  label: 'Slack',
  from: 'Slack',
  icon: 'hash',
  shape: 'thread',
  noun: 'thread',
  yours: false,
  watches: false,
  ref: (i) => (i.repo ? (i.repo.startsWith('#') ? i.repo : `#${i.repo}`) : 'Slack'),
  // a Slack permalink needs the workspace's domain, which a ref doesn't carry
  link: none,
  playbook: 'answer',
  canReply: true,
  reply: { via: 'slack-thread', lands: 'in the Slack thread' },
}

const linear: SourceDescriptor = {
  id: 'linear',
  known: true,
  label: 'Linear',
  from: 'Linear',
  icon: 'ticket',
  shape: 'ticket',
  noun: 'ticket',
  yours: false,
  watches: false,
  ref: (i) => LINEAR_ID.exec(i.id)?.[1] ?? null,
  link: (ref) => {
    const m = LINEAR_ID.exec(ref)
    return m ? `https://linear.app/issue/${m[1]}` : null
  },
  playbook: 'investigate',
  canReply: false,
  reply: null,
}

const web: SourceDescriptor = {
  id: 'web',
  known: true,
  label: 'Web',
  from: 'the web',
  icon: 'globe',
  shape: 'page',
  noun: 'ask',
  yours: false,
  watches: false,
  ref: none,
  // web:<host/path>; http and https both canonicalize to it, so https is the guess
  link: (ref) => (ref.startsWith('web:') && ref.length > 4 ? `https://${ref.slice(4)}` : null),
  playbook: 'investigate',
  canReply: false,
  reply: null,
}

const job: SourceDescriptor = {
  id: 'job',
  known: true,
  label: 'Job',
  from: 'a job',
  icon: 'radar',
  shape: 'report',
  noun: 'ask',
  yours: false,
  watches: false,
  ref: none,
  link: none,
  playbook: 'investigate',
  canReply: false,
  reply: null,
}

const manual: SourceDescriptor = {
  id: 'manual',
  known: true,
  label: 'To-do',
  from: 'your to-do',
  icon: 'todo',
  shape: 'todo',
  noun: 'ask',
  yours: true,
  watches: false,
  ref: none,
  link: none,
  playbook: null,
  canReply: false,
  reply: null,
}

const KNOWN: Record<KnownSource, SourceDescriptor> = { github, slack, linear, web, job, manual }

/** Every known source, in the order a list shows them. */
export const KNOWN_SOURCES: readonly KnownSource[] = ['github', 'slack', 'linear', 'web', 'job', 'manual']

export const isKnownSource = (v: unknown): v is KnownSource => typeof v === 'string' && Object.prototype.hasOwnProperty.call(KNOWN, v)

/**
 * The neutral descriptor: what any source Junior doesn't know by name gets. The
 * connector glyph, no ref of its own, no reply route, and a hand-off looks into it.
 * Its id and label are filled per source by `sourceOf`.
 */
export const NEUTRAL_SOURCE: SourceDescriptor = {
  id: '',
  known: false,
  label: 'Source',
  from: 'a source',
  icon: 'dot',
  shape: 'item',
  noun: 'ask',
  yours: false,
  watches: false,
  ref: none,
  link: none,
  playbook: 'investigate',
  canReply: false,
  reply: null,
}

/** "sentry" → "Sentry", "pager-duty" → "Pager Duty", "claude_ai.notion" → "Claude Ai Notion". */
export function sourceLabel(id: string): string {
  const words = id
    .trim()
    .split(/[\s._:/-]+/)
    .filter(Boolean)
  if (!words.length) return NEUTRAL_SOURCE.label
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// Neutral descriptors are cached per id so repeat lookups are cheap. The cache resets at its cap,
// so don't compare descriptors by identity.
const neutral = new Map<string, SourceDescriptor>()
const NEUTRAL_CACHE_MAX = 256

/** The descriptor for any source string: its own when Junior knows it, the neutral one otherwise. */
export function sourceOf(source: string | null | undefined): SourceDescriptor {
  const id = typeof source === 'string' ? source : ''
  if (isKnownSource(id)) return KNOWN[id]
  let d = neutral.get(id)
  if (!d) {
    const label = sourceLabel(id)
    d = { ...NEUTRAL_SOURCE, id, label, from: id ? label : NEUTRAL_SOURCE.from }
    if (neutral.size >= NEUTRAL_CACHE_MAX) neutral.clear()
    neutral.set(id, d)
  }
  return d
}

/**
 * The item's own short ref, from its source's parser, then from its id's
 * prefix when that names another source (a job-filed GitHub PR keeps its
 * `github:` id). Null when neither parser has one.
 */
export function sourceRef(item: RefItem): string | null {
  const own = sourceOf(item.source).ref(item)
  if (own) return own
  const colon = item.id.indexOf(':')
  const prefix = colon > 0 ? item.id.slice(0, colon) : ''
  if (!prefix || prefix === item.source || !isKnownSource(prefix) || prefix === 'slack') return null
  return KNOWN[prefix].ref(item)
}

/** The web link for a canonical ref ("github:o/r#1", "linear:NOV-1", "web:host/path"), by its prefix. */
export function linkForRef(ref: string): string | null {
  const colon = ref.indexOf(':')
  if (colon <= 0) return null
  return sourceOf(ref.slice(0, colon)).link(ref)
}
