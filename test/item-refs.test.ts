/**
 * The shared ref formatter, playbook pick and source glyph every Junior page
 * reads (web/src/itemRef.ts, re-exported by refs.ts and drawn by itemUi.tsx). Known sources keep their output
 * byte for byte; a source Junior doesn't know by name shows its label and the
 * connector glyph.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { glyphOf, playbookOf, refOf } from '../web/src/itemRef.js'

test('refOf: a GitHub PR reads repo#n', () => {
  assert.equal(refOf({ id: 'github:acme/web#3312', source: 'github', repo: 'acme/web' }), 'acme/web#3312')
})

test('refOf: known sources keep their home as is', () => {
  assert.equal(refOf({ id: 'github:acme/web', source: 'github', repo: 'acme/web' }), 'acme/web')
  assert.equal(refOf({ id: 'slack:C1/123.4', source: 'slack', repo: '#api' }), '#api')
  assert.equal(refOf({ id: 'linear:NOV-140', source: 'linear', repo: 'NOV' }), 'NOV')
  assert.equal(refOf({ id: 'web:x.com/a', source: 'web', repo: 'x.com' }), 'x.com')
  assert.equal(refOf({ id: 'job:abc', source: 'job', repo: '' }), '')
  assert.equal(refOf({ id: 'manual:1', source: 'manual', repo: '' }), '')
})

test('refOf: an unknown source leads with its label, then the place', () => {
  assert.equal(refOf({ id: 'sentry:123', source: 'sentry', repo: 'acme-web' }), 'Sentry · acme-web')
  assert.equal(refOf({ id: 'sentry:123', source: 'sentry', repo: '' }), 'Sentry')
  assert.equal(refOf({ id: 'pd:1', source: 'pager-duty', repo: '' }), 'Pager Duty')
  // a job-filed item with a numeric tail is not a PR unless its source is GitHub
  assert.equal(refOf({ id: 'sentry:issue#42', source: 'sentry', repo: 'acme-web' }), 'Sentry · acme-web')
})

test('refOf: an empty source falls back to the home', () => {
  assert.equal(refOf({ id: 'x:1', source: '', repo: 'somewhere' }), 'somewhere')
})

test('playbookOf: suggestion, then reply route, then bug, then a look', () => {
  const base = { suggestion: undefined, reason: 'asked', source: 'slack', label: undefined } as Parameters<typeof playbookOf>[0]
  assert.equal(playbookOf(base), 'answer')
  assert.equal(playbookOf({ ...base, source: 'github', label: 'bug' }), 'debug-fix')
  assert.equal(playbookOf({ ...base, source: 'sentry' }), 'investigate')
  assert.equal(playbookOf({ ...base, source: 'github' }), 'investigate')
  assert.equal(playbookOf({ ...base, suggestion: { playbook: 'babysit' } as never }), 'babysit')
})

test('glyphOf: an unknown source draws the connector glyph, even for a job hit', () => {
  assert.equal(glyphOf({ source: 'sentry', kind: 'job-hit', ciFailing: false }), 'dot')
  assert.equal(glyphOf({ source: 'sentry', kind: 'fyi', ciFailing: false }), 'dot')
  assert.equal(glyphOf({ source: '', kind: 'fyi', ciFailing: false }), 'dot')
  assert.equal(glyphOf({ source: 'sentry', kind: 'job-hit', ciFailing: true }), 'alert')
})

test('glyphOf: known sources keep their glyph', () => {
  assert.equal(glyphOf({ source: 'github', kind: 'job-hit', ciFailing: false }), 'radar')
  assert.equal(glyphOf({ source: 'github', kind: 'review-requested', ciFailing: false }), 'pr')
  assert.equal(glyphOf({ source: 'github', kind: 'own-pr-open', ciFailing: true }), 'alert')
  assert.equal(glyphOf({ source: 'job', kind: 'digest', ciFailing: false }), 'book')
  assert.equal(glyphOf({ source: 'linear', kind: 'ticket-assigned', ciFailing: false }), 'ticket')
  assert.equal(glyphOf({ source: 'linear', kind: 'fyi', ciFailing: false }), 'ticket')
  assert.equal(glyphOf({ source: 'slack', kind: 'slack-mention', ciFailing: false }), 'hash')
  assert.equal(glyphOf({ source: 'web', kind: 'fyi', ciFailing: false }), 'globe')
  assert.equal(glyphOf({ source: 'manual', kind: 'manual', ciFailing: false }), 'todo')
  assert.equal(glyphOf({ source: 'manual', kind: 'fyi', ciFailing: false }), 'calendar')
})
