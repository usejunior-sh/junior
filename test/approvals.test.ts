/**
 * Advance approvals (core/approvals/approvals.ts): who + what + when, matched
 * on the tool and the recipient, never the text; revoked or expired covers nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type AdvanceApproval, allowedDetailFor, approvalFrom, approvalIdIn, callTarget, describeApproval, matchApproval, reviewerOf } from '../core/approvals/approvals.js'

const SLACK = 'mcp__claude_ai_Slack__slack_send_message'
const make = (raw: unknown, id = 'a1b2c3d4-0000', now = 1000): AdvanceApproval => {
  const r = approvalFrom(raw, { id, now, sessionId: 's1', proposalId: null })
  assert.ok(r.ok, r.ok ? '' : r.error)
  return r.approval
}
const dmAni = make({ what: 'slack-dm', who: { id: 'U04ANI', name: 'Anirudha' }, why: 'PR-ready pings' })

test('a DM to the approved person matches, whatever the text', () => {
  assert.equal(matchApproval([dmAni], SLACK, { channel_id: 'U04ANI', message: 'The PR is ready: https://github.com/a/b/pull/1' }, {}, 2000)?.id, dmAni.id)
  assert.equal(matchApproval([dmAni], SLACK, { channel_id: 'U04ANI', message: 'anything at all' }, {}, 2000)?.id, dmAni.id)
})

test('anyone else, a channel, another tool: no match', () => {
  assert.equal(matchApproval([dmAni], SLACK, { channel_id: 'U09DREW', message: 'hi' }, {}, 2000), null)
  assert.equal(matchApproval([dmAni], SLACK, { channel_id: 'C01ENG', message: 'hi' }, {}, 2000), null)
  assert.equal(matchApproval([dmAni], 'mcp__claude_ai_Slack__slack_schedule_message', { channel_id: 'U04ANI', message: 'hi' }, {}, 2000), null)
  assert.equal(matchApproval([dmAni], 'mcp__linear__save_comment', { channel_id: 'U04ANI' }, {}, 2000), null)
})

test('revoked or expired covers nothing', () => {
  assert.equal(matchApproval([{ ...dmAni, revokedAt: 1500 }], SLACK, { channel_id: 'U04ANI', message: 'x' }, {}, 2000), null)
  assert.equal(matchApproval([{ ...dmAni, expiresAt: 1800 }], SLACK, { channel_id: 'U04ANI', message: 'x' }, {}, 2000), null)
  assert.ok(matchApproval([{ ...dmAni, expiresAt: 3000 }], SLACK, { channel_id: 'U04ANI', message: 'x' }, {}, 2000))
})

test('a channel post needs a channel approval', () => {
  const eng = make({ what: 'slack-post', who: { id: 'C01ENG', name: '#eng' } }, 'b0000000-1')
  assert.equal(matchApproval([dmAni, eng], SLACK, { channel_id: 'C01ENG', message: 'deploy done' }, {}, 2000)?.id, eng.id)
})

test('a review request: the lone add-reviewer edit, login case-insensitive', () => {
  const rv = make({ what: 'request-review', who: { id: 'Anirudha-K', name: 'anirudha-k' } }, 'c0000000-1')
  const hit = (cmd: string) => matchApproval([rv], 'Bash', { command: cmd }, {}, 2000)?.id ?? null
  assert.equal(hit('gh pr edit 42 --add-reviewer anirudha-k'), rv.id)
  assert.equal(hit('gh pr edit 42 -R acme/app --add-reviewer=anirudha-k'), rv.id)
  assert.equal(hit('gh pr edit https://github.com/acme/app/pull/42 --add-reviewer anirudha-k'), rv.id)
  assert.equal(hit('gh pr edit 42 --add-reviewer anirudha-k,drew'), null, 'a second reviewer')
  assert.equal(hit('gh pr edit 42 --add-reviewer anirudha-k --title x'), null, 'another edit rides along')
  assert.equal(hit('gh pr edit 42 --add-reviewer anirudha-k && gh pr merge 42'), null, 'another send rides along')
  assert.equal(hit('gh pr edit 42 --add-reviewer drew'), null)
})

test('a playbook approval covers only that step', () => {
  const rv = make({ what: 'request-review', who: { id: 'anirudha-k', name: 'anirudha-k' }, when: { kind: 'playbook', playbook: 'babysit', step: 'request reviewer' } })
  const cmd = { command: 'gh pr edit 42 --add-reviewer anirudha-k' }
  assert.equal(matchApproval([rv], 'Bash', cmd, {}, 2000), null, 'not in a chat')
  assert.ok(matchApproval([rv], 'Bash', cmd, { playbook: { playbook: 'babysit', step: 'request reviewer' } }, 2000))
  assert.equal(matchApproval([rv], 'Bash', cmd, { playbook: { playbook: 'babysit', step: 'fix' } }, 2000), null)
})

test('the oldest live approval wins', () => {
  const later = { ...dmAni, id: 'ffffff00', createdAt: 5000 }
  assert.equal(matchApproval([later, dmAni], SLACK, { channel_id: 'U04ANI', message: 'x' }, {}, 6000)?.id, dmAni.id)
})

test('approvalFrom refuses what it can’t match safely', () => {
  const bad = (raw: unknown) => {
    const r = approvalFrom(raw, { id: 'x', now: 1000, sessionId: null, proposalId: null })
    return r.ok ? null : r.error
  }
  assert.match(bad({ what: 'slack-dm', who: { id: 'Anirudha', name: 'Anirudha' } })!, /isn't a Slack user id/)
  assert.match(bad({ what: 'slack-dm', who: { id: 'U04ANI', name: '' } })!, /name/)
  assert.match(bad({ what: 'merge', who: { id: 'x', name: 'x' } })!, /what must be/)
  assert.match(bad({ what: 'slack-dm', who: { id: 'U04ANI', name: 'A' }, expiresAt: 500 })!, /future/)
  assert.match(bad({ what: 'slack-dm', who: { id: 'U04ANI', name: 'A' }, when: { kind: 'playbook', playbook: 'babysit' } })!, /step/)
})

test('lines: description, allowed-by detail, and back to the id', () => {
  assert.equal(describeApproval(dmAni), 'DM Anirudha on Slack')
  assert.equal(allowedDetailFor(dmAni), 'DM Anirudha on Slack (#a1b2c3)')
  assert.equal(approvalIdIn(allowedDetailFor(dmAni)), 'a1b2c3')
  assert.equal(approvalIdIn('free: a draft PR'), null)
})

test('callTarget and reviewerOf', () => {
  assert.deepEqual(callTarget(SLACK, { channel_id: 'U04ANI' }), { what: 'slack-dm', id: 'U04ANI' })
  assert.equal(callTarget(SLACK, { channel_id: 'D04X' }), null, 'a DM channel id is not a person: Junior DMs by user id')
  assert.equal(reviewerOf('gh pr edit 1 --add-reviewer acme/team'), null, 'a team is not covered')
})

test('the store keeps approvals, revoked ones too, and counts uses', async () => {
  const { openSqliteStore } = await import('../core/store/sqlite.js')
  const store = openSqliteStore(':memory:')
  const a = make({ what: 'slack-dm', who: { id: 'U04ANI', name: 'Anirudha' } }, 'a1b2c3d4-1')
  await store.approvals.put({ ...a, proposalId: 'toolu_1' })
  await store.approvals.put(make({ what: 'request-review', who: { id: 'drew', name: 'drew' }, when: { kind: 'playbook', playbook: 'babysit', step: 'request reviewer' } }, 'b-2', 2000))
  const all = await store.approvals.list()
  assert.deepEqual(all.map((x) => x.id), ['b-2', 'a1b2c3d4-1'])
  assert.deepEqual(all[0]!.when, { kind: 'playbook', playbook: 'babysit', step: 'request reviewer' })
  assert.equal((await store.approvals.byProposal('toolu_1'))?.id, a.id)
  await store.approvals.used(a.id, 3000)
  await store.approvals.used(a.id, 4000)
  assert.equal((await store.approvals.get(a.id))?.uses, 2)
  assert.equal((await store.approvals.get(a.id))?.lastUsedAt, 4000)
  assert.equal(await store.approvals.revoke(a.id, 5000), true)
  assert.equal(await store.approvals.revoke(a.id, 6000), false, 'once')
  assert.equal((await store.approvals.get(a.id))?.revokedAt, 5000)
  assert.equal((await store.approvals.list()).length, 2, 'revoked stays')
  await store.close()
})
