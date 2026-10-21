/**
 * First passes on any item (core/playbooks): the approved Slack send passes
 * only byte for byte, the thread is read off the permalink, the fix may open
 * a draft PR from its own branch and nothing else, read-only steps send nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortCall } from '../core/actions/sort.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { taskRunVerdict } from '../core/babysit/policy.js'
import { fixBranch, slackThreadOf } from '../core/playbooks/item.js'
import { isApprovedSend, sentLink, SLACK_SEND_TOOL } from '../core/playbooks/send.js'

const sort = (part: string) => sortCall('Bash', { command: part }, { rules: DEFAULT_RULES })
const want = { channel: 'C123', threadTs: '1729500000.123456', message: 'Use `--force-with-lease`.' }

test('only the approved send passes, exactly as approved', () => {
  const ok = { channel_id: 'C123', thread_ts: '1729500000.123456', message: 'Use `--force-with-lease`.' }
  assert.deepEqual(isApprovedSend(SLACK_SEND_TOOL, ok, want), { ok: true })
  assert.equal(isApprovedSend(SLACK_SEND_TOOL, { ...ok, message: 'Use `--force-with-lease`. ' }, want).ok, false)
  assert.equal(isApprovedSend(SLACK_SEND_TOOL, { ...ok, channel_id: 'C999' }, want).ok, false)
  assert.equal(isApprovedSend(SLACK_SEND_TOOL, { ...ok, thread_ts: undefined }, want).ok, false)
  assert.equal(isApprovedSend(SLACK_SEND_TOOL, { ...ok, reply_broadcast: true }, want).ok, false)
  assert.equal(isApprovedSend('mcp__claude_ai_Slack__slack_schedule_message', ok, want).ok, false)
})

test('the thread comes off the permalink: a reply\'s thread_ts wins over its own ts', () => {
  assert.deepEqual(slackThreadOf('https://acme.slack.com/archives/C0ABC/p1729500000123456'), { channel: 'C0ABC', threadTs: '1729500000.123456' })
  assert.deepEqual(slackThreadOf('https://acme.slack.com/archives/C0ABC/p1729500999000001?thread_ts=1729500000.123456&cid=C0ABC'), { channel: 'C0ABC', threadTs: '1729500000.123456' })
  assert.equal(slackThreadOf('https://linear.app/acme/issue/PX-1'), null)
  assert.equal(sentLink('Sent: https://acme.slack.com/archives/C0ABC/p1729501000000001.'), 'https://acme.slack.com/archives/C0ABC/p1729501000000001')
})

test('the fix branch is Junior\'s own and stable per item', () => {
  const b = fixBranch({ id: 'slack:C0ABC/p1729500000123456', title: 'Login 500s after deploy!' })
  assert.match(b, /^fix\/login-500s-after-deploy-[a-z0-9]{6}$/)
  assert.equal(fixBranch({ id: 'slack:C0ABC/p1729500000123456', title: 'Login 500s after deploy!' }), b)
})

test('a fix pushes its own branch and opens a draft PR; a ready PR or main is not its call', () => {
  const s = { headRef: 'fix/login-abc123', defaultBranch: 'main', draftPr: true }
  assert.equal(taskRunVerdict('git push -u origin HEAD:fix/login-abc123', s, sort).verdict, 'allow')
  assert.equal(taskRunVerdict('gh pr create --draft --base main --head fix/login-abc123 --title x --body y', s, sort).verdict, 'allow')
  assert.equal(taskRunVerdict('gh pr create --base main --head fix/login-abc123 --title x --body y', s, sort).verdict, 'hold')
  assert.equal(taskRunVerdict('git push origin HEAD:main', s, sort).verdict, 'refuse')
  // without draftPr (babysit), a draft PR is still held
  assert.equal(taskRunVerdict('gh pr create --draft --title x --body y', { headRef: 'feat', defaultBranch: 'main' }, sort).verdict, 'hold')
})

test('a read-only step sends nothing, not even a draft', () => {
  const s = { headRef: '', defaultBranch: 'main', readOnly: true }
  assert.equal(taskRunVerdict('gh pr create --draft --title x', s, sort).verdict, 'refuse')
  assert.equal(taskRunVerdict('git log -5', s, sort).verdict, 'allow')
})
