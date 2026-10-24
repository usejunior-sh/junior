import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Learning } from '../core/junior/learnings.js'
import { agoText, editCutsTooMuch, footerState, latestSource, notebookOrder, scopeText, sourceLabel, usedText } from '../web/src/learnings-view.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 24, 12)

const l = (id: string, over: Partial<Learning> = {}): Learning => ({
  id,
  text: `learning ${id}`,
  scope: 'global',
  status: 'proposed',
  sources: [{ ref: 'pr:acme/web#3235', day: '2026-10-20' }],
  createdAt: NOW - 5 * DAY,
  proposedAt: NOW - 1 * DAY,
  ...over,
})

test('sourceLabel: a PR opens GitHub, chats and items open here, paths are mono', () => {
  assert.deepEqual(sourceLabel('pr:acme/web#3235'), { label: 'PR #3235', mono: false, title: 'pr:acme/web#3235', href: 'https://github.com/acme/web/pull/3235' })
  assert.equal(sourceLabel('slack:C123/1712345.000').label, 'a Slack thread')
  assert.equal(sourceLabel('slack:C123/1712345.000').href, undefined)
  assert.deepEqual(sourceLabel('session:abc-123'), { label: 'a chat', mono: false, title: 'session:abc-123', hash: '/abc-123' })
  assert.equal(sourceLabel('item:gh:acme/web#1').hash, '/item/gh%3Aacme%2Fweb%231')
  assert.deepEqual(sourceLabel('src/ci.ts:42'), { label: 'src/ci.ts:42', mono: true, title: 'src/ci.ts:42' })
  assert.equal(sourceLabel('file:src/ci.ts').label, 'src/ci.ts')
  assert.equal(sourceLabel('https://example.com/a/b').label, 'example.com')
  // unknown: the raw ref, mono, no link
  const odd = sourceLabel('wiki:Runbook')
  assert.equal(odd.label, 'wiki:Runbook')
  assert.equal(odd.mono, true)
  assert.equal(odd.href ?? odd.hash, undefined)
})

test('scope, last source and last use read as the notebook says them', () => {
  assert.equal(scopeText('global'), 'everywhere')
  assert.equal(scopeText('repo:acme/web'), 'acme/web')
  assert.equal(latestSource(l('a', { sources: [{ ref: 'old', day: '2026-10-01' }, { ref: 'new', day: '2026-10-02' }] })), 'new')
  assert.equal(latestSource(l('a', { sources: [] })), null)
  assert.equal(usedText(l('a'), NOW), 'not used yet')
  assert.equal(usedText(l('a', { lastUsedAt: NOW - 30 * 3_600_000 }), NOW), 'used yesterday')
  assert.equal(usedText(l('a', { lastUsedAt: NOW - 21 * DAY }), NOW), 'used 3w ago')
  assert.equal(agoText(30_000), 'just now')
  assert.equal(agoText(5 * 60_000), '5m ago')
  assert.equal(agoText(3 * 3_600_000), '3h ago')
  assert.equal(agoText(4 * DAY), '4d ago')
  assert.equal(agoText(90 * DAY), '3mo ago')
})

test('notebookOrder: proposed, then stale, then kept; newest first in each; never candidates', () => {
  const list = [
    l('kept-old', { status: 'kept', keptAt: NOW - 9 * DAY }),
    l('cand', { status: 'candidate' }),
    l('stale', { status: 'stale', staleAt: NOW - 2 * DAY }),
    l('prop-old', { proposedAt: NOW - 3 * DAY }),
    l('kept-new', { status: 'kept', keptAt: NOW - 1 * DAY }),
    l('prop-new', { proposedAt: NOW - 1 * 3_600_000 }),
  ]
  assert.deepEqual(
    notebookOrder(list).map((x) => x.id),
    ['prop-new', 'prop-old', 'stale', 'kept-new', 'kept-old'],
  )
})

test('footerState: read from the list by id once a list from after the proposal is in', () => {
  const p = l('p')
  // no list yet, or a list read before the proposal: the proposal stands in
  assert.equal(footerState(p, null, 0).state, 'proposed')
  assert.equal(footerState(p, [], NOW - 2 * DAY).state, 'proposed')
  // a later list without it: forgotten
  assert.equal(footerState(p, [], NOW).state, 'undone')
  // a later list with it: whatever it is now, with its current words
  const kept = { ...p, status: 'kept' as const, text: 'new words' }
  assert.deepEqual(footerState(p, [kept], NOW), { state: 'kept', learning: kept })
  assert.equal(footerState(p, [{ ...p, status: 'stale' }], NOW).state, 'stale')
  assert.equal(footerState(p, [p], NOW).state, 'proposed')
})

test('editCutsTooMuch: more than half and at least 20 characters gone asks first', () => {
  const long = 'Run pnpm test:unit, not pnpm test, in acme/web before every push.'
  assert.equal(editCutsTooMuch(long, 'Run pnpm test:unit.'), true)
  assert.equal(editCutsTooMuch(long, 'Run pnpm test:unit, not pnpm test, in acme/web.'), false)
  // short learnings can always change
  assert.equal(editCutsTooMuch('Squash-merge.', 'No.'), false)
})
