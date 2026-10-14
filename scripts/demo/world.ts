// The demo world: a believable week for "Alex", an engineer at Acme, as
// triage would hold it. Pure data — seed.ts writes it into a store. Every time
// is relative to `now`, so a fresh seed always looks like today.
//
// Rules this file keeps (each one is a way a demo inbox goes wrong):
// - no `#123` / `ABC-12` in titles unless items should fold together (link.ts)
// - FYI-ish items stay fresh, or fade.ts archives them
// - GitHub items only use repos listed in REPOS (scopeGitHub)

export const LOGIN = 'alexr'
export const WORKSPACE_NAME = 'Acme'
export const REPOS = ['acme/api', 'acme/web']
export const MODEL = 'opus'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Fixed ids, so scenes can address them (`#<sessionId>`, `#/item/<id>`). */
export const ID = {
  project: 'demo-api',
  s: {
    // the dispatched session that finished: transcript → PR → "To review"
    fixN1: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000001',
    // in flight (AI working)
    paginate: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000002',
    // drafted a Slack reply, held for approval (Needs you now + Actions)
    replyPriya: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000003',
    flags: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000004',
    latency: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000005',
  },
  job: {
    prSweep: '6a0b1f2e-0000-4c1d-8e7f-000000000001',
    sentry: '6a0b1f2e-0000-4c1d-8e7f-000000000002',
    linear: '6a0b1f2e-0000-4c1d-8e7f-000000000003',
    deps: '6a0b1f2e-0000-4c1d-8e7f-000000000004',
    escalations: '6a0b1f2e-0000-4c1d-8e7f-000000000005',
    digest: '6a0b1f2e-0000-4c1d-8e7f-000000000006',
  },
  item: {
    ciRedis: 'github:acme/api#482',
    priya: 'slack:C04ENGPAY/p1760440200123',
    stripe: 'linear:ACME-212',
    soc2: 'linear:ACME-198',
    applePay: 'github:acme/web#1290',
    idempotency: 'github:acme/api#477',
    marcus: 'slack:C02PLATFORM/p1760431100456',
    flakyBilling: 'linear:ACME-231',
    sentryPdf: 'web:sentry.io/acme/issues/48213',
    memcached: 'linear:ACME-219',
    undici: 'github:acme/api#471',
    paginate: 'linear:ACME-229',
    n1: 'linear:ACME-224',
    billingTab: 'github:acme/web#1284',
    node22: 'github:acme/api#479',
    loadTest: 'linear:ACME-205',
  },
  manual: {
    oncall: 'manual:3f1c9a52-7d1e-4f60-a2b4-6c0de0000001',
    flags: 'manual:3f1c9a52-7d1e-4f60-a2b4-6c0de0000002',
    incident: 'manual:3f1c9a52-7d1e-4f60-a2b4-6c0de0000003',
    pg18: 'manual:3f1c9a52-7d1e-4f60-a2b4-6c0de0000004',
  },
} as const

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

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
  /** when triage first saw it (ms ago) — drives "New" */
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
    // — Needs you now —
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

    // — Due —
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

    // — People waiting —
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

    // — New —
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

    // — Brief ready —
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

    // — AI working —
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

    // — To review —
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
    },

    // — Waiting on others —
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

    // — Backlog —
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

    // — Landed today (done) —
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

    // — Parked —
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

// ---------------------------------------------------------------------------
// Sessions: a compact transcript DSL, expanded to SDK events by seed.ts
// ---------------------------------------------------------------------------

export type Step =
  | { user: string }
  | { say: string }
  | { tool: string; input: Record<string, unknown>; out: string; secs?: number; error?: boolean; id?: string }
  | { done: { turns: number; cost: number } }

export type DemoSession = {
  id: string
  title: string
  /** started, ms ago */
  started: number
  itemId?: string
  model?: string
  pinned?: boolean
  steps: Step[]
}

export function sessions(root: string): DemoSession[] {
  const f = (p: string) => `${root}/${p}`
  return [
    {
      id: ID.s.fixN1,
      title: 'Fix the N+1 query in org members',
      started: 3 * HOUR,
      itemId: ID.item.n1,
      steps: [
        {
          user: 'ACME-224: GET /orgs/:id/members does one query per member to load roles. Fix it, keep the response shape identical, add a test that pins the query count, and open a PR.',
        },
        { say: "I'll start with the handler and the repository it calls." },
        {
          tool: 'Grep',
          input: { pattern: 'listMembers', path: f('src') },
          out: 'src/routes/orgs.ts:41\nsrc/repos/members.ts:12\nsrc/repos/members.test.ts:8',
          secs: 1,
        },
        {
          tool: 'Read',
          input: { file_path: f('src/repos/members.ts') },
          out: [
            "1\timport { db } from '../db'",
            '2\t',
            '12\texport async function listMembers(orgId: string) {',
            "13\t  const members = await db.member.findMany({ where: { orgId } })",
            '14\t  return Promise.all(',
            '15\t    members.map(async (m) => ({',
            '16\t      ...m,',
            '17\t      roles: await db.role.findMany({ where: { memberId: m.id } }),',
            '18\t    })),',
            '19\t  )',
            '20\t}',
          ].join('\n'),
          secs: 1,
        },
        {
          say: 'Found it: `listMembers` loads every member, then fires one `role.findMany` per member. A 400-person org makes 401 queries. One `include` collapses that to a single join.',
        },
        {
          tool: 'Edit',
          input: {
            file_path: f('src/repos/members.ts'),
            old_string:
              '  const members = await db.member.findMany({ where: { orgId } })\n  return Promise.all(\n    members.map(async (m) => ({\n      ...m,\n      roles: await db.role.findMany({ where: { memberId: m.id } }),\n    })),\n  )',
            new_string: '  return db.member.findMany({\n    where: { orgId },\n    include: { roles: true },\n    orderBy: { createdAt: \'asc\' },\n  })',
          },
          out: 'The file src/repos/members.ts has been updated.',
          secs: 1,
        },
        {
          tool: 'Edit',
          input: {
            file_path: f('src/repos/members.test.ts'),
            old_string: "describe('listMembers', () => {",
            new_string:
              "describe('listMembers', () => {\n  it('loads members and roles in one query', async () => {\n    const org = await seedOrg({ members: 50 })\n    const queries = await countQueries(() => listMembers(org.id))\n    expect(queries).toBe(1)\n  })\n",
          },
          out: 'The file src/repos/members.test.ts has been updated.',
          secs: 1,
        },
        {
          tool: 'Bash',
          input: { command: 'npm test -- src/repos/members.test.ts', description: 'Run the members tests' },
          out: ' PASS  src/repos/members.test.ts (1.8 s)\n  listMembers\n    ✓ returns members with roles (41 ms)\n    ✓ loads members and roles in one query (63 ms)\n    ✓ keeps the response shape (12 ms)\n\nTests: 3 passed, 3 total',
          secs: 9,
        },
        {
          tool: 'Bash',
          input: {
            command: 'git checkout -b fix/org-members-n-plus-one && git commit -am "members: load roles with one query" && git push -u origin fix/org-members-n-plus-one',
            description: 'Commit and push the fix branch',
          },
          out: "Switched to a new branch 'fix/org-members-n-plus-one'\n[fix/org-members-n-plus-one 8c41d2e] members: load roles with one query\n 2 files changed, 12 insertions(+), 9 deletions(-)\nTo github.com:acme/api.git\n * [new branch]      fix/org-members-n-plus-one -> fix/org-members-n-plus-one",
          secs: 4,
          id: 'toolu_demo_push',
        },
        {
          tool: 'Bash',
          input: {
            command: 'gh pr create --title "Fix N+1 query in GET /orgs/:id/members" --body "Loads roles with one include instead of one query per member. 401 → 1 queries for a 400-member org. Response shape unchanged; new test pins the query count. Closes ACME-224."',
            description: 'Open the pull request',
          },
          out: 'https://github.com/acme/api/pull/486',
          secs: 3,
          id: 'toolu_demo_pr',
        },
        {
          say: [
            'Opened **acme/api#486**.',
            '',
            '- `listMembers` now loads roles with one `include`: **401 → 1 queries** for a 400-member org.',
            '- Response shape is unchanged; members come back in the same order.',
            '- New test pins the query count at 1, so this can\'t regress silently.',
            '',
            'p95 for this endpoint should drop from ~840 ms to under 60 ms on the big orgs.',
          ].join('\n'),
        },
        { done: { turns: 9, cost: 0.38 } },
      ],
    },
    {
      id: ID.s.paginate,
      title: 'Paginate GET /v2/invoices',
      started: 14 * MIN,
      itemId: ID.item.paginate,
      steps: [
        {
          user: 'ACME-229: /v2/invoices returns every invoice for an org. Add cursor pagination (limit + cursor, default 50, max 200), keep v1 untouched, and update the OpenAPI spec.',
        },
        { say: "I'll check how the other v2 list endpoints paginate so this one matches." },
        {
          tool: 'Grep',
          input: { pattern: 'encodeCursor', path: f('src') },
          out: 'src/lib/cursor.ts:3\nsrc/routes/v2/customers.ts:27\nsrc/routes/v2/payments.ts:31',
          secs: 1,
        },
        {
          tool: 'Read',
          input: { file_path: f('src/routes/v2/customers.ts') },
          out: "27\t  const { limit = 50, cursor } = parsePage(req.query, { max: 200 })\n28\t  const rows = await db.customer.findMany({ take: limit + 1, ...after(cursor) })\n29\t  return page(rows, limit, encodeCursor)",
          secs: 1,
        },
        {
          say: '`customers` and `payments` share `parsePage` / `page` from `src/lib/cursor.ts`. Same helpers here, so all three endpoints behave identically.',
        },
        {
          tool: 'Edit',
          input: {
            file_path: f('src/routes/v2/invoices.ts'),
            old_string: '  const rows = await db.invoice.findMany({ where: { orgId } })\n  return { data: rows }',
            new_string:
              "  const { limit = 50, cursor } = parsePage(req.query, { max: 200 })\n  const rows = await db.invoice.findMany({\n    where: { orgId },\n    orderBy: { id: 'asc' },\n    take: limit + 1,\n    ...after(cursor),\n  })\n  return page(rows, limit, encodeCursor)",
          },
          out: 'The file src/routes/v2/invoices.ts has been updated.',
          secs: 1,
        },
        {
          tool: 'Bash',
          input: { command: 'npm test -- src/routes/v2', description: 'Run the v2 route tests' },
          out: ' PASS  src/routes/v2/customers.test.ts\n PASS  src/routes/v2/payments.test.ts\n PASS  src/routes/v2/invoices.test.ts\n\nTests: 38 passed, 38 total',
          secs: 12,
        },
        { say: 'Routes pass. Now updating `openapi/v2.yaml` with the `limit` and `cursor` parameters and the `next_cursor` field…' },
      ],
    },
    {
      id: ID.s.replyPriya,
      title: 'Reply to Priya about webhook retries',
      started: 40 * MIN,
      itemId: ID.item.priya,
      steps: [
        { user: 'Draft a reply to Priya. Check where webhook retries actually are before promising anything for Friday.' },
        {
          tool: 'Bash',
          input: { command: 'gh pr list --repo acme/api --search "webhook retries" --state all', description: 'Find the webhook retry PRs' },
          out: '491  Webhook retries with exponential backoff   feat/webhook-retries   OPEN    approved, CI green\n488  Dead-letter queue for failed webhooks       feat/webhook-dlq       MERGED',
          secs: 2,
        },
        {
          say: 'The retry PR is approved with CI green, and the dead-letter queue it depends on merged yesterday. Friday is realistic. Drafting the reply.',
        },
        {
          tool: 'mcp__claude_ai_Slack__slack_send_message',
          input: {
            channel_id: 'C04ENGPAY',
            thread_ts: '1760440200.123',
            text: "Yes, Friday works. The retry PR is approved with CI green, and the dead-letter queue it needs merged yesterday. I'll merge Thursday morning so we get a day on staging first. Failed deliveries retry 5 times over ~2h, then land in the DLQ.",
          },
          out: 'Held for your approval in Actions.',
          secs: 1,
          id: 'toolu_demo_slack',
        },
        { say: 'Drafted and held for your approval: it says Friday works, merging Thursday for a day on staging.' },
        { done: { turns: 3, cost: 0.07 } },
      ],
    },
    {
      id: ID.s.flags,
      title: 'Clean up stale feature flags',
      started: 22 * MIN,
      itemId: ID.manual.flags,
      model: 'sonnet',
      steps: [
        { user: 'Find feature flags older than 90 days that are fully rolled out, and remove them. Skip anything the mobile apps reference.' },
        {
          tool: 'Bash',
          input: { command: 'npx flags list --older-than 90d --state rolled-out --json | jq length', description: 'Count stale rolled-out flags' },
          out: '41',
          secs: 3,
        },
        { say: '41 candidates. Checking each one against the mobile repos before touching anything…' },
      ],
    },
    {
      id: ID.s.latency,
      title: 'Why is p95 up on /search?',
      started: 26 * HOUR,
      pinned: false,
      steps: [
        { user: 'p95 on /search went from 180ms to 420ms since Tuesday. What changed?' },
        {
          tool: 'Bash',
          input: { command: 'git log --since="last tuesday" --oneline -- src/search', description: 'Recent changes to search' },
          out: 'a91f0c2 search: add fuzzy matching on customer name\n2be4d17 search: bump result limit to 100',
          secs: 1,
        },
        {
          say: '`a91f0c2` added fuzzy matching with `ILIKE \'%term%\'`, which can\'t use the btree index on `name`. Every search now seq-scans `customers`. A `pg_trgm` GIN index fixes it without changing behavior:\n\n```sql\nCREATE INDEX CONCURRENTLY customers_name_trgm ON customers USING gin (name gin_trgm_ops);\n```',
        },
        { done: { turns: 2, cost: 0.05 } },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type DemoJob = {
  id: string
  file: string
  title: string
  schedule: string
  tools: string[]
  output: 'items' | 'digest'
  enabled: boolean
  instruction: string
  /** per past run, newest last: matches filed (null = failed) */
  runs: (number | null)[]
}

export function jobs(): DemoJob[] {
  return [
    {
      id: ID.job.prSweep,
      file: 'pr-review-sweep',
      title: 'Morning PR review sweep',
      schedule: '30 8 * * 1-5',
      tools: ['github'],
      output: 'items',
      enabled: true,
      instruction:
        'Find open PRs in acme/api and acme/web where my review is requested or I was mentioned since yesterday. File one item per PR; say in one line what the PR changes and how big it is.\n\nNever comment, approve or request changes.',
      runs: [3, 1, 2, 4, 2, 1, 2],
    },
    {
      id: ID.job.sentry,
      file: 'sentry-spikes',
      title: 'Sentry error spikes after deploys',
      schedule: '0 10,14,18 * * 1-5',
      tools: ['web'],
      output: 'items',
      enabled: true,
      instruction:
        'Check Sentry for acme-api issues whose event rate is 10x their 7-day baseline, or that first appeared after the latest deploy. File one item per issue with the rate, the baseline and the suspect deploy.\n\nNever resolve, assign or mute issues.',
      runs: [0, 1, 0, null, 0, 2, 1],
    },
    {
      id: ID.job.linear,
      file: 'linear-assigned',
      title: 'Linear tickets assigned to me',
      schedule: '0 9 * * 1-5',
      tools: ['web'],
      output: 'items',
      enabled: true,
      instruction: 'List Linear issues in team ACME newly assigned to me or moved back to me. File each with its priority and due date.\n\nNever change an issue\'s state.',
      runs: [2, 0, 1, 1, 3, 0, 1],
    },
    {
      id: ID.job.deps,
      file: 'dependabot-triage',
      title: 'Dependabot triage',
      schedule: '0 11 * * 1',
      tools: ['github'],
      output: 'items',
      enabled: true,
      instruction:
        'Go through open Dependabot PRs in acme/api. Ignore patch bumps with green CI. File security fixes and major bumps, saying what breaks and which call sites need a change.\n\nNever merge or close a PR.',
      runs: [1, 0, 2, 1, 0, 1, 1],
    },
    {
      id: ID.job.escalations,
      file: 'support-escalations',
      title: 'Customer escalations in #support',
      schedule: '0 12,17 * * 1-5',
      tools: ['web'],
      output: 'items',
      enabled: true,
      instruction: 'Find threads in #support from the last half day that name the API, a 5xx or a rate limit and have no engineer reply yet. File each with the customer and the ask.\n\nNever post in the channel.',
      runs: [1, 0, 0, 2, 1, 0, 1],
    },
    {
      id: ID.job.digest,
      file: 'weekly-shipped-digest',
      title: 'Weekly digest: what shipped',
      schedule: '0 16 * * 5',
      tools: ['github'],
      output: 'digest',
      enabled: false,
      instruction: 'Summarise PRs merged into acme/api and acme/web this week, grouped by area, with one line each.',
      runs: [1, 1, 1],
    },
  ]
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export type DemoArtifact = {
  id: string
  path: string
  title: string
  author: 'human' | 'model'
  refs: string[]
  /** written, ms ago */
  updated: number
  body: string
  /** brief of / context on an item */
  link?: { itemId: string; role: 'brief' | 'context' }
  /** brief_jobs playbook, when this is a ready brief */
  playbook?: string
}

export function artifacts(): DemoArtifact[] {
  return [
    {
      id: '9b7c2d10-0001-4a5e-8f00-de0000000001',
      path: 'briefs/linear-acme-224.md',
      title: 'Brief: Fix the N+1 query in GET /orgs/:id/members',
      author: 'model',
      refs: ['linear:ACME-224'],
      updated: 4 * HOUR,
      link: { itemId: ID.item.n1, role: 'brief' },
      playbook: 'ticket-assigned',
      body: `# Fix the N+1 query in GET /orgs/:id/members

**Ask:** make the members endpoint stop issuing one query per member. Wei filed it after a 400-seat customer saw 2s+ page loads.

## What's going on
- \`listMembers\` (src/repos/members.ts:12) loads members, then calls \`role.findMany\` once per member inside \`Promise.all\`.
- For a 400-member org that is **401 queries**; p95 on this route is 840 ms for orgs over 200 seats.

## Suggested fix
1. Replace the per-member lookup with \`include: { roles: true }\`, one query with a join.
2. Keep \`orderBy: createdAt\`: the web app relies on the order for its "joined" column.
3. Add a test that counts queries (\`countQueries\` helper already exists in test/utils).

## Risk
Low. The response shape is identical; no migration. The roles table is indexed on \`member_id\`.

## Done when
- Members tests pass, with a new test pinning the query count at 1.
- PR open against acme/api, linking ACME-224.
`,
    },
    {
      id: '9b7c2d10-0002-4a5e-8f00-de0000000002',
      path: 'briefs/linear-acme-219.md',
      title: 'Brief: Move the session store off Memcached',
      author: 'model',
      refs: ['linear:ACME-219'],
      updated: 50 * MIN,
      link: { itemId: ID.item.memcached, role: 'brief' },
      playbook: 'ticket-assigned',
      body: `# Move the session store off Memcached

**Ask:** retire the last Memcached dependency. Sessions are the only thing left on it, and the cluster costs ~$1.1k/month.

## Where sessions live today
- \`src/auth/session-store.ts\` wraps \`memjs\` with get/set/touch; TTL 14 days.
- 3 call sites: login, refresh, logout. No other service reads the keys.

## Options
| Option | Effort | Notes |
|---|---|---|
| Redis (already running for rate limits) | ~1 day | Same TTL semantics; reuse the client from acme/api#482 |
| Postgres table | ~2 days | Durable, but adds write load on every refresh |

**Recommendation:** Redis. Dual-write for 14 days (one TTL), read from Redis with Memcached fallback, then cut over.

## Risk
Medium: a bad cut-over logs everyone out. The dual-write window removes that.
`,
    },
    {
      id: '9b7c2d10-0003-4a5e-8f00-de0000000003',
      path: 'briefs/github-acme-api-471.md',
      title: 'Brief: Dependabot bumps undici 6.21 → 7.2',
      author: 'model',
      refs: ['github:acme/api#471'],
      updated: 20 * HOUR,
      link: { itemId: ID.item.undici, role: 'brief' },
      playbook: 'job-hit',
      body: `# Dependabot: bump undici from 6.21 to 7.2

**Why it matters:** fixes CVE-2026-3311 (HTTP request smuggling, high). The bump is major, so CI being green isn't the whole story.

## What breaks
- \`new Agent({ connections })\` was renamed in 7.x; we use it in \`src/lib/http.ts:18\` and \`src/webhooks/deliver.ts:44\`.
- \`bodyTimeout\` default changed from 300s to 30s; webhook delivery to slow customers would start timing out.

## Suggested change
Update both call sites, pin \`bodyTimeout: 120_000\` for webhook delivery, then merge. ~30 minutes.
`,
    },
    {
      id: '9b7c2d10-0004-4a5e-8f00-de0000000004',
      path: 'notes/rate-limiter-on-redis.md',
      title: 'Rate limiter on Redis: design notes',
      author: 'human',
      refs: ['github:acme/api#482'],
      updated: 2 * DAY,
      link: { itemId: ID.item.ciRedis, role: 'context' },
      body: `# Rate limiter on Redis

- Token bucket per (org, route class); refill in a Lua script so it stays atomic.
- Fail open if Redis is unreachable for more than 200ms, and alert.
- Keys expire after 2× the window so idle orgs cost nothing.
`,
    },
    {
      id: '9b7c2d10-0005-4a5e-8f00-de0000000005',
      path: 'notes/q4-on-call-rotation.md',
      title: 'Q4 on-call rotation',
      author: 'human',
      refs: [],
      updated: 1 * DAY,
      link: { itemId: ID.manual.oncall, role: 'context' },
      body: `# Q4 on-call rotation

| Week | Primary | Secondary |
|---|---|---|
| Oct 20 | Alex | Priya |
| Oct 27 | Tomás | Dana |
| Nov 3 | Dana | Alex |
| Nov 10 | Priya | Tomás |
`,
    },
  ]
}

// ---------------------------------------------------------------------------
// The demo project's repo: just enough code for paths and diffs to be real
// ---------------------------------------------------------------------------

export const REPO_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: '@acme/api', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2) + '\n',
  'README.md': '# acme/api\n\nThe Acme public API.\n',
  'src/db.ts': "import { PrismaClient } from '@prisma/client'\n\nexport const db = new PrismaClient()\n",
  'src/repos/members.ts':
    "import { db } from '../db'\n\nexport async function listMembers(orgId: string) {\n  return db.member.findMany({\n    where: { orgId },\n    include: { roles: true },\n    orderBy: { createdAt: 'asc' },\n  })\n}\n",
  'src/routes/v2/invoices.ts':
    "import { db } from '../../db'\n\nexport async function listInvoices(orgId: string) {\n  const rows = await db.invoice.findMany({ where: { orgId } })\n  return { data: rows }\n}\n",
  'src/lib/cursor.ts': "export const encodeCursor = (id: string) => Buffer.from(id).toString('base64url')\n",
}

/** Uncommitted edits on top, so the Changes view has something to show. */
export const REPO_EDITS: Record<string, string> = {
  'src/routes/v2/invoices.ts':
    "import { db } from '../../db'\nimport { after, encodeCursor, page, parsePage } from '../../lib/cursor'\n\nexport async function listInvoices(orgId: string, query: Record<string, string>) {\n  const { limit = 50, cursor } = parsePage(query, { max: 200 })\n  const rows = await db.invoice.findMany({\n    where: { orgId },\n    orderBy: { id: 'asc' },\n    take: limit + 1,\n    ...after(cursor),\n  })\n  return page(rows, limit, encodeCursor)\n}\n",
  'src/lib/cursor.ts':
    "export const encodeCursor = (id: string) => Buffer.from(id).toString('base64url')\nexport const decodeCursor = (c: string) => Buffer.from(c, 'base64url').toString()\n",
}
