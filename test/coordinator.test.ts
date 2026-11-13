import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentLines, COORDINATOR_DISALLOWED, coordinatorAppend, threadAppend } from '../core/junior/coordinator.js'
import { addPin } from '../core/junior/pins.js'

const agents = [
  { name: 'junior:reviewer', label: 'Reviewer', description: 'First pass on a diff or PR.' },
  { name: 'junior:babysitter', label: 'Babysitter', description: 'Watches your PRs.' },
]

test('the coordinator block lists the agents and the rules', () => {
  const text = coordinatorAppend({ juniorName: 'Junior', agents, pins: [] })
  assert.match(text, /## You run the user's team/)
  assert.match(text, /- Reviewer: First pass on a diff or PR\. \(agent: "Reviewer"\)/)
  assert.match(text, /- Babysitter: Watches your PRs\./)
  assert.match(text, /start_session with `agent`/)
  assert.match(text, /the user's exact words, in quotes/)
  assert.match(text, /"Context from Junior:"/)
  assert.match(text, /Reading it back: <the task>\. <what waits for the user>\. I gave it to <Agent>\./)
  assert.match(text, /Added to the <title> thread\./)
  assert.match(text, /call pin_note/)
  assert.match(text, /When no agent fits, start the thread without `agent`/)
  assert.match(text, /"Pointers:"/)
  assert.match(text, /"Done when:"/)
  assert.match(text, /read_work_log/)
  assert.doesNotMatch(text, /do it yourself/)
  assert.doesNotMatch(text, /## Pinned notes/)
})

test("Junior's chat can't edit or run commands; reads stay", () => {
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'Agent']) assert.ok(COORDINATOR_DISALLOWED.includes(t), t)
  for (const t of ['Read', 'Grep', 'Glob']) assert.ok(!COORDINATOR_DISALLOWED.includes(t), t)
})

test('a thread leads each reply with a sentence that stands alone', () => {
  const text = threadAppend('Robin')
  assert.match(text, /## You are a thread/)
  assert.match(text, /Robin started this chat/)
  assert.match(text, /start the reply with one plain sentence that says the outcome/)
})

test("the persona's name is the one used", () => {
  assert.match(coordinatorAppend({ juniorName: 'Robin', agents, pins: [] }), /"Context from Robin:"/)
})

test('active pins ride along', () => {
  const { pins } = addPin([], { text: 'Onboarding belongs to another team', scope: 'always' }, Date.now())
  const text = coordinatorAppend({ juniorName: 'Junior', agents, pins })
  assert.match(text, /## Pinned notes\n.*\n- Onboarding belongs to another team \(standing; p-/)
})

test('no agents yet: threads run as plain Junior', () => {
  assert.match(agentLines([]), /start each thread as plain you, without `agent`/)
})
