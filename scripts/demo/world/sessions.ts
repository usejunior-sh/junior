import { HOUR, ID, MIN } from './base.js'

// Sessions: a compact transcript DSL, expanded to SDK events by seed.ts

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
