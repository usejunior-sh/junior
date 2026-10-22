// What `npm run demo:shots` captures. One scene = one route of the seeded demo
// world (scripts/demo/world.ts), shot raw and then framed per platform.
// Add a scene here; run `npm run demo:shots -- --only <name>` to iterate on it.
import { ID } from './world.js'

export type Scene = {
  name: string
  /** the route (web/src/hooks.ts): `#/inbox/<tab>`, `#/item/<id>`, `#<sessionId>`, `#/jobs`… */
  hash: string
  /** line drawn above the window in framed versions; omit for none */
  headline?: string
  /** smaller line under the headline */
  sub?: string
  /** CSS px; default 1440×900 (Junior.app's default window is 1360×880) */
  viewport?: { width: number; height: number }
  /** phone layout (≤767px): no window chrome, framed as a phone */
  mobile?: boolean
  /** extra ms to wait after load, for routes that fetch late */
  settleMs?: number
  /** click the first element with this exact text before the shot (e.g. a file in Changes) */
  click?: string
  /** CSS selectors hidden for this scene only */
  hide?: string[]
}

const item = (id: string) => `#/item/${encodeURIComponent(id)}`

export const SCENES: Scene[] = [
  {
    name: 'junior',
    hash: '#/junior',
    headline: 'Junior works on what you hand it.',
    sub: 'It suggests. You hand off, snooze, or say not this one.',
    settleMs: 1500,
  },
  {
    name: 'inbox',
    hash: '#/inbox/people',
    headline: 'Everything that needs you. Ranked.',
    sub: 'GitHub, Slack, Linear and your own to-dos in one local inbox.',
  },
  {
    name: 'needs-you',
    hash: '#/inbox/needs',
    headline: 'Agents ask before they act.',
    sub: 'A drafted Slack reply waits for your yes. CI failures surface on their own.',
  },
  {
    name: 'item',
    hash: item(ID.item.n1),
    // spend is read from ~/.claude transcripts, which demo sessions don't have
    hide: ['.costBlock'],
    headline: 'Every item arrives with a brief.',
    sub: 'Read it, dispatch it to Claude Code, review what came back.',
  },
  {
    name: 'session',
    hash: `#${ID.s.fixN1}`,
    headline: 'From ticket to PR, on your machine.',
    sub: 'Claude Code runs in your repo, with your tools, under your eye.',
  },
  {
    name: 'actions',
    hash: '#/actions',
    headline: 'A record of everything your agents did.',
    sub: 'PRs, pushes, comments, messages. Approve the risky ones first.',
  },
  {
    name: 'jobs',
    hash: '#/jobs',
    headline: 'Jobs watch the noise for you.',
    sub: 'Scheduled agents scan Sentry, Dependabot and Slack, and file only what matters.',
  },
  {
    name: 'job',
    hash: `#/jobs/${ID.job.sentry}`,
  },
  {
    name: 'brief',
    hash: `#/artifact/9b7c2d10-0002-4a5e-8f00-de0000000002`,
    headline: 'Briefs you can actually act on.',
  },
  {
    name: 'changes',
    hash: '#/changes',
    click: 'invoices.ts',
  },
  {
    name: 'inbox-phone',
    hash: '#/inbox/people',
    mobile: true,
    viewport: { width: 390, height: 844 },
    headline: 'Your inbox, in your pocket.',
  },
]

/** The tab strip every desktop scene opens with, like a real afternoon. */
export const OPEN_TABS = [ID.s.fixN1, ID.s.paginate, `item:${ID.item.memcached}`, ID.s.replyPriya]
export const TAB_TITLES: Record<string, string> = {
  [`item:${ID.item.memcached}`]: 'Move the session store off Memcached',
}
