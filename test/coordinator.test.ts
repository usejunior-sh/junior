import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentLines, coordinatorAppend } from '../core/junior/coordinator.js'
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
  assert.match(text, /When no agent fits the task, do it yourself/)
  assert.doesNotMatch(text, /## Pinned notes/)
})

test("the persona's name is the one used", () => {
  assert.match(coordinatorAppend({ juniorName: 'Robin', agents, pins: [] }), /"Context from Robin:"/)
})

test('active pins ride along', () => {
  const { pins } = addPin([], { text: 'Onboarding belongs to another team', scope: 'always' }, Date.now())
  const text = coordinatorAppend({ juniorName: 'Junior', agents, pins })
  assert.match(text, /## Pinned notes\n.*\n- Onboarding belongs to another team \(standing; p-/)
})

test('no agents yet: Junior does the work itself', () => {
  assert.match(agentLines([]), /do the work yourself/)
})
