import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineOf, plainLine } from '../core/junior/last-line.js'
import type { SessionEvent } from '../shared/protocol.js'

const assistant = (content: unknown[]): SessionEvent => ({ kind: 'sdk', message: { type: 'assistant', message: { content } } } as unknown as SessionEvent)

test('an assistant message leaves its text, markdown out', () => {
  assert.equal(lineOf(assistant([{ type: 'text', text: 'Is the **retry cap** per `tenant`?' }])), 'Is the retry cap per tenant?')
})

test('text blocks join; tool calls leave nothing', () => {
  assert.equal(lineOf(assistant([{ type: 'text', text: 'Found it.' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'Pushing now.' }])), 'Found it. Pushing now.')
  assert.equal(lineOf(assistant([{ type: 'tool_use', name: 'Bash' }])), null)
})

test('your own message counts, prefixed; another agent\'s does not', () => {
  assert.equal(lineOf({ kind: 'local_user', text: 'Get #498 green' }), 'You: Get #498 green')
  assert.equal(lineOf({ kind: 'local_user', text: 'from the lead', from: 'junior' }), null)
  assert.equal(lineOf({ kind: 'notice', text: 'A team paused' }), null)
})

test('"#498" and snake_case survive; headings do not', () => {
  assert.equal(plainLine('## Done\nPushed #498, see webhook_spec.rb'), 'Done Pushed #498, see webhook_spec.rb')
})

test('code blocks drop and long lines cut', () => {
  assert.equal(plainLine('Run this:\n```sh\nnpm test\n```\nthen tell me.'), 'Run this: then tell me.')
  const long = plainLine('a '.repeat(200))
  assert.ok(long.length <= 140 && long.endsWith('…'))
})
