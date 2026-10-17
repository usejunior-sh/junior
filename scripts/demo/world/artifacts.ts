import { DAY, HOUR, ID, MIN } from './base.js'

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
