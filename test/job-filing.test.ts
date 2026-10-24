/**
 * How a job files (core/job/filing.ts): the file keys, the round trip, the
 * prompt lines, and the row's reason, label and tier as the upsert checks them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJobFile, serializeJobFile } from '../server/job-files.js'
import { filedSource, filingFromJson, filingPrompt, isJobSource } from '../core/job/filing.js'
import { identityFromUrl, rowFiling } from '../server/jobs/scan-mcp.js'

const file = (extra: string) => `---
id: j1
title: Sentry
schedule: "*/30 * * * *"
project: p1
tools: [web]
${extra}
---
New Sentry issues in the api project.
`

test('reason, labels and tiers come from the file and go back the same', () => {
  const { spec, errors } = parseJobFile('slack', file('reason: [asked, mentioned]\nlabels: [bug, question]\nstart_alone: ["DMs to me, and threads I am in where someone asks me something"]\nonly_show: [channel mentions]\nignore: [bot channels]'))
  assert.deepEqual(errors, [])
  assert.deepEqual(spec.filing, {
    reasons: ['asked', 'mentioned'],
    labels: ['bug', 'question'],
    tiers: { start: ['DMs to me, and threads I am in where someone asks me something'], show: ['channel mentions'], ignore: ['bot channels'] },
  })
  const again = parseJobFile('slack', serializeJobFile(spec))
  assert.deepEqual(again.errors, [])
  assert.deepEqual(again.spec.filing, spec.filing)
})

test('no filing keys = no filing; a bad one is an error, not a guess', () => {
  assert.equal(parseJobFile('j', file('')).spec.filing, undefined)
  const bad = parseJobFile('j', file('reason: your-pr\nlabels: [bug, chore]'))
  assert.ok(bad.errors.some((e) => e.includes('reason: "your-pr"')))
  assert.ok(bad.errors.some((e) => e.includes('labels: "chore"')))
  assert.ok(parseJobFile('j', file('reason: found\noutput: digest')).errors.some((e) => e.includes('digest')))
})

test('a single reason: every row carries it; the label must be one the job allows', () => {
  const f = { reasons: ['found' as const], labels: ['bug' as const] }
  assert.deepEqual(rowFiling(f, { label: 'bug' }), { reason: 'found', label: 'bug', tier: 'start' })
  assert.deepEqual(rowFiling(f, { label: 'idea', reason: 'asked' }), { reason: 'found', tier: 'start' })
  assert.deepEqual(rowFiling(undefined, { label: 'question' }), { reason: 'found', label: 'question', tier: 'start' })
})

test('a job with tiers files "show" unless the run says "start"', () => {
  const f = { reasons: ['asked' as const, 'mentioned' as const], labels: [], tiers: { start: ['DMs'], show: [], ignore: [] } }
  assert.deepEqual(rowFiling(f, { reason: 'mentioned', tier: 'start', label: 'bug' }), { reason: 'mentioned', label: 'bug', tier: 'start' })
  assert.deepEqual(rowFiling(f, {}), { reason: 'asked', tier: 'show' })
})

test('the prompt asks for a label always, a reason when there is a choice, a tier when there are tiers', () => {
  const plain = filingPrompt(undefined)
  assert.match(plain, /- label:/)
  assert.doesNotMatch(plain, /- reason:|- tier:/)
  const slack = filingPrompt({ reasons: ['asked', 'mentioned'], labels: ['question', 'bug'], tiers: { start: ['DMs'], show: ['mentions'], ignore: ['#alerts'] } })
  assert.match(slack, /- reason:[\s\S]*asked:[\s\S]*mentioned:/)
  assert.match(slack, /- tier:[\s\S]*start: DMs[\s\S]*show: mentions/)
  assert.match(slack, /Never file anything matching: #alerts/)
  assert.doesNotMatch(slack, /idea:/)
})

test('the seeded Slack job parses clean: asked or mentioned, three tiers, on', async () => {
  const { SLACK_TEMPLATE } = await import('../server/jobs/ops.js')
  const text = serializeJobFile({ id: 'template-slack', project: 'p1', ...SLACK_TEMPLATE })
  const { spec, errors } = parseJobFile('slack', text)
  assert.deepEqual(errors, [])
  assert.equal(spec.enabled, true)
  assert.equal(spec.schedule, '*/15 8-18 * * 1-5')
  assert.deepEqual(spec.filing?.reasons, ['asked', 'mentioned'])
  assert.equal(spec.filing?.tiers?.start.length, 2)
  assert.equal(spec.filing?.tiers?.ignore.length, 2)
})

test('source: a job names where its finds live, and the name goes back the same', () => {
  const { spec, errors } = parseJobFile('pd', file('source: pagerduty'))
  assert.deepEqual(errors, [])
  assert.deepEqual(spec.filing, { reasons: ['found'], labels: [], source: 'pagerduty' })
  assert.match(serializeJobFile(spec), /^source: pagerduty$/m)
  assert.deepEqual(parseJobFile('pd', serializeJobFile(spec)).spec.filing, spec.filing)
  // stored as JSON on the job row and read back
  assert.deepEqual(filingFromJson(JSON.stringify(spec.filing)), spec.filing)
  // it sits beside the other filing keys
  assert.deepEqual(parseJobFile('s', file('source: pager-duty\nlabels: [bug]')).spec.filing, { reasons: ['found'], labels: ['bug'], source: 'pager-duty' })
})

test('source: a bad value is an error that holds the job, never a crash or a guess', () => {
  for (const bad of ['Sentry', 'pager duty', 'pager_duty', '-sentry', 'sentry-', '9lives', 'a'.repeat(41)]) {
    const { spec, errors } = parseJobFile('j', file(`source: "${bad}"`))
    assert.ok(errors.some((e) => e.startsWith('source:') && e.includes('kebab-case')), `${bad}: ${errors.join('; ')}`)
    assert.equal(spec.filing, undefined, bad)
  }
  // Junior's own sources come from the link, not the file
  for (const own of ['github', 'slack', 'linear', 'web', 'job', 'manual']) {
    assert.ok(parseJobFile('j', file(`source: ${own}`)).errors.some((e) => e.includes(`"${own}" is Junior's own`)), own)
  }
  assert.ok(parseJobFile('j', file('source: [sentry, pagerduty]')).errors.some((e) => e.includes('source must be one name')))
  assert.ok(parseJobFile('j', file('source: sentry\noutput: digest')).errors.some((e) => e.includes('source') && e.includes('digest')))
  // a hand-edited row that lost its way reads as no source
  assert.equal(filingFromJson(JSON.stringify({ reasons: ['found'], labels: [], source: 'Not OK' }))?.source, undefined)
  assert.equal(isJobSource('sentry'), true)
  assert.equal(isJobSource('github'), false)
})

test('source: links no source owns file under the job\'s; GitHub, Slack and Linear keep theirs', () => {
  const pd = { reasons: ['found' as const], labels: [], source: 'pagerduty' }
  const web = identityFromUrl('https://acme.pagerduty.com/incidents/Q1ABC')!
  assert.equal(web.source, 'web')
  assert.equal(filedSource(pd, web.source), 'pagerduty')
  assert.equal(filedSource(pd, identityFromUrl('https://github.com/acme/api/pull/12')!.source), 'github')
  assert.equal(filedSource(pd, identityFromUrl('NOV-140')!.source), 'linear')
  assert.equal(filedSource(pd, 'slack'), 'slack')
})

test('source: without the key, filing is exactly as before', () => {
  assert.equal(parseJobFile('j', file('')).spec.filing, undefined)
  assert.doesNotMatch(serializeJobFile(parseJobFile('j', file('')).spec), /^source:/m)
  assert.equal(filedSource(undefined, 'web'), 'web')
  assert.equal(filedSource({ reasons: ['asked'], labels: [] }, 'web'), 'web')
  assert.equal(filedSource(undefined, 'github'), 'github')
  assert.equal(filingFromJson(JSON.stringify({ reasons: ['asked'], labels: ['bug'] }))?.source, undefined)
})
