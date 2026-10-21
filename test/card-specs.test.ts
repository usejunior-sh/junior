/**
 * The workspace's card spec files (server/card-specs.ts): a file wins over the
 * built-in for its tool, a broken file is left out with its error, and a file
 * added later applies without a restart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CardSpecs } from '../server/card-specs.js'
import { planCard } from '../core/cards/spec.js'

const SLACK = 'mcp__claude_ai_Slack__slack_send_message'

test('no cards folder: the built-ins, no errors', () => {
  const cs = new CardSpecs(mkdtempSync(path.join(os.tmpdir(), 'cards-')))
  const { specs, errors } = cs.current()
  assert.deepEqual(errors, [])
  assert.ok(specs.length > 0)
  assert.ok(specs.every((s) => s.source === 'builtin'))
})

test('a file wins for its tool; a broken one is listed, never thrown', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cards-'))
  mkdirSync(path.join(root, 'cards'))
  writeFileSync(path.join(root, 'cards', 'my-slack.json'), JSON.stringify({ tool: 'mcp__*__slack_send_message', layout: 'generic', verb: 'Post' }))
  writeFileSync(path.join(root, 'cards', 'broken.json'), '{ "tool": ')
  writeFileSync(path.join(root, 'cards', 'typo.json'), JSON.stringify({ tool: 'x', layout: 'ticket', bdy: 'a' }))
  writeFileSync(path.join(root, 'cards', 'notes.md'), 'not a spec')
  const { specs, errors } = new CardSpecs(root).current()
  assert.equal(specs[0].id, 'my-slack')
  assert.equal(specs[0].source, 'workspace')
  assert.equal(errors.length, 2)
  assert.match(errors.join('\n'), /broken: not valid JSON/)
  assert.match(errors.join('\n'), /typo: unknown key "bdy"/)
  const plan = planCard(SLACK, { channel_id: 'C1', message: 'hi' }, specs)
  assert.equal(plan.spec, 'my-slack')
  assert.equal(plan.verb, 'Post')
})

test('a file added later applies on the next look', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cards-'))
  const cs = new CardSpecs(root)
  assert.equal(planCard('mcp__pagerduty__create_incident', { title: 't' }, cs.current().specs).spec, null)
  mkdirSync(path.join(root, 'cards'))
  writeFileSync(path.join(root, 'cards', 'pagerduty.create_incident.json'), JSON.stringify({ tool: 'mcp__pagerduty__create_incident', layout: 'ticket', subject: 'title' }))
  ;(cs as unknown as { checkedAt: number }).checkedAt = 0
  const plan = planCard('mcp__pagerduty__create_incident', { title: 't' }, cs.current().specs)
  assert.equal(plan.spec, 'pagerduty.create_incident')
  assert.equal(plan.layout, 'ticket')
})
