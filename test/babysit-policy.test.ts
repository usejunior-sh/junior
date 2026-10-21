/**
 * What a babysit task may send alone (core/babysit/policy.ts), sorted by the
 * default actions file: pushes to the PR's branch and the bot thread's reply
 * and resolve run; force, other branches and implicit pushes are refused;
 * every other send is held.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortCall } from '../core/actions/sort.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { taskRunVerdict } from '../core/babysit/policy.js'

const sort = (part: string) => sortCall('Bash', { command: part }, { rules: DEFAULT_RULES })
const scope = { headRef: 'feat/retries', defaultBranch: 'main', threadId: 'PRRT_kwDOabc' }
const v = (cmd: string) => taskRunVerdict(cmd, scope, sort).verdict

test('pushes to the PR branch run, with a lease too', () => {
  assert.equal(v('git push origin HEAD:feat/retries'), 'allow')
  assert.equal(v('git add -A && git commit -m "fix lint" && git push origin HEAD:feat/retries'), 'allow')
  assert.equal(v('git push --force-with-lease origin HEAD:feat/retries'), 'allow')
  assert.equal(v('git push --dry-run origin HEAD:main'), 'allow', 'a dry run sends nothing')
})

test('force, other branches, the default branch and implicit pushes are refused', () => {
  assert.equal(v('git push --force origin HEAD:feat/retries'), 'refuse')
  assert.equal(v('git push -f origin HEAD:feat/retries'), 'refuse')
  assert.equal(v('git push origin +HEAD:feat/retries'), 'refuse')
  assert.equal(v('git push origin HEAD:main'), 'refuse')
  assert.equal(v('git push origin HEAD:feat/other'), 'refuse')
  assert.equal(v('git push'), 'refuse')
  assert.equal(v('git push origin --delete feat/retries'), 'refuse')
  const r = taskRunVerdict('git push', scope, sort)
  assert.ok(r.verdict === 'refuse' && r.reason.includes('git push origin HEAD:feat/retries'))
})

test('the bot thread’s reply and resolve run; anything else on GitHub is held', () => {
  const resolve = `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=PRRT_kwDOabc`
  const reply = `gh api graphql -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}' -f id=PRRT_kwDOabc -f body='Fixed in abc123'`
  assert.equal(v(resolve), 'allow')
  assert.equal(v(reply), 'allow')
  assert.equal(v(`${reply} && ${resolve}`), 'allow')
  assert.equal(v(resolve.replace('PRRT_kwDOabc', 'PRRT_other')), 'hold', 'another thread')
  assert.equal(taskRunVerdict(resolve, { ...scope, threadId: null }, sort).verdict, 'hold', 'not a thread task')
  assert.equal(v('gh pr comment 12 --body "done"'), 'hold')
  assert.equal(v('gh pr edit 12 --add-reviewer anirudha'), 'hold')
  assert.equal(v('gh pr merge 12 --squash'), 'hold')
  assert.equal(v('git push origin HEAD:feat/retries && gh pr comment 12 --body hi'), 'hold')
})

test('local work is not an action', () => {
  assert.equal(v('npm run lint -- --fix && git commit -am "lint"'), 'allow')
  assert.equal(v('gh pr diff 12'), 'allow')
})
