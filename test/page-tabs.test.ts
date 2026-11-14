/**
 * The page tabs' rules (web/src/app/tabKeys.ts): a thing gets a tab of its
 * own, a place shares the preview tab, and Junior's DM is the pinned first tab.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JUNIOR_TAB, isLegacyKey, isPlaceKey, placeOfKey, routeOfKey, tabKeyOf } from '../web/src/app/tabKeys.js'

test("Junior's DM is one tab, from home and from the agents route", () => {
  assert.equal(tabKeyOf({ page: 'junior' }, true), JUNIOR_TAB)
  assert.equal(tabKeyOf({ page: 'agents', name: 'junior' }, true), JUNIOR_TAB)
  assert.equal(tabKeyOf({ page: 'agents' }, false), JUNIOR_TAB)
  assert.equal(routeOfKey(JUNIOR_TAB, true), '/junior')
  assert.equal(routeOfKey(JUNIOR_TAB, false), '/agents/junior')
})

test("Junior's page with a tab, and the classic home, are a place", () => {
  assert.equal(tabKeyOf({ page: 'junior', tab: 'log' }, true), 'page:junior')
  assert.equal(tabKeyOf({ page: 'junior' }, false), 'page:junior')
})

test('places share the preview tab', () => {
  for (const page of ['inbox', 'prs', 'artifacts', 'jobs', 'terminals', 'changes'] as const) {
    const key = tabKeyOf({ page }, true)!
    assert.ok(isPlaceKey(key), page)
    assert.equal(placeOfKey(key), page)
    assert.equal(routeOfKey(key, true), `/${page}`)
  }
  const settings = tabKeyOf({ page: 'settings' }, true)!
  assert.equal(settings, 'page:settings')
  assert.equal(routeOfKey(settings, true), '/settings')
})

test('things get a tab of their own, and round-trip to their route', () => {
  const cases: [Parameters<typeof tabKeyOf>[0], string, string][] = [
    [{ page: 'session', id: 's1' }, 's1', 's1'],
    [{ page: 'agents', name: 'writer' }, 'dm:writer', '/agents/writer'],
    [{ page: 'item', id: 'github:o/r#12' }, 'item:github:o/r#12', '/item/github%3Ao%2Fr%2312'],
    [{ page: 'artifact', id: 'a1' }, 'artifact:a1', '/artifact/a1'],
    [{ page: 'run', runId: 'r1', path: 'ledger.md' }, 'run:r1', '/run/r1/plan.md'],
    [{ page: 'job', id: 'j1' }, 'job:j1', '/jobs/j1'],
    [{ page: 'job-form', id: null }, 'job-form:new', '/jobs/new'],
    [{ page: 'terminal', id: 't1' }, 'term:t1', '/terminal/t1'],
    [{ page: 'draft', id: 'd1' }, 'draft:d1', '/new/d1'],
  ]
  for (const [route, key, hash] of cases) {
    assert.equal(tabKeyOf(route, true), key)
    assert.ok(!isPlaceKey(key))
    assert.equal(routeOfKey(key, true), hash)
  }
})

test('redirecting routes have no tab; the old pinned keys are retired', () => {
  assert.equal(tabKeyOf({ page: 'home' }, true), null)
  assert.equal(tabKeyOf({ page: 'goals' }, true), null)
  assert.ok(isLegacyKey('inbox') && isLegacyKey('junior'))
  assert.ok(!isPlaceKey('page:nowhere'))
})
