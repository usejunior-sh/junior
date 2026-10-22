import { DAY, HOUR, ID, LOGIN, MIN } from './base.js'

export type DemoItem = {
  id: string
  source: 'github' | 'slack' | 'linear' | 'web' | 'job' | 'manual'
  kind: string
  title: string
  url: string
  repo: string
  author: string
  peopleWaiting: number
  /** when the source made it (ms ago) */
  created: number
  /** last source activity (ms ago) */
  updated: number
  /** when Junior first saw it (ms ago), drives "New" */
  ingested: number
  ciFailing?: boolean
  isDraft?: boolean
  priority?: number
  why?: string
  ask?: string
  jobId?: string
  /** `explicit` due, in days from today (0 = today, -1 = yesterday) */
  dueInDays?: number
  description?: string
  /** handed to Junior (hand-offs, Phase 1): babysat, first-passed, or paused */
  handoff?: 'on' | 'paused'
  /** what it is, for the rules' suggestions */
  label?: 'bug' | 'improvement' | 'question' | 'feature' | 'idea'
  /** stage/turn override, set `at` now */
  override?: { stage?: string; turn?: string; note?: string }
  /** after insert: done/snoozed/archived, `at` ms ago */
  status?: { to: 'done' | 'snoozed' | 'archived'; at: number; reason?: string }
}

export type DemoManual = {
  id: string
  title: string
  description?: string
  priority?: number
  created: number
  dueInDays?: number
  override?: { stage?: string; turn?: string; note?: string }
  status?: { to: 'done' | 'snoozed' | 'archived'; at: number }
}

const gh = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`
const lin = (key: string) => `https://linear.app/acme/issue/${key}`
const slack = (ch: string, p: string) => `https://acme.slack.com/archives/${ch}/${p}`

export function items(): DemoItem[] {
  return [
    // Needs you now
    {
      id: ID.item.ciRedis,
      source: 'github',
      kind: 'own-pr-open',
      title: 'Move rate-limit buckets from memory to Redis',
      url: gh('acme/api', 482),
      repo: 'acme/api',
      author: LOGIN,
      peopleWaiting: 0,
      ciFailing: true,
      created: 2 * DAY,
      updated: 38 * MIN,
      ingested: 2 * DAY,
    },
    {
      id: ID.item.priya,
      source: 'slack',
      kind: 'slack-reply-pending',
      title: "Priya: can webhook retries ship before Friday's launch?",
      url: slack('C04ENGPAY', 'p1760440200123'),
      repo: '#eng-payments',
      author: 'priya.s',
      peopleWaiting: 1,
      created: 70 * MIN,
      updated: 70 * MIN,
      ingested: 66 * MIN,
      why: 'Direct question to you in #eng-payments, no reply yet',
    },

    // Due
    {
      id: ID.item.stripe,
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Rotate the Stripe webhook signing secret',
      url: lin('ACME-212'),
      repo: 'ACME',
      author: 'lena.m',
      peopleWaiting: 0,
      priority: 2,
      created: 4 * DAY,
      updated: 1 * DAY,
      ingested: 4 * DAY,
      dueInDays: 0,
    },
    {
      id: ID.item.soc2,
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'SOC 2: export audit-log retention evidence',
      url: lin('ACME-198'),
      repo: 'ACME',
      author: 'wei.zhang',
      peopleWaiting: 0,
      priority: 1,
      created: 9 * DAY,
      updated: 2 * DAY,
      ingested: 9 * DAY,
      dueInDays: -1,
    },

    // People waiting
    {
      id: ID.item.applePay,
      source: 'github',
      kind: 'review-requested',
      title: 'Checkout: Apple Pay button behind a feature flag',
      url: gh('acme/web', 1290),
      repo: 'acme/web',
      author: 'dana-k',
      peopleWaiting: 1,
      created: 22 * HOUR,
      updated: 5 * HOUR,
      ingested: 22 * HOUR,
    },
    {
      id: ID.item.idempotency,
      source: 'github',
      kind: 'reply-needed',
      title: 'Idempotency keys for POST /charges',
      url: gh('acme/api', 477),
      repo: 'acme/api',
      author: LOGIN,
      peopleWaiting: 1,
      created: 3 * DAY,
      updated: 3 * HOUR,
      ingested: 3 * DAY,
    },
    {
      id: ID.item.marcus,
      source: 'slack',
      kind: 'slack-mention',
      title: 'Marcus: is the auth v2 migration safe to run during business hours?',
      url: slack('C02PLATFORM', 'p1760431100456'),
      repo: '#platform',
      author: 'marcus',
      peopleWaiting: 1,
      created: 4 * HOUR,
      updated: 4 * HOUR,
      ingested: 4 * HOUR,
      why: 'Asked you by name; the thread has 3 replies waiting on your answer',
    },
    {
      id: 'github:acme/api#493',
      source: 'github',
      kind: 'review-requested',
      title: 'Audit log: stream events to S3 in batches',
      url: gh('acme/api', 493),
      repo: 'acme/api',
      author: 'wei.zhang',
      peopleWaiting: 1,
      created: 7 * HOUR,
      updated: 2 * HOUR,
      ingested: 7 * HOUR,
    },
    {
      id: 'github:acme/web#1296',
      source: 'github',
      kind: 'review-requested',
      title: 'Onboarding: inline email verification',
      url: gh('acme/web', 1296),
      repo: 'acme/web',
      author: 'tomas.r',
      peopleWaiting: 1,
      created: 36 * HOUR,
      updated: 9 * HOUR,
      ingested: 36 * HOUR,
    },
    {
      id: 'slack:C05DESIGN/p1760436600321',
      source: 'slack',
      kind: 'slack-reply-pending',
      title: 'Dana: can you sanity-check the API error copy before it ships?',
      url: slack('C05DESIGN', 'p1760436600321'),
      repo: '#design',
      author: 'dana-k',
      peopleWaiting: 1,
      created: 2 * HOUR,
      updated: 2 * HOUR,
      ingested: 2 * HOUR,
      why: 'Asked you directly; links a Figma frame with 12 error strings',
    },
    {
      id: 'github:acme/api#490',
      source: 'github',
      kind: 'reply-needed',
      title: 'Per-endpoint retry budgets for outbound webhooks',
      url: gh('acme/api', 490),
      repo: 'acme/api',
      author: LOGIN,
      peopleWaiting: 1,
      created: 2 * DAY,
      updated: 6 * HOUR,
      ingested: 2 * DAY,
    },

    // New
    {
      id: ID.item.flakyBilling,
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Billing retry suite times out on CI',
      url: lin('ACME-231'),
      repo: 'ACME',
      author: 'tomas.r',
      peopleWaiting: 0,
      priority: 3,
      created: 2 * HOUR,
      updated: 2 * HOUR,
      ingested: 2 * HOUR,
      label: 'bug',
    },
    {
      id: ID.item.sentryPdf,
      source: 'web',
      kind: 'job-hit',
      title: 'TypeError in invoice PDF render: 214 events in the last hour',
      url: 'https://acme.sentry.io/issues/48213/',
      repo: 'sentry · api',
      author: 'sentry',
      peopleWaiting: 0,
      created: 50 * MIN,
      updated: 34 * MIN,
      ingested: 34 * MIN,
      jobId: ID.job.sentry,
      ask: 'do',
      why: '214 events/h against a 3/h baseline, starting right after the 14:05 deploy',
    },

    // Brief ready
    {
      id: ID.item.memcached,
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Move the session store off Memcached',
      url: lin('ACME-219'),
      repo: 'ACME',
      author: 'lena.m',
      peopleWaiting: 0,
      priority: 3,
      created: 6 * DAY,
      updated: 2 * DAY,
      ingested: 6 * DAY,
    },
    {
      id: ID.item.undici,
      source: 'github',
      kind: 'job-hit',
      title: 'Dependabot: bump undici from 6.21 to 7.2 (security)',
      url: gh('acme/api', 471),
      repo: 'acme/api',
      author: 'dependabot',
      peopleWaiting: 0,
      created: 30 * HOUR,
      updated: 26 * HOUR,
      ingested: 26 * HOUR,
      jobId: ID.job.deps,
      ask: 'read',
      why: 'Fixes CVE-2026-3311 (request smuggling); major bump, 2 call sites use the old Agent API',
    },

    // AI working
    {
      id: ID.item.paginate,
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Paginate GET /v2/invoices',
      url: lin('ACME-229'),
      repo: 'ACME',
      author: 'dana-k',
      peopleWaiting: 0,
      priority: 3,
      created: 3 * DAY,
      updated: 1 * DAY,
      ingested: 3 * DAY,
      override: { stage: 'working', turn: 'ai' },
    },

    // To review
    {
      id: ID.item.n1,
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Fix the N+1 query in GET /orgs/:id/members',
      url: lin('ACME-224'),
      repo: 'ACME',
      author: 'wei.zhang',
      peopleWaiting: 0,
      priority: 2,
      created: 2 * DAY,
      updated: 26 * HOUR,
      ingested: 2 * DAY,
    },
    {
      id: ID.item.billingTab,
      source: 'github',
      kind: 'own-pr-approved',
      title: 'Settings: move the billing tab to the new layout',
      url: gh('acme/web', 1284),
      repo: 'acme/web',
      author: LOGIN,
      peopleWaiting: 0,
      created: 2 * DAY,
      updated: 1 * HOUR,
      ingested: 2 * DAY,
      handoff: 'on',
    },

    // Waiting on others
    {
      id: ID.item.node22,
      source: 'github',
      kind: 'own-pr-open',
      title: 'Bump Node to 22 LTS in the Dockerfiles',
      url: gh('acme/api', 479),
      repo: 'acme/api',
      author: LOGIN,
      peopleWaiting: 0,
      created: 1 * DAY,
      updated: 20 * HOUR,
      ingested: 1 * DAY,
    },
    {
      id: ID.item.loadTest,
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Load-test the Redis rate limiter at 5k rps',
      url: lin('ACME-205'),
      repo: 'ACME',
      author: 'lena.m',
      peopleWaiting: 0,
      priority: 3,
      created: 5 * DAY,
      updated: 2 * DAY,
      ingested: 5 * DAY,
      override: { turn: 'others', note: 'Infra to provision the staging Redis cluster' },
    },

    // Backlog
    {
      id: 'linear:ACME-187',
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Remove the legacy /v1/export endpoint',
      url: lin('ACME-187'),
      repo: 'ACME',
      author: 'wei.zhang',
      peopleWaiting: 0,
      priority: 4,
      created: 12 * DAY,
      updated: 6 * DAY,
      ingested: 12 * DAY,
    },
    {
      id: 'linear:ACME-176',
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Add OpenTelemetry spans to the job runner',
      url: lin('ACME-176'),
      repo: 'ACME',
      author: 'tomas.r',
      peopleWaiting: 0,
      priority: 3,
      created: 15 * DAY,
      updated: 5 * DAY,
      ingested: 15 * DAY,
    },
    {
      id: 'linear:ACME-214',
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Cache org feature flags per request',
      url: lin('ACME-214'),
      repo: 'ACME',
      author: 'dana-k',
      peopleWaiting: 0,
      priority: 3,
      created: 4 * DAY,
      updated: 3 * DAY,
      ingested: 4 * DAY,
    },
    {
      id: 'github:acme/api#455',
      source: 'github',
      kind: 'mention',
      title: 'Lena mentioned you: retry budget defaults for outbound webhooks',
      url: gh('acme/api', 455),
      repo: 'acme/api',
      author: 'lena.m',
      peopleWaiting: 0,
      priority: 3,
      created: 2 * DAY,
      updated: 30 * HOUR,
      ingested: 2 * DAY,
    },

    // Landed today (done)
    {
      id: 'linear:ACME-227',
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Hotfix: double charge on 3DS card retries',
      url: lin('ACME-227'),
      repo: 'ACME',
      author: 'priya.s',
      peopleWaiting: 0,
      priority: 1,
      created: 1 * DAY,
      updated: 6 * HOUR,
      ingested: 1 * DAY,
      status: { to: 'done', at: 0.15, reason: 'shipped' },
    },
    {
      id: 'github:acme/web#1279',
      source: 'github',
      kind: 'review-requested',
      title: 'Dark-mode tokens for the dashboard',
      url: gh('acme/web', 1279),
      repo: 'acme/web',
      author: 'dana-k',
      peopleWaiting: 1,
      created: 1 * DAY,
      updated: 5 * HOUR,
      ingested: 1 * DAY,
      status: { to: 'done', at: 0.35, reason: 'PR merged' },
    },
    {
      id: 'slack:C03SUPPORT/p1760410000789',
      source: 'slack',
      kind: 'slack-reply-pending',
      title: 'Wei: what rate limits should we quote to Northwind?',
      url: slack('C03SUPPORT', 'p1760410000789'),
      repo: '#support',
      author: 'wei.zhang',
      peopleWaiting: 1,
      created: 9 * HOUR,
      updated: 8 * HOUR,
      ingested: 9 * HOUR,
      status: { to: 'done', at: 0.55 },
    },
    {
      id: 'linear:ACME-201',
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Upgrade Prisma to 6 across services',
      url: lin('ACME-201'),
      repo: 'ACME',
      author: 'tomas.r',
      peopleWaiting: 0,
      priority: 3,
      created: 8 * DAY,
      updated: 4 * HOUR,
      ingested: 8 * DAY,
      status: { to: 'done', at: 0.75, reason: 'shipped' },
    },

    // Parked
    {
      id: 'linear:ACME-160',
      source: 'linear',
      kind: 'ticket-assigned',
      title: 'Evaluate moving cron jobs to Temporal',
      url: lin('ACME-160'),
      repo: 'ACME',
      author: 'lena.m',
      peopleWaiting: 0,
      priority: 4,
      created: 20 * DAY,
      updated: 10 * DAY,
      ingested: 20 * DAY,
      status: { to: 'snoozed', at: 2 * DAY },
    },
    {
      id: 'github:acme/web#1201',
      source: 'github',
      kind: 'mention',
      title: 'Dana mentioned you: chart library bundle size',
      url: gh('acme/web', 1201),
      repo: 'acme/web',
      author: 'dana-k',
      peopleWaiting: 0,
      created: 14 * DAY,
      updated: 12 * DAY,
      ingested: 14 * DAY,
      status: { to: 'archived', at: 6 * DAY },
    },
  ]
}

export function manuals(): DemoManual[] {
  return [
    {
      id: ID.manual.oncall,
      title: 'Send the Q4 on-call rotation to the team',
      description: 'Swap weeks 3 and 4 with Tomás, he is out for KubeCon.',
      created: 2 * DAY,
      dueInDays: 0,
    },
    {
      id: ID.manual.flags,
      title: 'Clean up feature flags older than 90 days',
      description: '41 flags; keep anything referenced by the mobile apps.',
      created: 5 * DAY,
      override: { stage: 'working', turn: 'ai' },
    },
    {
      id: ID.manual.incident,
      title: 'Write the incident review for the queue outage',
      created: 4 * DAY,
      priority: 2,
    },
    {
      id: ID.manual.pg18,
      title: 'Try Postgres 18 async I/O on staging',
      created: 7 * DAY,
    },
  ]
}
