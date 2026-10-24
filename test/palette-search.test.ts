/**
 * ⌘K search (server/search-ops.ts, GET /api/search, web/src/paletteSearch.ts):
 * the route answers from the request's own workspace only, item hits carry
 * their state, an empty query is no hits (never a 400), and the palette's
 * merge keeps one row per thing with local rows first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { openSqliteStore } from '../core/store/sqlite.js'
import { SNIPPET_CLOSE as C, SNIPPET_OPEN as O, type SearchResultHit } from '../shared/protocol.js'
import { itemRoutes } from '../server/routes/items.js'
import { searchOp } from '../server/search-ops.js'
import type { ScopedCtx } from '../server/routes/ctx.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'
import { bodyMatch, hitRowId, hitsStillFit, mergeHits, type Searchable, snippetText, stateWord, wantsSearch } from '../web/src/paletteSearch.js'

async function withRts(n: number, fn: (rts: WorkspaceRuntime[]) => Promise<void>) {
  const dirs: string[] = []
  const rts: WorkspaceRuntime[] = []
  for (let i = 0; i < n; i++) {
    const dir = mkdtempSync(path.join(tmpdir(), 'junior-search-'))
    dirs.push(dir)
    const store = openSqliteStore(path.join(dir, 'junior.db'))
    rts.push({ store, meta: { id: `ws${i}` }, clients: new Set(), inboxCache: { stale: true } } as unknown as WorkspaceRuntime)
  }
  try {
    await fn(rts)
  } finally {
    for (const rt of rts) await rt.store.close()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  }
}

async function get(rt: WorkspaceRuntime, pathname: string): Promise<{ status: number; body: { ok: boolean; hits?: SearchResultHit[]; error?: string } }> {
  const req = Readable.from([]) as unknown as ScopedCtx['req']
  ;(req as { method?: string }).method = 'GET'
  let out: { status: number; body: { ok: boolean; hits?: SearchResultHit[] } } | null = null
  const handled = await itemRoutes({
    req,
    url: new URL(`http://localhost${pathname}`),
    json: (status: number, b: unknown) => {
      out = { status, body: b as { ok: boolean; hits?: SearchResultHit[] } }
    },
    rt,
  } as unknown as ScopedCtx)
  assert.equal(handled, true)
  return out!
}

test('route: each workspace sees only its own hit for the same word', async () => {
  await withRts(2, async ([a, b]) => {
    await a.store.items.createManual({ id: 'manual:a1', title: 'Stripe webhook drops events', description: 'the billing retry loop gives up' })
    await b.store.items.createManual({ id: 'manual:b1', title: 'Billing dashboard numbers', description: 'totals look off' })
    const ra = await get(a, '/api/search?q=billing')
    const rb = await get(b, '/api/search?q=billing')
    assert.equal(ra.status, 200)
    assert.deepEqual(ra.body.hits!.map((h) => h.ref), ['manual:a1'])
    assert.deepEqual(rb.body.hits!.map((h) => h.ref), ['manual:b1'])
  })
})

test('route: empty or symbol-only q is no hits, never a 400', async () => {
  await withRts(1, async ([rt]) => {
    await rt.store.items.createManual({ id: 'manual:x', title: 'anything' })
    for (const q of ['', '%20%20', '%22*()', '-']) {
      const r = await get(rt, `/api/search?q=${q}`)
      assert.equal(r.status, 200, q)
      assert.deepEqual(r.body, { ok: true, hits: [] })
    }
    const none = await get(rt, '/api/search')
    assert.deepEqual(none.body, { ok: true, hits: [] })
  })
})

test('op: an item hit carries its state; a body match has a marked snippet; limit caps', async () => {
  await withRts(1, async ([rt]) => {
    await rt.store.items.createManual({ id: 'manual:d', title: 'Bump stripe-node', description: 'needed for the billing retry fix' })
    await rt.store.items.transition('manual:d', { status: 'done', actor: 'user' })
    const [hit] = await searchOp(rt, 'billing retry')
    assert.equal(hit!.ref, 'manual:d')
    assert.equal(hit!.status, 'done')
    assert.equal(stateWord(hit!), 'done')
    assert.ok(hit!.snippet.includes(`${O}billing${C}`))
    assert.equal(bodyMatch(hit!), true)

    for (let i = 0; i < 5; i++) await rt.store.items.createManual({ id: `manual:n${i}`, title: `stripe note ${i}` })
    assert.equal((await searchOp(rt, 'stripe', '3')).length, 3)
    assert.equal((await searchOp(rt, 'stripe', 'nope')).length, 6)
  })
})

test('wantsSearch: 2+ characters with a letter or digit', () => {
  assert.equal(wantsSearch('b'), false)
  assert.equal(wantsSearch('  b '), false)
  assert.equal(wantsSearch('--'), false)
  assert.equal(wantsSearch('bi'), true)
  assert.equal(wantsSearch('#3'), true)
})

test('bodyMatch: a title or id match is not a body match; an empty snippet never is', () => {
  const h = (snippet: string) => ({ title: 'Fix flaky auth test', ref: 'github:acme/api#3235', snippet })
  assert.equal(bodyMatch(h(`Fix ${O}flaky${C} auth test`)), false)
  assert.equal(bodyMatch(h(`…${O}flaky${C} auth…`)), false)
  assert.equal(bodyMatch(h(`github:acme/${O}api${C}#3235`)), false)
  assert.equal(bodyMatch(h('')), false)
  assert.equal(bodyMatch(h(`…the ${O}token${C} expires early…`)), true)
  assert.equal(snippetText(`…the ${O}token${C} expires…`), 'the token expires')
})

type S = 'Actions' | 'Work items' | 'Chats' | 'Artifacts' | 'Projects'
type Row = Searchable<S> & { local?: boolean }
const ORDER: S[] = ['Actions', 'Work items', 'Chats', 'Artifacts', 'Projects']
const hit = (kind: SearchResultHit['kind'], ref: string, title: string, snippet = ''): SearchResultHit => ({ kind, ref, title, snippet })
const make = (h: SearchResultHit): Row => ({ id: hitRowId(h), section: h.kind === 'item' ? 'Work items' : h.kind === 'session' ? 'Chats' : 'Artifacts', label: h.title, snippet: bodyMatch(h) ? h.snippet : undefined })

test('mergeHits: one row per thing, local first, hits in order, grouped by kind', () => {
  const all: Row[] = [
    { id: 'new', section: 'Actions', label: 'New chat', local: true },
    { id: 'w:1', section: 'Work items', label: 'Billing retry', hint: 'acme/api', local: true },
    { id: 'w:2', section: 'Work items', label: 'Stripe webhook', hint: 'acme/api', local: true },
    { id: 's:9', section: 'Chats', label: 'Debug invoice job', local: true },
    { id: 'p:1', section: 'Projects', label: 'New chat in api', local: true },
  ]
  const shown = [all[1]!, all[4]!]
  const hits = [
    hit('artifact', 'A', 'Billing retry plan', `…step 3: ${O}retry${C} with backoff…`),
    hit('item', '1', 'Billing retry', `${O}Billing${C} retry`),
    hit('item', '2', 'Stripe webhook', `…the ${O}billing${C} loop…`),
    hit('item', '7', 'Done thing', ''),
    hit('session', '9', 'Debug invoice job', `why ${O}billing${C} fails`),
    hit('item', '7', 'Done thing again', ''),
  ]
  const rows = mergeHits(shown, all, hits, make, ORDER)
  assert.deepEqual(rows.map((r) => r.id), ['w:1', 'w:2', 'w:7', 's:9', 'a:A', 'p:1'])
  // a title match keeps the row's own hint; a body match lends its snippet
  assert.equal(rows[0]!.snippet, undefined)
  assert.equal(rows[0]!.hint, 'acme/api')
  // a known row the local filter missed comes back as itself (⌘⏎ still works on it)
  assert.equal(rows[1]!.local, true)
  assert.match(rows[1]!.snippet!, /billing/)
  assert.equal(rows[2]!.local, undefined)
  assert.equal(rows[2]!.label, 'Done thing')
  assert.equal(rows[3]!.local, true)
})

test('mergeHits: a null from make leaves the hit out', () => {
  const rows = mergeHits<S, Row>([], [], [hit('item', 'gone', 'Handed off')], () => null, ORDER)
  assert.deepEqual(rows, [])
})

test('hitsStillFit: typing forward keeps the last hits, going elsewhere drops them', () => {
  assert.equal(hitsStillFit('bill', 'billing'), true)
  assert.equal(hitsStillFit('billing', 'bill'), false)
  assert.equal(hitsStillFit('bill', 'stripe'), false)
  assert.equal(hitsStillFit('', 'bill'), false)
})
