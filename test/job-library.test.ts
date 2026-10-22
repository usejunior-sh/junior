/**
 * A job's `skills:` and `agents:` (server/job-files.ts, core/job/fence.ts):
 * the file keys, the check against what is on this machine, and the fence
 * that lets a run load only the ones it names.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkLibrary, parseJobFile, serializeJobFile, type JobLibrary } from '../server/job-files.js'
import { fenceDecision, fenceFor } from '../core/job/fence.js'
import { builtinGrant } from '../core/job/tools.js'
import { composeRunPrompt } from '../core/job/connectors.js'

const file = (extra: string) => `---
id: j-1
title: Babysit my PRs
schedule: "*/15 9-19 * * 1-5"
project: p-1
tools: [github]
${extra}
---
Fix failing checks on PRs I authored. Never merge.
`

test('skills and agents round-trip through the file, deduped', () => {
  const parsed = parseJobFile('babysit', file('skills: [junior:pr-review, pdf, pdf]\nagents: [junior:code-reviewer]'))
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.spec.skills, ['junior:pr-review', 'pdf'])
  assert.deepEqual(parsed.spec.agents, ['junior:code-reviewer'])
  const again = parseJobFile('babysit', serializeJobFile(parsed.spec))
  assert.deepEqual([again.spec.skills, again.spec.agents], [parsed.spec.skills, parsed.spec.agents])
})

test('a job naming none writes neither key', () => {
  const parsed = parseJobFile('babysit', file(''))
  assert.equal(parsed.spec.skills, undefined)
  const text = serializeJobFile(parsed.spec)
  assert.ok(!/^skills:/m.test(text) && !/^agents:/m.test(text))
})

test('a name that is not one is refused', () => {
  const parsed = parseJobFile('babysit', file('skills: [../etc/passwd]'))
  assert.match(parsed.errors.join('; '), /skills: "\.\.\/etc\/passwd" is not a name/)
})

const lib: JobLibrary = {
  skills: new Map([['junior:pr-review', 'workspace'], ['pdf', 'personal'], ['local-only', 'project']]),
  agents: new Map([['junior:code-reviewer', 'workspace']]),
}

test('names are checked against this machine; a project’s are refused; the library prefix is hinted', () => {
  assert.deepEqual(checkLibrary({ skills: ['junior:pr-review', 'pdf'], agents: ['junior:code-reviewer'] }, lib), [])
  const errors = checkLibrary({ skills: ['pr-review', 'local-only', 'gone'], agents: ['nobody'] }, lib)
  assert.equal(errors.length, 4)
  assert.match(errors[0], /no skill named "pr-review" — the workspace library's is called junior:pr-review/)
  assert.match(errors[1], /"local-only" lives in a project's \.claude folder/)
  assert.match(errors[2], /no skill named "gone"$/)
  assert.match(errors[3], /agents: no agent named "nobody"/)
})

test('the fence lets a run load only the skills and agents it names — exact names', () => {
  const f = fenceFor([builtinGrant('github')], 'items', '/repo', { skills: ['junior:pr-review'], agents: ['junior:code-reviewer'] })
  const ok = (tool: string, input: unknown) => fenceDecision(f, tool, input).allow
  assert.ok(ok('Skill', { skill: 'junior:pr-review' }))
  assert.ok(ok('Skill', { command: '/junior:pr-review' }))
  assert.ok(!ok('Skill', { skill: 'pr-review' }), 'a bare name can be someone else’s skill')
  assert.ok(!ok('Skill', { skill: 'pdf' }))
  assert.ok(ok('Agent', { subagent_type: 'junior:code-reviewer', prompt: 'x', description: 'x' }))
  assert.ok(!ok('Agent', { subagent_type: 'general-purpose', prompt: 'x', description: 'x' }))
  assert.ok(!ok('Task', { prompt: 'x', description: 'x' }))
})

test('a job naming none has no Skill or Agent at all', () => {
  const f = fenceFor([builtinGrant('github')], 'items', '/repo')
  assert.deepEqual(fenceDecision(f, 'Skill', { skill: 'pdf' }), { allow: false, reason: 'this job names no skills' })
  assert.deepEqual(fenceDecision(f, 'Agent', { subagent_type: 'x' }), { allow: false, reason: 'this job names no agents' })
})

test('the run prompt says which skills and agents it has', () => {
  const prompt = composeRunPrompt({
    instruction: 'x',
    tools: [builtinGrant('github')],
    project: { name: 'p', path: '/repo' },
    lookbackMs: 3_600_000,
    nowIso: '2026-10-14T09:00:00Z',
    skills: ['junior:pr-review'],
    agents: ['junior:code-reviewer'],
  })
  assert.match(prompt, /Skill tool.*junior:pr-review\. No others\./)
  assert.match(prompt, /Agent tool.*junior:code-reviewer\. No others/)
})
