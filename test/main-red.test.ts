/**
 * "Main is red too · not yours" on the row (core/junior/main-red.ts): the
 * evidence line on the open card, Junior's line, the inbox reason, the row's
 * move, and that none of it lands on Needs you or reads orange.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agoOf, checksPhrase, isMainRed, MAIN_RED_LINE, MAIN_RED_SAYS, mainRedEvidence, mainRedWhy } from '../core/junior/main-red.js'
import { ageHot, juniorState, ledgerCount, ledgerRows, onNeeds } from '../core/junior/ledger.js'
import { moveKey, rowMove } from '../core/junior/row-move.js'
import { flowOf } from '../core/work/flow.js'
import type { MainRedCheck } from '../core/work/handoff.js'
import type { ScoredItem } from '../core/work/types.js'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const red = (check: string, over: Partial<MainRedCheck> = {}): MainRedCheck => ({ check, url: 'https://github.com/acme/api/actions/runs/1', sha: 'a1b2c3d4e5f6', at: ago(40 * 60_000), ...over })

function pr(mainRed: MainRedCheck[], over: Partial<ScoredItem> = {}): ScoredItem {
  const base = {
    id: 'github:acme/api#88',
    source: 'github',
    kind: 'own-pr-open',
    title: 'chore: bump node to 22.5',
    url: 'https://github.com/acme/api/pull/88',
    repo: 'acme/api',
    author: 'samar',
    peopleWaiting: 0,
    createdAt: ago(2 * 3_600_000),
    updatedAt: ago(2 * 3_600_000),
    status: 'open',
    score: 30,
    group: 'cycle',
    rankWhy: 'your PR',
    ask: 'do',
    reason: 'your-pr',
    ciFailing: true,
    handoff: 'on',
    junior: { stage: 'watching', readiness: { state: 'ready' } },
    seen: { red: ['lint'], bots: 0, people: 0, rebase: null, draft: false, mainRed },
    ...over,
  } as ScoredItem
  return { ...base, flow: flowOf(base) }
}

test('the evidence line: which check, the commit, how long ago, and main’s run', () => {
  const ev = mainRedEvidence({ mainRed: [red('lint')] }, NOW)
  assert.deepEqual(ev, {
    checks: 'lint',
    sha: 'a1b2c3d',
    ago: '40m',
    url: 'https://github.com/acme/api/actions/runs/1',
    linkLabel: "Open main's run for lint on GitHub",
    text: 'lint failed on main too, at a1b2c3d, 40m ago.',
  })
})

test('the evidence line drops what it doesn’t know, and never links anywhere but a web page', () => {
  assert.equal(mainRedEvidence({ mainRed: [red('lint', { sha: null })] }, NOW)?.text, 'lint failed on main too, 40m ago.')
  assert.equal(mainRedEvidence({ mainRed: [red('lint', { at: null })] }, NOW)?.text, 'lint failed on main too, at a1b2c3d.')
  assert.equal(mainRedEvidence({ mainRed: [red('lint', { sha: null, at: null })] }, NOW)?.text, 'lint failed on main too.')
  assert.equal(mainRedEvidence({ mainRed: [red('lint', { url: null })] }, NOW)?.url, null)
  assert.equal(mainRedEvidence({ mainRed: [red('lint', { url: 'javascript:alert(1)' })] }, NOW)?.url, null)
  assert.equal(mainRedEvidence({ mainRed: [] }, NOW), null)
  assert.equal(mainRedEvidence({}, NOW), null)
  assert.equal(mainRedEvidence(undefined, NOW), null)
})

test('several checks: named two at a time, the link goes to the first', () => {
  assert.equal(checksPhrase(['lint']), 'lint')
  assert.equal(checksPhrase(['lint', 'test']), 'lint and test')
  assert.equal(checksPhrase(['lint', 'test', 'e2e', 'build']), 'lint, test and 2 more')
  const ev = mainRedEvidence({ mainRed: [red('lint'), red('test', { url: 'https://github.com/acme/api/actions/runs/2' })] }, NOW)
  assert.equal(ev?.text, 'lint and test failed on main too, at a1b2c3d, 40m ago.')
  assert.equal(ev?.url, 'https://github.com/acme/api/actions/runs/1')
  // a long check name is clipped on screen; the link's name keeps it whole
  const long = 'integration-tests / postgres-16 / shard 3 of 8 / linux-arm64'
  const lev = mainRedEvidence({ mainRed: [red(long)] }, NOW)
  assert.ok(lev!.checks.length === 40 && lev!.checks.endsWith('…'))
  assert.equal(lev?.linkLabel, `Open main's run for ${long} on GitHub`)
})

test('ages read in minutes, hours, days; a time it can’t read says nothing', () => {
  assert.equal(agoOf(ago(10_000), NOW), '1m')
  assert.equal(agoOf(ago(59 * 60_000), NOW), '59m')
  assert.equal(agoOf(ago(3 * 3_600_000), NOW), '3h')
  assert.equal(agoOf(ago(2 * 86_400_000), NOW), '2d')
  assert.equal(agoOf(null, NOW), null)
  assert.equal(agoOf('not a time', NOW), null)
  assert.equal(agoOf(new Date(NOW + 60_000).toISOString(), NOW), null)
})

test('the row reads "Leave it · main is red too · not yours", the age in its own column', () => {
  const i = pr([red('lint')])
  assert.ok(isMainRed(i))
  const m = rowMove(i, undefined, NOW)
  assert.deepEqual([m?.verb, m?.reasons, m?.age], ['Leave it', ['main is red too', 'not yours'], '2h'])
  assert.equal(m?.text, 'Leave it · main is red too · not yours · waiting 2h')
  // the state column says Babysitting, quietly
  assert.deepEqual(juniorState(i), { text: 'Babysitting', quiet: true })
})

test('never on Needs you, never orange', () => {
  // an open PR of yours scores as FYI: no person waits on it (score.ts)
  const i = pr([red('lint')], { group: 'fyi' })
  assert.equal(onNeeds(i), false)
  assert.equal(ledgerRows([i], 'needs').length, 0)
  assert.equal(ledgerCount([i], 'needs').n, 0)
  for (const tab of ['up', 'prs', 'with'] as const) assert.equal(ledgerRows([i], tab).length, 1, tab)
  // the age column stays ash: only a person waiting turns it orange
  assert.equal(ageHot(i), false)
})

test('the inbox reason column and Junior’s line, only where the turn says main-red', () => {
  assert.equal(mainRedWhy(pr([red('lint')])), MAIN_RED_LINE)
  assert.equal(MAIN_RED_LINE, 'Main is red too · not yours')
  // a real failure beside it: Junior fixes that one, the row keeps its own words
  assert.equal(mainRedWhy(pr([red('lint')], { seen: { red: ['lint', 'test'], bots: 0, people: 0, rebase: null, draft: false, mainRed: [red('lint')] } })), null)
  // not handed off, paused, or the watch off: not main-red
  assert.equal(mainRedWhy(pr([red('lint')], { handoff: undefined, junior: undefined })), null)
  assert.equal(mainRedWhy(pr([red('lint')], { handoff: 'paused', junior: { stage: 'paused' } })), null)
  assert.equal(mainRedWhy(pr([red('lint')], { junior: { stage: 'watching', readiness: { state: 'watch-off', watch: 'babysit' } } })), null)
  // copy rule: short sentences, no "AI", no banned phrases
  for (const sentence of MAIN_RED_SAYS.split(/(?<=\.)\s+/)) assert.ok(sentence.split(/\s+/).length <= 15, sentence)
  assert.ok(!/\bAI\b|24\/7|walk away/i.test(MAIN_RED_SAYS + MAIN_RED_LINE))
})

test('the row remakes its move when main-red comes or goes', () => {
  const i = pr([red('lint')])
  const before = pr([])
  assert.notEqual(moveKey(i), moveKey(before))
})
