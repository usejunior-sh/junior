/**
 * What a babysit task's session is told (core/babysit/brief.ts), and what a
 * Mac notification says (server/tasks/notify.ts needsYouText).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskPrompt, type TaskPr } from '../core/babysit/brief.js'
import type { ItemTask } from '../core/work/tasks.js'
import { needsYouText } from '../server/tasks/notify.js'

const pr: TaskPr = { repo: 'acme/api', number: 12, url: 'https://github.com/acme/api/pull/12', headRef: 'feat/retries', baseRef: 'main' }
const task = (over: Partial<ItemTask>): ItemTask => ({ id: 't1', itemId: 'github:acme/api#12', title: 'Fix lint', owner: 'junior', state: 'running', why: 'event', attempts: 1, createdAt: 0, ...over })

test('a CI fix gets the log, the diff, the push line and how to hand in', () => {
  const p = taskPrompt(task({ step: 'fix-ci', input: { check: 'lint', sha: 'abc1234def', attempt: 2, url: 'https://ci/lint' } }), pr, { plan: 'Keep it green.', decisions: [] }, { log: 'src/a.ts:3 no-unused-vars', diff: '+const x = 1' })
  assert.match(p, /One task this session: \*\*Fix lint\*\*/)
  assert.match(p, /git push origin HEAD:feat\/retries/)
  assert.match(p, /fix 2 of 3/)
  assert.match(p, /src\/a\.ts:3 no-unused-vars/)
  assert.match(p, /\+const x = 1/)
  assert.match(p, /### Plan\nKeep it green\./)
  assert.match(p, /submit_task/)
  assert.doesNotMatch(p, /\n\n\n/)
})

test('a bot thread gets the comment and the reply and resolve commands for its thread', () => {
  const p = taskPrompt(task({ title: 'Fix Bugbot comment on api.ts', step: 'fix-thread', input: { threadId: 'PRRT_1', author: 'cursor[bot]', path: 'src/api.ts', body: 'Unused variable `x`\nRemove it.' } }), pr, undefined)
  assert.match(p, /> Unused variable `x`\n> Remove it\./)
  assert.match(p, /resolveReviewThread[^\n]*-f id=PRRT_1/)
  assert.match(p, /addPullRequestReviewThreadReply[^\n]*-f id=PRRT_1/)
  assert.doesNotMatch(p, /What we know/)
})

test('a rebase pushes with a lease', () => {
  const p = taskPrompt(task({ title: 'Rebase on main', step: 'rebase', input: { why: 'conflict' } }), pr, undefined)
  assert.match(p, /conflicts with main/)
  assert.match(p, /git push --force-with-lease origin HEAD:feat\/retries/)
})

test('notifications say what to act on', () => {
  assert.deepEqual(needsYouText({ kind: 'review', task: task({ title: 'Request anirudha', state: 'waiting', owner: 'you' }) }, 'acme/api#12'), {
    title: 'acme/api#12 is green',
    body: 'Request anirudha? Junior waits for your OK.',
  })
  assert.deepEqual(needsYouText({ kind: 'stuck', task: task({ state: 'failed', error: 'went over its $3 budget' }) }, 'acme/api#12'), {
    title: 'Junior is stuck on acme/api#12',
    body: 'Fix lint: went over its $3 budget',
  })
  assert.equal(needsYouText({ kind: 'budget', spent: 20.4, limit: 20, waiting: 1 }, null)?.body, '$20.40 of $20. 1 task waits for tomorrow or a higher budget.')
})
