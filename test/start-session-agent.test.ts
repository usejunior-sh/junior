import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatAgent } from '../core/junior/agents.js'
import { resolveAgent } from '../server/session/spawn-ops.js'

const agent = (slug: string, label: string): ChatAgent => ({
  name: `junior:${slug}`,
  slug,
  label,
  description: '',
  colour: null,
  ask: null,
  starters: null,
  model: null,
  tools: null,
  skills: null,
  sends: null,
  prompt: '',
  path: `/x/${slug}.md`,
  scope: 'Workspace',
})
const agents = [agent('reviewer', 'Reviewer'), agent('babysitter', 'Babysitter')]

test('a thread finds its agent by label, file stem or full name, any case', () => {
  assert.equal(resolveAgent(agents, 'Reviewer')?.name, 'junior:reviewer')
  assert.equal(resolveAgent(agents, 'babysitter')?.name, 'junior:babysitter')
  assert.equal(resolveAgent(agents, ' JUNIOR:REVIEWER ')?.name, 'junior:reviewer')
})

test('no agent asked is plain Junior; an unknown one names the known ones', () => {
  assert.equal(resolveAgent(agents, undefined), null)
  assert.equal(resolveAgent(agents, '  '), null)
  assert.throws(() => resolveAgent(agents, 'Writer'), /no agent is called "Writer"; known agents: Reviewer, Babysitter/)
  assert.throws(() => resolveAgent([], 'Writer'), /no chat agents/)
})
