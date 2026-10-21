/**
 * The Slack scan's rows (core/sources/slack.ts): a built-in row keeps the PR
 * links it saw, canonical, so a review ask folds into the PR's row.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBuiltinRows, parseScanRows } from '../core/sources/slack.js'

const NOW = Date.parse('2026-10-21T12:00:00Z')

test('a built-in row carries its PR refs, canonical; one without has none', () => {
  const raw = JSON.stringify([
    { title: 'Can you review my PR?', permalink: 'https://acme.slack.com/archives/C9/p100', channel: '#eng', from: 'Anirudha', lastActivity: '2026-10-21T11:00:00Z', kind: 'reply-pending', refs: ['https://github.com/acme/api/pull/40', 'nonsense'] },
    { title: 'lunch?', permalink: 'https://acme.slack.com/archives/C9/p101', channel: '#eng', from: 'Kim', lastActivity: '2026-10-21T11:00:00Z', kind: 'mention', refs: [] },
  ])
  const { builtins } = parseScanRows(raw, new Set())
  const items = normalizeBuiltinRows(builtins, NOW)
  assert.deepEqual(items[0]!.refs, ['github:acme/api#40'])
  assert.equal(items[0]!.kind, 'slack-reply-pending')
  assert.equal('refs' in items[1]!, false)
})
