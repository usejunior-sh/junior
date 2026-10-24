/**
 * Provider capability flags and the check callers run before relying on one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claude } from '../server/providers/claude.js'
import { missingCapabilities, requireCapabilities, requireVeto, vetoRefusal } from '../server/providers/capabilities.js'
import type { Capabilities, Capability, Provider } from '../server/providers/types.js'

const ALL: Capability[] = ['resume', 'interrupt', 'setModel', 'toolApproval', 'inProcessMcp', 'hooks', 'streamDeltas', 'fileCheckpoints']

const fake = (off: Capability[]): Pick<Provider, 'label' | 'capabilities'> => ({
  label: 'Fake',
  capabilities: Object.fromEntries(ALL.map((c) => [c, !off.includes(c)])) as Capabilities,
})

test('claude reports every capability', () => {
  assert.deepEqual(Object.keys(claude.capabilities).sort(), [...ALL].sort())
  for (const c of ALL) assert.equal(claude.capabilities[c], true, c)
  assert.deepEqual(missingCapabilities(claude, ALL), [])
  assert.doesNotThrow(() => requireCapabilities(claude, ALL, 'run a job'))
})

test('a flag set false is reported unsupported', () => {
  const p = fake(['hooks'])
  assert.deepEqual(missingCapabilities(p, ['hooks']), ['hooks'])
  assert.deepEqual(missingCapabilities(p, ALL), ['hooks'])
  assert.deepEqual(missingCapabilities(p, ['resume', 'interrupt']), [])
})

test('several missing come back in the order asked', () => {
  const p = fake(['streamDeltas', 'resume'])
  assert.deepEqual(missingCapabilities(p, ['streamDeltas', 'hooks', 'resume']), ['streamDeltas', 'resume'])
})

test('requireCapabilities names what is missing', () => {
  assert.throws(() => requireCapabilities(fake(['hooks', 'toolApproval']), ['hooks', 'toolApproval', 'resume'], 'run a job'), {
    message: "Fake can't run a job: no hooks, toolApproval",
  })
})

test('claude may run jobs and teams', () => {
  assert.equal(vetoRefusal(claude, 'job'), null)
  assert.equal(vetoRefusal(claude, 'team'), null)
  assert.doesNotThrow(() => requireVeto(claude, 'job'))
  assert.doesNotThrow(() => requireVeto(claude, 'team'))
})

test('a job on a hooks:false adapter is refused', () => {
  assert.throws(() => requireVeto(fake(['hooks']), 'job'), {
    message: "Fake can't run a job: it has no tool-call veto (no hooks), so nothing could fence its tool calls",
  })
})

test('a team on a hooks:false adapter is refused', () => {
  assert.throws(() => requireVeto(fake(['hooks']), 'team'), {
    message: "Fake can't run a team: it has no tool-call veto (no hooks), so nothing could fence its tool calls",
  })
})

test('no tool approval is refused too, and every other gap is not', () => {
  assert.match(vetoRefusal(fake(['toolApproval']), 'team') ?? '', /no toolApproval/)
  assert.match(vetoRefusal(fake(['hooks', 'toolApproval']), 'job') ?? '', /no hooks, toolApproval/)
  assert.equal(vetoRefusal(fake(['resume', 'interrupt', 'setModel', 'inProcessMcp', 'streamDeltas']), 'job'), null)
})

test('a missing hooks key counts as no veto', () => {
  const p = { label: 'Partial', capabilities: { toolApproval: true } as unknown as Capabilities }
  assert.throws(() => requireVeto(p, 'job'), /Partial can't run a job/)
})
