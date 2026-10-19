import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scriptPhases } from '../core/workflows/fold.js'

test('scriptPhases reads meta.phases with titles and details', () => {
  const script = `export const meta = {
  name: 'review',
  description: 'Review, then verify',
  phases: [
    { title: 'Review', detail: '3 reviewers, one lens each [max 2]' },
    { title: "Verify" },
  ],
}
phase('Review')
const xs = [{ title: 'not a phase' }]`
  assert.deepEqual(scriptPhases(script), [{ title: 'Review', detail: '3 reviewers, one lens each [max 2]' }, { title: 'Verify' }])
})

test('scriptPhases reads a one-line meta and gives nothing without phases', () => {
  assert.deepEqual(scriptPhases(`export const meta = { name: 'x', phases: [{ title: 'Run' }] }\nawait agent('hi')`), [{ title: 'Run' }])
  assert.deepEqual(scriptPhases(`export const meta = {\n  name: 'x',\n}\n`), [])
  assert.deepEqual(scriptPhases(''), [])
})
