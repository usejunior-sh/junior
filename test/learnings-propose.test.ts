/**
 * propose_learning (learnings-propose-tool): a receipt is required, one
 * sighting stays a quiet candidate, two on different days make a proposal
 * (the card), two on the same day don't, at most PROPOSALS_PER_DAY new
 * proposals a day, and only kept learnings are ever loadable. Fake clock:
 * time is always an argument.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  learningProposalOf,
  loadable,
  parseLearning,
  PROPOSALS_PER_DAY,
  proposalsOn,
  proposeLearningResult,
  serializeLearning,
  sight,
  type Learning,
} from '../core/junior/learnings.js'
import { JUNIOR_MCP_INSTRUCTIONS } from '../shared/juniorContext.js'
import { JUNIOR_READ_TOOLS } from '../server/session/effects.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The op pulls in the workspace registry; keep it off the real ~/.junior.
const home = mkdtempSync(path.join(tmpdir(), 'junior-learnings-propose-'))
process.env.JUNIOR_HOME = home
const { proposeLearningOp, listLearningsOp, learningsFolder } = await import('../server/learnings-ops.js')
test.after(() => rmSync(home, { recursive: true, force: true }))

/** Local time, so day keys don't depend on the machine's zone. */
const at = (d: number, h = 10) => new Date(2026, 9, d, h).getTime()

let n = 0
/** A fake runtime: enough for the op (its folder and a broadcast to nobody). */
const fakeRt = () => ({ meta: { id: `ws-${++n}` }, clients: new Set() }) as unknown as WorkspaceRuntime

const say = (text: string, ref: string, scope = 'global') => ({ text, scope, source: ref })

test('no source is an error, and nothing is written', async () => {
  const rt = fakeRt()
  await assert.rejects(proposeLearningOp(rt, { text: 'Squash merge', scope: 'global' }, at(20)), /ref/)
  await assert.rejects(proposeLearningOp(rt, { text: 'Squash merge', scope: 'global', source: '  ' }, at(20)), /ref/)
  assert.deepEqual((await learningsFolder(rt).read()).learnings, [])
})

test('one sighting stays a candidate, unseen by the notebook', async () => {
  const rt = fakeRt()
  const s = await proposeLearningOp(rt, say('Rebase, never merge main in', 'pr:a/b#1'), at(20))
  assert.equal(s.kind, 'candidate')
  assert.equal((await listLearningsOp(rt)).learnings.length, 0)
  assert.equal((await listLearningsOp(rt, { all: true })).learnings.length, 1)
  const r = proposeLearningResult(s)
  assert.equal(r.shown, false)
  assert.equal(learningProposalOf(JSON.stringify(r)), null)
})

test('two sightings on the same day stay a candidate', async () => {
  const rt = fakeRt()
  await proposeLearningOp(rt, say('Rebase, never merge main in', 'pr:a/b#1'), at(20, 9))
  const s = await proposeLearningOp(rt, say('rebase, never merge main in.', 'pr:a/b#2'), at(20, 18))
  assert.equal(s.kind, 'candidate')
  assert.equal(s.learning.sources.length, 2)
  assert.equal(s.learning.proposedAt, undefined)
})

test('sightings on two distinct days make a proposal, with the card in the answer', async () => {
  const rt = fakeRt()
  await proposeLearningOp(rt, say('Rebase, never merge main in', 'pr:a/b#1'), at(20, 23))
  const s = await proposeLearningOp(rt, say('Rebase, never merge main in', 'pr:a/b#2'), at(21, 1))
  assert.equal(s.kind, 'proposed')
  assert.equal(s.learning.status, 'proposed')
  assert.equal(s.learning.proposedAt, at(21, 1))
  assert.deepEqual(
    s.learning.sources.map((x) => x.day),
    ['2026-10-20', '2026-10-21'],
  )
  const card = learningProposalOf(JSON.stringify(proposeLearningResult(s)))
  assert.equal(card?.id, s.learning.id)
  assert.equal((await listLearningsOp(rt)).learnings[0]?.status, 'proposed')
  // proposedAt survives the file.
  const file = readFileSync(learningsFolder(rt).pathOf(s.learning.id), 'utf8')
  assert.match(file, /^proposedAt: /m)
  // A third sighting adds a receipt and nothing else.
  const again = await proposeLearningOp(rt, say('Rebase, never merge main in', 'pr:a/b#3'), at(22))
  assert.equal(again.kind, 'known')
  assert.equal(again.learning.status, 'proposed')
  assert.equal(proposeLearningResult(again).shown, false)
})

test(`the daily cap: at most ${PROPOSALS_PER_DAY} new proposals a day, the rest wait for another day`, async () => {
  const rt = fakeRt()
  const texts = ['One thing', 'Two things', 'Three things', 'Four things', 'Five things']
  for (const [i, t] of texts.entries()) await proposeLearningOp(rt, say(t, `pr:a/b#${i}`), at(20))
  const day2 = []
  for (const [i, t] of texts.entries()) day2.push(await proposeLearningOp(rt, say(t, `pr:a/b#${10 + i}`), at(21)))
  assert.deepEqual(
    day2.map((s) => s.kind),
    ['proposed', 'proposed', 'proposed', 'candidate', 'candidate'],
  )
  const held = day2[3]
  assert.ok(held.kind === 'candidate' && held.held)
  assert.equal(proposeLearningResult(held).held, true)
  assert.equal(held.learning.sources.length, 2)
  // Still held for the rest of that day.
  const sameDay = await proposeLearningOp(rt, say('Four things', 'pr:a/b#30'), at(21, 20))
  assert.equal(sameDay.kind, 'candidate')
  // The next day it goes through.
  const next = await proposeLearningOp(rt, say('Four things', 'pr:a/b#40'), at(22))
  assert.equal(next.kind, 'proposed')
  assert.equal(proposalsOn((await learningsFolder(rt).read()).learnings, '2026-10-21'), 3)
})

test('the cap is pure too: kept learnings proposed today still count', () => {
  const base = (id: string, over: Partial<Learning> = {}): Learning => ({
    id,
    text: id,
    scope: 'global',
    status: 'kept',
    sources: [{ ref: 'pr:a/b#1', day: '2026-10-20' }],
    createdAt: at(20),
    proposedAt: at(21, 8),
    keptAt: at(21, 9),
    ...over,
  })
  const list = [base('a'), base('b'), base('c'), base('d', { status: 'candidate', proposedAt: undefined, keptAt: undefined })]
  const s = sight(list, { text: 'd', scope: 'global', ref: 'pr:a/b#2' }, at(21, 12), () => 'x')
  assert.equal(s.kind, 'candidate')
  assert.equal(sight(list, { text: 'd', scope: 'global', ref: 'pr:a/b#2' }, at(21, 12), () => 'x', 4).kind, 'proposed')
})

test('candidates and proposals are never loadable', () => {
  const mk = (id: string, status: Learning['status']): Learning => ({
    id,
    text: id,
    scope: 'global',
    status,
    sources: [{ ref: 'pr:a/b#1', day: '2026-10-20' }],
    createdAt: at(20),
    ...(status === 'kept' ? { keptAt: at(21) } : {}),
  })
  assert.deepEqual(
    loadable([mk('a', 'candidate'), mk('b', 'proposed'), mk('c', 'kept')]).map((l) => l.id),
    ['c'],
  )
})

test('proposedAt round-trips through the file', () => {
  const l: Learning = {
    id: 'x',
    text: 'X',
    scope: 'global',
    status: 'proposed',
    sources: [{ ref: 'pr:a/b#1', day: '2026-10-20' }],
    createdAt: at(20),
    proposedAt: at(21),
  }
  assert.deepEqual(parseLearning('x', serializeLearning(l)).learning, l)
})

test('the card parser refuses anything that is not a new proposal', () => {
  assert.equal(learningProposalOf('not json'), null)
  assert.equal(learningProposalOf('{"status":"proposed","shown":true}'), null)
  assert.equal(learningProposalOf('{"status":"known","shown":false,"learning":{}}'), null)
})

test('the tool runs without a prompt, and the instructions say to propose only from corrections', () => {
  assert.ok(JUNIOR_READ_TOOLS.has('mcp__junior__propose_learning'))
  assert.match(JUNIOR_MCP_INSTRUCTIONS, /propose_learning/)
  assert.match(JUNIOR_MCP_INSTRUCTIONS, /edits, rejections or corrections/)
})
