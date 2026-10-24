/**
 * Bot-comment triage (core/babysit/bot-triage.ts): which bot wrote it, a
 * thread as a finding, verdicts that default to fix, and a tally that counts
 * only what the user approved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addToTally,
  botOf,
  findingOf,
  messageOf,
  ruleOf,
  tallyFor,
  tallyOf,
  verdictFrom,
  verdictsFor,
  type Bot,
  type Finding,
  type VerdictRecord,
} from '../core/babysit/bot-triage.js'
import type { PrThread } from '../core/babysit/ci.js'

test('botOf recognises the five bots by login, with or without [bot]', () => {
  const cases: [string, Bot][] = [
    ['coderabbitai[bot]', 'CodeRabbit'],
    ['coderabbitai', 'CodeRabbit'],
    ['copilot-pull-request-reviewer[bot]', 'Copilot'],
    ['Copilot', 'Copilot'],
    ['greptile-apps[bot]', 'Greptile'],
    ['greptile-apps', 'Greptile'],
    ['cursor[bot]', 'Bugbot'],
    ['cursor', 'Bugbot'],
    ['qodo-merge-pro[bot]', 'Qodo'],
    ['qodo-merge[bot]', 'Qodo'],
    ['codiumai-pr-agent-pro[bot]', 'Qodo'],
    ['  CodeRabbitAI[bot] ', 'CodeRabbit'],
  ]
  for (const [login, bot] of cases) assert.equal(botOf(login), bot, login)
})

test('botOf: people and other bots are nobody', () => {
  for (const login of ['samarkundal', 'dependabot[bot]', 'renovate[bot]', 'github-actions[bot]', 'ci-bot', 'coderabbit-fan', '', null, undefined]) {
    assert.equal(botOf(login), null, String(login))
  }
})

test('ruleOf reads the opening label; no label is general', () => {
  assert.equal(ruleOf('_⚠️ Potential issue_\n\n**Null check is missing.**'), 'potential-issue')
  assert.equal(ruleOf('_🛠️ Refactor suggestion_\n\nExtract this.'), 'refactor-suggestion')
  assert.equal(ruleOf('_🧹 Nitpick (assertive)_\n\nRename x.'), 'nitpick')
  assert.equal(ruleOf('### Bug: Retry loop never exits\n\nThe counter...'), 'bug')
  assert.equal(ruleOf('This looks fine but consider a comment.'), 'general')
  // a label deep in the argument doesn't count
  assert.equal(ruleOf('Line one.\nLine two.\nLine three.\nThis is a security problem.'), 'general')
})

test('messageOf: the claim, not the label or markup', () => {
  assert.equal(messageOf('_⚠️ Potential issue_\n\n**Null check is missing on `user`.**\n\nMore detail.'), 'Null check is missing on `user`.')
  assert.equal(messageOf('<!-- metadata -->\n### Bug: Retry loop never exits'), 'Bug: Retry loop never exits')
  assert.equal(messageOf(''), '')
  assert.ok(messageOf('x'.repeat(500)).length <= 200)
})

const thread = (over: Partial<PrThread> = {}): PrThread => ({
  id: 't1',
  author: 'coderabbitai[bot]',
  isBot: true,
  resolved: false,
  path: 'src/retry.ts',
  body: '_🧹 Nitpick_\n\nPrefer const here.',
  url: 'https://github.com/acme/api/pull/7#discussion_r1',
  ...over,
})

test('findingOf: an open thread from a known bot becomes a finding', () => {
  assert.deepEqual(findingOf(thread(), 41), {
    threadId: 't1',
    path: 'src/retry.ts',
    line: 41,
    bot: 'CodeRabbit',
    rule: 'nitpick',
    message: 'Prefer const here.',
    url: 'https://github.com/acme/api/pull/7#discussion_r1',
  })
  assert.equal(findingOf(thread({ resolved: true })), null)
  assert.equal(findingOf(thread({ author: 'dependabot[bot]' })), null)
  assert.equal(findingOf(thread({ author: 'samarkundal', isBot: false })), null)
  assert.equal(findingOf(thread())!.line, null)
})

test('verdictFrom: clear non-fix verdicts keep their reply', () => {
  assert.deepEqual(verdictFrom({ threadId: 't1', verdict: 'wont-fix', reply: 'Kept on purpose: matches the API.' }), {
    threadId: 't1',
    verdict: 'wont-fix',
    reply: 'Kept on purpose: matches the API.',
  })
  assert.deepEqual(verdictFrom({ threadId: 't1', verdict: 'Incorrect', reply: ' The value is never null here. ', why: 'guarded above' }), {
    threadId: 't1',
    verdict: 'incorrect',
    reply: 'The value is never null here.',
    why: 'guarded above',
  })
  assert.equal(verdictFrom({ threadId: 't1', verdict: 'wont_fix', reply: 'ok' })!.verdict, 'wont-fix')
})

test('verdictFrom: unsure, unknown, malformed or reply-less is a fix', () => {
  for (const raw of [
    { threadId: 't1', verdict: 'unsure', reply: 'maybe' },
    { threadId: 't1', verdict: 'skip' },
    { threadId: 't1', verdict: 'wont-fix' },
    { threadId: 't1', verdict: 'incorrect', reply: '   ' },
    { threadId: 't1', verdict: 42 },
    { threadId: 't1' },
  ]) {
    assert.equal(verdictFrom(raw)!.verdict, 'fix', JSON.stringify(raw))
  }
  assert.equal(verdictFrom(null), null)
  assert.equal(verdictFrom('fix'), null)
  assert.equal(verdictFrom({ verdict: 'fix' }), null)
})

test('verdictsFor: one per finding, missing ones fix, strays dropped, first wins', () => {
  const f = (threadId: string): Finding => ({ threadId, path: null, line: null, bot: 'Copilot', rule: 'general', message: '', url: null })
  const out = verdictsFor(
    [f('a'), f('b'), f('c')],
    [
      { threadId: 'b', verdict: 'incorrect', reply: 'Not so.' },
      { threadId: 'b', verdict: 'fix' },
      { threadId: 'zz', verdict: 'wont-fix', reply: 'stray' },
      { threadId: 'c', verdict: 'nonsense' },
      'junk',
    ],
  )
  assert.deepEqual(out.map((v) => [v.threadId, v.verdict]), [['a', 'fix'], ['b', 'incorrect'], ['c', 'fix']])
})

const rec = (over: Partial<VerdictRecord> = {}): VerdictRecord => ({
  repo: 'acme/api',
  finding: { bot: 'CodeRabbit', rule: 'nitpick' },
  verdict: 'wont-fix',
  approvedBy: 'you',
  ...over,
})

test('tally counts only verdicts the user approved', () => {
  const tally = tallyOf([
    rec(),
    rec(),
    rec({ verdict: 'fix' }),
    rec({ approvedBy: null }),
    rec({ approvedBy: 'rule' }),
    rec({ verdict: 'incorrect', approvedBy: null }),
  ])
  const row = tallyFor(tally, 'acme/api', 'CodeRabbit', 'nitpick')!
  assert.equal(row.total, 3)
  assert.equal(row['wont-fix'], 2)
  assert.equal(row.fix, 1)
  assert.equal(row.incorrect, 0)
})

test('tally keys on repo × bot × rule, case-folded on repo and rule', () => {
  const tally = tallyOf([
    rec(),
    rec({ repo: 'ACME/api', finding: { bot: 'CodeRabbit', rule: 'Nitpick' } }),
    rec({ repo: 'acme/web' }),
    rec({ finding: { bot: 'Copilot', rule: 'nitpick' } }),
    rec({ finding: { bot: 'CodeRabbit', rule: 'potential-issue' } }),
  ])
  assert.equal(Object.keys(tally).length, 4)
  assert.equal(tallyFor(tally, 'acme/api', 'CodeRabbit', 'nitpick')!.total, 2)
  assert.equal(tallyFor(tally, 'acme/web', 'CodeRabbit', 'nitpick')!.total, 1)
  assert.equal(tallyFor(tally, 'acme/api', 'Greptile', 'nitpick'), null)
})

test('tally counts the times the user changed Junior’s verdict', () => {
  const tally = tallyOf([rec({ proposed: 'wont-fix' }), rec({ verdict: 'fix', proposed: 'wont-fix' }), rec()])
  assert.equal(tallyFor(tally, 'acme/api', 'CodeRabbit', 'nitpick')!.changed, 1)
})

test('addToTally never mutates, and skips what does not count', () => {
  const before = tallyOf([rec()])
  const snapshot = JSON.stringify(before)
  const after = addToTally(before, rec({ verdict: 'incorrect' }))
  assert.equal(JSON.stringify(before), snapshot)
  assert.equal(tallyFor(after, 'acme/api', 'CodeRabbit', 'nitpick')!.total, 2)
  assert.equal(addToTally(before, rec({ approvedBy: null })), before)
  // round-trips through JSON, so it can live in config
  assert.deepEqual(JSON.parse(JSON.stringify(after)), after)
})
