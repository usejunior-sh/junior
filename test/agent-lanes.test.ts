/**
 * Send lanes for chat agents (core/junior/agents.ts): `sends:` names what an
 * agent may propose on its own; anything else it sends only when the user
 * asks, and every send still waits on a card. An agent without Bash keeps a
 * shell for sends only (core/actions/policy.ts sendOnlyShell). Untouched
 * starters follow the upgrade to lanes; edited ones are kept.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { agentAppend, agentDisallowed, agentSends, chatAgentFrom, sendsAppend, shellSendOnly } from '../core/junior/agents.js'
import { sendOnlyShell } from '../core/actions/policy.js'
import { sortCall } from '../core/actions/sort.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { seedChatAgents } from '../server/chat-agents.js'

const at = (slug: string) => ({ name: `junior:${slug}`, slug, path: `/x/${slug}.md`, scope: 'Workspace' })
const agent = (slug: string, front = '') => chatAgentFrom(`---\nname: ${slug}\nchat: true\n${front}---\nbody\n`, at(slug))!

test('a lane is the file’s sends, else its starter’s, else none', () => {
  assert.deepEqual(agent('reviewer', 'sends: github-review, Slack-Post, github-review\n').sends, ['github-review', 'slack-post'])
  assert.deepEqual(agent('reviewer', 'sends: none\n').sends, [])
  assert.deepEqual(agentSends(agent('reviewer', 'sends: none\n')), [])
  assert.deepEqual(agentSends(agent('reviewer')), ['github-review', 'github-comment'])
  assert.deepEqual(agentSends(agent('babysitter')), ['push', 'github-reply'])
  assert.deepEqual(agentSends(agent('writer')), ['slack-reply', 'slack-post', 'github-comment'])
  for (const n of ['debugger', 'explainer', 'cpo']) assert.deepEqual(agentSends(agent(n)), [], n)
  // a connector's own kind reads as written
  assert.deepEqual(agentSends(agent('oncall', 'sends: pagerduty-ack\n')), ['pagerduty-ack'])
})

test('merge is in no starter’s lane', () => {
  for (const n of ['babysitter', 'debugger', 'explainer', 'reviewer', 'writer']) assert.ok(!agentSends(agent(n)).includes('merge'), n)
})

test('the prompt: in-lane sends on its own, anything the user asks is made and waits on a card', () => {
  const p = agentAppend(agent('reviewer'), 'Junior')
  assert.match(p, /In your lane: a GitHub review, a GitHub comment\./)
  assert.match(p, /only when the user asks for it in this chat\. Never unprompted\./)
  assert.match(p, /make the call yourself/)
  assert.match(p, /Don't refuse it/)
  assert.match(p, /waits on a card for the user's OK, word for word/)
  assert.match(p, /in the user's voice/)
  // the rules come after the agent's own prompt, so its old "never post" line can't win
  assert.ok(p.indexOf('body') < p.indexOf('### Sends'))
  assert.match(sendsAppend(agent('debugger'), 'Junior'), /Nothing is in your lane: never propose a send on your own\./)
})

test('an agent without Bash keeps a shell, for sends only', () => {
  const writer = agent('writer', 'tools: Read, Grep, Glob\n')
  assert.ok(!agentDisallowed(writer).includes('Bash'))
  assert.ok(agentDisallowed(writer).includes('Edit'))
  assert.equal(shellSendOnly(writer), true)
  assert.equal(shellSendOnly(agent('reviewer', 'tools: Read, Bash\n')), false)
  assert.equal(shellSendOnly(agent('babysitter')), false)
  assert.equal(shellSendOnly(null), false)
  assert.match(agentAppend(writer, 'Junior'), /except a shell that runs sends only/)
})

test('a send-only shell runs sends and nothing else', () => {
  const sort = (part: string) => sortCall('Bash', { command: part }, { rules: DEFAULT_RULES })
  const ok = (cmd: string) => sendOnlyShell(cmd, sort)
  assert.equal(ok('gh pr comment 12 --body "looks good"'), true)
  assert.equal(ok('gh pr merge 12 --squash'), true)
  assert.equal(ok('git push origin feat/x'), true)
  assert.equal(ok('cd /repo && gh pr comment 12 --body hi'), true)
  assert.equal(ok('ls'), false)
  assert.equal(ok('rm -rf src'), false)
  assert.equal(ok('echo hi > a.txt && gh pr comment 12 --body hi'), false)
  assert.equal(ok('$G pr comment 12'), false)
  assert.equal(ok('bash -c "gh pr comment 12"'), false)
  assert.equal(ok(''), false)
})

test('an untouched starter follows the upgrade to lanes; an edited one is kept', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'junior-lanes-'))
  try {
    const agents = path.join(dir, 'agents')
    await mkdir(agents, { recursive: true })
    const oldReviewer = `---
name: reviewer
label: Reviewer
description: First pass on a diff or PR. Real bugs only, ranked by severity.
color: red
chat: true
tools: Read, Grep, Glob, Bash
---

Review for real defects: wrong behaviour, crashes, data loss, security.
Rank findings most severe first. Each one gets file:line, what breaks, and the fix.
Say how sure you are when you are not.
Nits go in one line at the end, or not at all.
Draft review comments for the user to approve. Never post them yourself.
`
    await writeFile(path.join(agents, 'reviewer.md'), oldReviewer)
    await writeFile(path.join(agents, 'writer.md'), '---\nname: writer\nchat: true\n---\nmine\n')
    await writeFile(path.join(agents, '.seeded-chat.json'), JSON.stringify(['babysitter', 'debugger', 'explainer', 'reviewer', 'writer']))
    await seedChatAgents(dir)
    const reviewer = await readFile(path.join(agents, 'reviewer.md'), 'utf8')
    assert.match(reviewer, /sends: github-review, github-comment/)
    assert.doesNotMatch(reviewer, /Never post/)
    assert.match(await readFile(path.join(agents, 'writer.md'), 'utf8'), /mine/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
