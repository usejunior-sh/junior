/**
 * Rules (core/rules): the built-in table, your switches, the match, the
 * tier's bend, and the offer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_RULES, offerFor, ruleFor, ruleLine, rulesConfigFrom, rulesOf, startFor, withRule, type Rule } from '../core/rules/rules.js'

const all = rulesOf(EMPTY_RULES)

test('the built-ins only suggest: a question asked is offered an answer, a bug debug-fix', () => {
  assert.ok(all.filter((r) => r.builtin).every((r) => r.start === 'suggest'))
  assert.equal(ruleFor({ reason: 'asked', label: 'question' }, all)?.playbook, 'answer')
  assert.equal(ruleFor({ reason: 'asked', label: 'question' }, all)?.start, 'suggest')
  assert.equal(ruleFor({ reason: 'found', label: 'bug' }, all)?.playbook, 'debug-fix')
  assert.equal(ruleFor({ reason: 'found', label: 'bug' }, all)?.start, 'suggest')
  assert.equal(ruleFor({ reason: 'assigned', label: 'improvement' }, all)?.playbook, 'investigate')
  assert.equal(ruleFor({ reason: 'mentioned' }, all)?.playbook, null)
  assert.equal(ruleFor({ reason: 'asked' }, all), null)
  assert.equal(ruleFor({ reason: 'found', label: 'idea' }, all), null)
})

test('your on/off sticks; a stored "auto" on a built-in is dropped; the watch rows stay on', () => {
  const cfg = rulesConfigFrom({ builtins: { 'found-bug': { on: false }, 'asked-question': { start: 'auto' }, 'your-pr': { on: false }, nope: { on: false } } })
  assert.deepEqual(cfg.builtins, { 'found-bug': { on: false } })
  const rules = rulesOf(cfg)
  assert.equal(ruleFor({ reason: 'found', label: 'bug' }, rules), null)
  assert.equal(ruleFor({ reason: 'asked', label: 'question' }, rules)?.start, 'suggest')
  assert.equal(rules.find((r) => r.id === 'your-pr')?.on, true)
  assert.equal(rules.find((r) => r.id === 'review-requested')?.on, true)
})

test('yours beat a built-in on the same match; a labelled rule beats a bare one', () => {
  const mine: Rule = { id: 'r1', when: { reason: 'found', label: 'bug' }, playbook: 'debug-fix', start: 'auto', on: true, builtin: false, by: 'junior' }
  const bare: Rule = { id: 'r2', when: { reason: 'found' }, playbook: 'investigate', start: 'suggest', on: true, builtin: false }
  const rules = rulesOf(withRule(withRule(EMPTY_RULES, mine), bare))
  assert.equal(ruleFor({ reason: 'found', label: 'bug' }, rules)?.id, 'r1')
  assert.equal(ruleFor({ reason: 'found', label: 'feature' }, rules)?.id, 'r2')
  // one of yours per reason + label: a second replaces the first
  const again = withRule(withRule(EMPTY_RULES, mine), { ...mine, id: 'r3', start: 'suggest' })
  assert.deepEqual(again.mine.map((r) => r.id), ['r3'])
})

test('stored rules that are not rules are dropped, never repaired', () => {
  const cfg = rulesConfigFrom({
    mine: [
      { id: 'ok', when: { reason: 'asked', label: 'bug' }, playbook: 'debug-fix', start: 'auto' },
      { id: 'bad reason', when: { reason: 'asked' }, playbook: 'answer', start: 'auto' },
      { id: 'x', when: { reason: 'nope' }, playbook: 'answer', start: 'auto' },
      { id: 'y', when: { reason: 'asked' }, playbook: 'babysit', start: 'auto' },
      { id: 'z', when: { reason: 'asked' }, playbook: 'answer', start: 'sometimes' },
    ],
  })
  assert.deepEqual(cfg.mine.map((r) => r.id), ['ok'])
})

test('"only show" turns an auto rule of yours into an offer', () => {
  const r: Rule = { id: 'r9', when: { reason: 'asked', label: 'question' }, playbook: 'answer', start: 'auto', on: true, builtin: false }
  assert.equal(startFor(r, 'start'), 'auto')
  assert.equal(startFor(r, 'show'), 'suggest')
})

test('the offer: the rule\'s playbook until any step of it is on the item', () => {
  assert.deepEqual(offerFor({ reason: 'found', label: 'bug' }, all, []), { playbook: 'debug-fix', ruleId: 'found-bug' })
  assert.deepEqual(offerFor({ reason: 'found', label: 'bug' }, all, ['fix-ci']), { playbook: 'debug-fix', ruleId: 'found-bug' })
  assert.equal(offerFor({ reason: 'found', label: 'bug' }, all, ['debug-plan']), null)
  assert.equal(offerFor({ reason: 'mentioned' }, all, []), null)
  assert.equal(offerFor({ reason: 'your-pr' }, all, []), null)
})

test('a rule reads as one line', () => {
  assert.equal(ruleLine(ruleFor({ reason: 'found', label: 'bug' }, all)!), 'found by a job + bug → debug-fix, offered to you')
  assert.equal(ruleLine(ruleFor({ reason: 'mentioned' }, all)!), 'mentioned → none (FYI)')
})
