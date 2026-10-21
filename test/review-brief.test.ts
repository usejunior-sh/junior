/**
 * A first-pass review on paper (core/review/brief.ts): the line the task
 * shows, the Review artifact, and the session's first message.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVerdict, passLine, passMarkdown, reviewPrompt, REVIEW_DIFF_CHARS, type FirstPass } from '../core/review/brief.js'
import type { ItemTask } from '../core/work/tasks.js'

const pass: FirstPass = {
  verdict: 'request_changes',
  summary: 'Caches the auth token per user.\nThe cache never expires, so a revoked token keeps working.',
  comments: [
    { path: 'src/auth/cache.ts', line: 42, body: 'This map never evicts. Use the token expiry as the TTL.' },
    { path: 'src/auth/cache.ts', line: 10, side: 'LEFT', body: 'The old check is gone; was that on purpose?' },
  ],
  sha: 'aaa1111bbbb',
}
const pr = { repo: 'acme/api', number: 40, url: 'https://github.com/acme/api/pull/40', title: 'Cache the token', author: 'drew' }

test('the line: verdict, comment count, the summary’s first line', () => {
  assert.equal(passLine(pass), 'Request changes · 2 comments · Caches the auth token per user.')
  assert.equal(passLine({ verdict: 'approve', summary: 'Small, safe rename.', comments: [] }), 'Approve · Small, safe rename.')
  assert.equal(passLine({ ...pass, comments: [pass.comments[0]!] }).includes('1 comment ·'), true)
})

test('the artifact names the PR, the head, the verdict and each comment’s place', () => {
  const md = passMarkdown(pr, { ...pass, skipped: 'Generated files under gen/.' })
  assert.match(md, /^# Review: acme\/api#40/)
  assert.match(md, /reviewed at `aaa1111`/)
  assert.match(md, /\*\*Verdict:\*\* Request changes/)
  assert.match(md, /### `src\/auth\/cache.ts:42`\n\nThis map never evicts/)
  assert.match(md, /### `src\/auth\/cache.ts:10` \(old side\)/)
  assert.match(md, /## Not read\n\nGenerated files/)
  assert.match(md, /Nothing is posted until you OK it/)
})

test('verdicts', () => {
  assert.equal(isVerdict('approve'), true)
  assert.equal(isVerdict('merge'), false)
})

const task = { id: 't1', itemId: 'github:acme/api#40', title: 'Review first pass', owner: 'junior', state: 'running', why: 'playbook', step: 'review', input: { requestedBy: 'drew' }, attempts: 1, createdAt: 0 } as ItemTask
const where = { repo: 'acme/api', number: 40, url: pr.url, headRef: 'drew/cache', baseRef: 'main' }

test('the prompt: who asked, read-only, the PR, the diff, and submit_review', () => {
  const p = reviewPrompt(task, where, undefined, { title: 'Cache the token', body: 'Fixes #12', author: 'drew', diff: 'diff --git a/x b/x\n+1', files: '- src/x.ts (+1 −0)' })
  assert.match(p, /first-pass review of acme\/api#40/)
  assert.match(p, /who drew asked to review it/)
  assert.match(p, /Read-only/)
  assert.match(p, /Fixes #12/)
  assert.match(p, /- src\/x.ts \(\+1 −0\)/)
  assert.match(p, /```diff\ndiff --git a\/x b\/x\n\+1\n```/)
  assert.match(p, /Call `submit_review` once/)
  assert.doesNotMatch(p, /submit_task/)
  assert.doesNotMatch(p, /\n\n\n/)
})

test('a big diff is cut, and the pass is told to say what it skipped', () => {
  const p = reviewPrompt(task, where, { decisions: [{ at: 0, by: 'you', text: 'Drew owns auth.' }] }, { title: 't', body: '', author: 'drew', diff: 'x'.repeat(REVIEW_DIFF_CHARS + 10) })
  assert.match(p, /rest cut: run `gh pr diff 40 -R acme\/api`/)
  assert.match(p, /say in `skipped` what you did not read/)
  assert.match(p, /Drew owns auth\./)
  assert.match(p, /\(no description\)/)
})
