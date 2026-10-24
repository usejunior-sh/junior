/**
 * Score weights you set (core/work/weights.ts, server/settings-ops.ts): a
 * weight moves a matching item by exactly its delta, as a named part of the
 * sum and at the end of rankWhy; it stops counting 60 days after it was set
 * (fake clock); and the HTTP route lists, sets and clears through the ops.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { openSqliteStore } from '../core/store/sqlite.js'
import { rank, scoreItem } from '../core/work/score.js'
import { buildInbox } from '../core/work/inbox.js'
import type { ItemKind, WorkItem } from '../core/work/types.js'
import {
  dropWeight,
  isLive,
  liveWeights,
  MAX_WEIGHTS,
  parseWeightKey,
  putWeight,
  readWeights,
  type ScoreWeight,
  WEIGHT_TTL_DAYS,
  weightFrom,
  weightLabel,
  weightParts,
} from '../core/work/weights.js'
import { clearScoreWeightOp, listScoreWeightsOp, readScoreWeights, setScoreWeightOp } from '../server/settings-ops.js'
import { settingsRoutes } from '../server/routes/settings.js'
import type { ScopedCtx } from '../server/routes/ctx.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const DAY = 86_400_000

function item(id: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    source: 'github',
    kind: 'review-requested' as ItemKind,
    title: id,
    url: `https://github.com/acme/web/pull/${id}`,
    repo: 'acme/web',
    author: 'priya',
    peopleWaiting: 1,
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    updatedAt: new Date(NOW - 2 * DAY).toISOString(),
    ...extra,
  }
}

const w = (key: string, delta: number, setAt = NOW, reason?: string): ScoreWeight => ({ key, delta, setAt: new Date(setAt).toISOString(), ...(reason ? { reason } : {}) })

test('a weight changes the score by exactly its delta and is a named part in rankWhy', () => {
  const plain = scoreItem(item('1'), NOW)
  const up = scoreItem(item('1'), NOW, [w('person:priya', 12, NOW, 'Priya matters')])
  assert.equal(up.score - plain.score, 12)
  assert.equal(up.rankWhy, `${plain.rankWhy} · +12 you said Priya matters`)
  const part = up.rankParts!.find((p) => p.weight === 'person:priya')
  assert.deepEqual(part, { points: 12, label: 'you said Priya matters', weight: 'person:priya' })

  const down = scoreItem(item('1'), NOW, [w('repo:acme/web', -8)])
  assert.equal(plain.score - down.score, 8)
  assert.match(down.rankWhy, / · −8 you said acme\/web can wait$/)
})

test('the parts add up to the score, weights or not', () => {
  const cases = [
    item('a'),
    item('b', { kind: 'own-pr-stale', ciFailing: true, isDraft: true, peopleWaiting: 0, updatedAt: new Date(NOW - 40 * DAY).toISOString() }),
    item('c', { kind: 'manual', source: 'manual', priority: 1, updatedAt: new Date(NOW - 0.37 * DAY).toISOString() }),
    item('d', { kind: 'job-hit', source: 'slack', ask: 'reply', peopleWaiting: 3 }),
  ]
  const weights = [w('person:priya', 7), w('kind:manual', -3), w('repo:acme/web', 20)]
  for (const ws of [[], weights]) {
    for (const s of rank(cases, NOW, ws)) {
      const sum = Math.round(s.rankParts!.reduce((t, p) => t + p.points, 0) * 10) / 10
      assert.equal(sum, s.score, s.id)
    }
  }
})

test('no weights: the score and rankWhy are what they were', () => {
  const s = scoreItem(item('1'), NOW)
  // base 100 + 1 person waiting 15 + 2 days × 4
  assert.equal(s.score, 123)
  assert.equal(s.rankWhy, '@priya waiting 2d for your review')
  assert.deepEqual(
    s.rankParts!.map((p) => [p.points, p.label]),
    [
      [100, 'review requested'],
      [15, '1 person waiting'],
      [8, 'waited 2d'],
    ],
  )
})

test('a weight can reorder: the person you said matters goes first', () => {
  const items = [item('ana', { author: 'ana', peopleWaiting: 2 }), item('priya')]
  assert.equal(rank(items, NOW)[0].id, 'ana')
  const ranked = buildInbox({ items, now: NOW, weights: [w('person:Priya', 30)] }).items
  assert.equal(ranked[0].id, 'priya')
})

test('every matching weight counts once; others do not touch the item', () => {
  const ws = [w('person:priya', 5), w('repo:acme/web', 3), w('kind:review-requested', 2), w('person:ana', 50), w('repo:acme/api', 50)]
  const parts = weightParts(item('1'), ws, NOW)
  assert.deepEqual(parts.map((p) => p.key), ['person:priya', 'repo:acme/web', 'kind:review-requested'])
  assert.equal(scoreItem(item('1'), NOW, ws).score - scoreItem(item('1'), NOW).score, 10)
})

test('expired weights are ignored (fake clock)', () => {
  const set = NOW - 10 * DAY
  const ws = [w('person:priya', 12, set)]
  const at = (days: number) => set + days * DAY
  assert.equal(scoreItem(item('1'), at(59.9), ws).score - scoreItem(item('1'), at(59.9)).score, 12)
  assert.equal(scoreItem(item('1'), at(WEIGHT_TTL_DAYS), ws).score, scoreItem(item('1'), at(WEIGHT_TTL_DAYS)).score)
  assert.doesNotMatch(scoreItem(item('1'), at(61), ws).rankWhy, /you said/)
  assert.equal(isLive(ws[0], at(61)), false)
  assert.deepEqual(liveWeights(ws, at(61)), [])
  // an unreadable date never counts
  assert.equal(isLive({ key: 'person:priya', delta: 1, setAt: 'soon' }, NOW), false)
})

test('keys: normalized, and anything else is an error', () => {
  assert.deepEqual(parseWeightKey('person:@Priya'), { ok: true, scope: 'person', value: 'priya', key: 'person:priya' })
  assert.deepEqual(parseWeightKey('Repo: Acme/Web '), { ok: true, scope: 'repo', value: 'acme/web', key: 'repo:acme/web' })
  assert.equal(parseWeightKey('kind:review-requested').ok, true)
  for (const bad of ['kind:nope', 'team:x', 'person:', 'priya', 'repo:acme web', 12, null]) assert.equal(parseWeightKey(bad).ok, false, String(bad))
})

test('weightFrom: whole, bounded, non-zero deltas; short reasons; stamped with now', () => {
  const ok = weightFrom({ key: 'person:priya', delta: 12, reason: '  Priya   matters ' }, NOW)
  assert.deepEqual(ok, { ok: true, weight: { key: 'person:priya', delta: 12, setAt: new Date(NOW).toISOString(), reason: 'Priya matters' } })
  for (const delta of [0, 1.5, 101, -101, '12', undefined]) assert.equal(weightFrom({ key: 'person:priya', delta }, NOW).ok, false, String(delta))
  assert.equal(weightFrom({ key: 'person:priya', delta: 5, reason: 'x'.repeat(121) }, NOW).ok, false)
  assert.equal(weightFrom({ key: 'person:priya', delta: 5, reason: 7 }, NOW).ok, false)
})

test('labels: your words after "you said", else what the weight says', () => {
  assert.equal(weightLabel(w('person:priya', 12, NOW, 'you said Priya matters')), 'you said Priya matters')
  assert.equal(weightLabel(w('person:priya', 12)), 'you said @priya matters')
  assert.equal(weightLabel(w('person:priya', -4)), 'you said @priya can wait')
  assert.equal(weightLabel(w('kind:own-pr-stale', -4)), 'you said own pr stale items can wait')
})

test('put replaces by key and renews; drop removes; both prune the expired; the list is capped', () => {
  const old = w('repo:acme/old', 4, NOW - 61 * DAY)
  let list = putWeight([old, w('person:priya', 5, NOW - DAY)], w('person:priya', 9), NOW)
  assert.deepEqual(list.map((x) => [x.key, x.delta]), [['person:priya', 9]])
  list = putWeight(list, w('repo:acme/web', -3), NOW)
  assert.equal(list.length, 2)
  const dropped = dropWeight(list, 'person:@PRIYA', NOW)
  assert.equal(dropped.removed, true)
  assert.deepEqual(dropped.weights.map((x) => x.key), ['repo:acme/web'])
  assert.equal(dropWeight(list, 'person:nobody', NOW).removed, false)

  let many: ScoreWeight[] = []
  for (let i = 0; i < MAX_WEIGHTS + 5; i++) many = putWeight(many, w(`person:p${i}`, 1, NOW + i), NOW + i)
  assert.equal(many.length, MAX_WEIGHTS)
  assert.equal(many.some((x) => x.key === 'person:p0'), false)
})

test('readWeights: drops what does not parse, re-normalizes, last for a key wins', () => {
  const raw = [{ key: 'person:@Priya', delta: 3, setAt: 'x' }, { key: 'nope', delta: 1, setAt: 'x' }, { key: 'person:priya', delta: 4, setAt: 'y' }, 'junk', { key: 'repo:a/b', setAt: 'z' }]
  assert.deepEqual(readWeights(raw), [{ key: 'person:priya', delta: 4, setAt: 'y' }])
  assert.deepEqual(readWeights({}), [])
})

async function withRt(fn: (rt: WorkspaceRuntime) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-weights-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const rt = { store, meta: { id: 'test' }, clients: new Set(), inboxCache: { stale: true } } as unknown as WorkspaceRuntime
  try {
    await fn(rt)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('ops: set, list, clear; a change drops the inbox snapshot so the next read re-ranks', async () => {
  await withRt(async (rt) => {
    const set = await setScoreWeightOp(rt, { key: 'person:@Priya', delta: 12, reason: 'Priya matters' }, NOW)
    assert.equal(set.weight.label, '+12 you said Priya matters')
    assert.equal(set.weight.expiresAt, new Date(NOW + WEIGHT_TTL_DAYS * DAY).toISOString())
    assert.equal(rt.inboxCache, null)
    await setScoreWeightOp(rt, { key: 'repo:acme/web', delta: -5 }, NOW + 1)
    assert.deepEqual((await listScoreWeightsOp(rt, NOW + 2)).map((x) => x.key), ['repo:acme/web', 'person:priya'])
    // expired: still stored, not listed
    assert.deepEqual(await listScoreWeightsOp(rt, NOW + 61 * DAY), [])
    assert.equal((await readScoreWeights(rt)).length, 2)

    const cleared = await clearScoreWeightOp(rt, { key: 'person:priya' }, NOW + 3)
    assert.deepEqual(cleared.weights.map((x) => x.key), ['repo:acme/web'])
    await assert.rejects(clearScoreWeightOp(rt, { key: 'person:priya' }, NOW + 4), /no weight/)
    await assert.rejects(setScoreWeightOp(rt, { key: 'person:priya', delta: 0 }, NOW), /delta/)
  })
})

test('ops: two quick sets both land', async () => {
  await withRt(async (rt) => {
    await Promise.all([setScoreWeightOp(rt, { key: 'person:a', delta: 1 }, NOW), setScoreWeightOp(rt, { key: 'person:b', delta: 2 }, NOW)])
    assert.equal((await listScoreWeightsOp(rt, NOW)).length, 2)
  })
})

async function call(rt: WorkspaceRuntime, method: string, pathname: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as ScopedCtx['req']
  ;(req as { method?: string }).method = method
  let out: { status: number; body: Record<string, unknown> } | null = null
  const handled = await settingsRoutes({
    req,
    url: new URL(`http://localhost${pathname}`),
    json: (status: number, b: unknown) => {
      out = { status, body: b as Record<string, unknown> }
    },
    rt,
  } as unknown as ScopedCtx)
  assert.equal(handled, true)
  return out!
}

test('route: GET lists, POST sets, POST /clear clears, all through the ops', async () => {
  await withRt(async (rt) => {
    const set = await call(rt, 'POST', '/api/score-weights', { key: 'person:priya', delta: 12, reason: 'Priya matters' })
    assert.equal(set.status, 200)
    assert.equal((set.body.weight as { label: string }).label, '+12 you said Priya matters')
    const listed = await call(rt, 'GET', '/api/score-weights')
    assert.deepEqual((listed.body.weights as { key: string }[]).map((x) => x.key), ['person:priya'])
    const bad = await call(rt, 'POST', '/api/score-weights', { key: 'team:x', delta: 1 })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)
    const cleared = await call(rt, 'POST', '/api/score-weights/clear', { key: 'person:priya' })
    assert.deepEqual(cleared.body, { ok: true, weights: [] })
    assert.equal((await call(rt, 'POST', '/api/score-weights/clear', { key: 'person:priya' })).status, 400)
  })
})
