/**
 * Card specs (core/cards): the strict parser, tool globs, which spec wins,
 * where args land on a card, and edits going back into args in their own
 * types. The guard every test leans on: each arg is on the card exactly once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEdits,
  editText,
  fillTitle,
  parseCardSpec,
  planCard,
  serverName,
  specFor,
  toolMatches,
  type CardPlan,
  type CardSpec,
} from '../core/cards/spec.js'
import { BUILTIN_SPECS } from '../core/cards/builtin.js'

const SLACK = 'mcp__claude_ai_Slack__slack_send_message'

/** Every arg key in exactly one slot. */
function assertEachArgOnce(plan: CardPlan, args: Record<string, unknown>) {
  const placed = [...plan.target, ...plan.chips, ...(plan.subject ? [plan.subject] : []), ...(plan.body ? [plan.body] : []), ...plan.rest]
  assert.deepEqual([...placed].sort(), Object.keys(args).sort(), `${plan.spec ?? 'generic'}: every arg once`)
  assert.equal(new Set(placed).size, placed.length)
  assert.deepEqual(Object.keys(plan.edit).sort(), Object.keys(args).sort())
}

test('parse: a valid spec, with options and words', () => {
  const r = parseCardSpec('linear.create_issue', {
    tool: 'mcp__*linear*__create_issue',
    layout: 'ticket',
    kind: 'ticket',
    verb: 'Create',
    target: ['team'],
    chips: ['priority'],
    subject: 'title',
    body: 'description',
    edit: { priority: [0, 1, 2, 3, 4], description: 'markdown' },
    labels: { team: 'team' },
  })
  assert.ok(r.ok)
  assert.deepEqual(r.spec.edit, { priority: [0, 1, 2, 3, 4], description: 'markdown' })
  assert.equal(r.spec.source, undefined)
})

test('parse: strict, so a typo is an error, not nothing', () => {
  const bad = (raw: unknown, id = 'x') => {
    const r = parseCardSpec(id, raw)
    assert.equal(r.ok, false)
    return r.ok ? '' : r.error
  }
  assert.match(bad({ tool: 'a', layout: 'message', bdy: 'text' }), /unknown key "bdy"/)
  assert.match(bad({ tool: 'a', layout: 'card' }), /"layout" is one of/)
  assert.match(bad({ layout: 'message' }), /"tool" is required/)
  assert.match(bad({ tool: 'a', layout: 'message', kind: 'tweet' }), /"kind"/)
  assert.match(bad({ tool: 'a', layout: 'message', target: ['text'], body: 'text' }), /"text" sits in two slots/)
  assert.match(bad({ tool: 'a', layout: 'message', edit: { a: 'html' } }), /"edit.a"/)
  assert.match(bad({ tool: 'a', layout: 'message', edit: { a: [] } }), /"edit.a"/)
  assert.match(bad({ tool: 'a', layout: 'message', source: 'builtin' }), /unknown key "source"/)
  assert.match(bad({ tool: 'a', layout: 'message' }, '../etc'), /file name/)
  assert.match(bad([]), /JSON object/)
})

test('every built-in spec parses as a file would', () => {
  const ids = new Set<string>()
  for (const { id, source: _source, ...rest } of BUILTIN_SPECS) {
    assert.ok(!ids.has(id), `duplicate id ${id}`)
    ids.add(id)
    const r = parseCardSpec(id, JSON.parse(JSON.stringify(rest)))
    assert.ok(r.ok, r.ok ? '' : r.error)
  }
})

test('globs: * only, anchored, case-insensitive', () => {
  assert.ok(toolMatches('mcp__*__slack_send_message', SLACK))
  assert.ok(!toolMatches('mcp__*__slack_send_message', 'mcp__claude_ai_Slack__slack_send_message_draft'))
  assert.ok(toolMatches('mcp__*linear*__create_issue', 'mcp__claude_ai_Linear__create_issue'))
  assert.ok(toolMatches('mcp__*linear*__create_issue', 'mcp__linear__create_issue'))
  assert.ok(!toolMatches('mcp__a.b__x', 'mcp__aXb__x'), 'a dot is a dot')
  assert.ok(toolMatches('*', 'anything'))
})

test('a workspace spec before the built-ins wins', () => {
  const mine: CardSpec = { id: 'my-slack', tool: 'mcp__*__slack_send_message', layout: 'generic', source: 'workspace' }
  assert.equal(specFor(SLACK, [mine, ...BUILTIN_SPECS])?.id, 'my-slack')
  assert.equal(specFor(SLACK, BUILTIN_SPECS)?.id, 'slack.send_message')
  assert.equal(specFor('mcp__pagerduty__create_incident', BUILTIN_SPECS), null)
  const plan = planCard(SLACK, { channel_id: 'C1', message: 'hi' }, [mine, ...BUILTIN_SPECS])
  assert.equal(plan.source, 'workspace')
  assert.equal(plan.layout, 'generic')
})

test('slack: target and body from the spec, the rest in All fields', () => {
  const args = { channel_id: 'C0123', thread_ts: '1729.1', message: 'nova#3241 is green.', unfurl_app_links: true }
  const plan = planCard(SLACK, args, BUILTIN_SPECS)
  assertEachArgOnce(plan, args)
  assert.equal(plan.layout, 'message')
  assert.equal(plan.name, 'Slack')
  assert.equal(plan.verb, 'Send')
  assert.deepEqual(plan.target, ['channel_id', 'thread_ts'])
  assert.equal(plan.body, 'message')
  assert.deepEqual(plan.rest, ['unfurl_app_links'])
  assert.equal(plan.edit.message, 'markdown')
  assert.equal(plan.edit.unfurl_app_links, 'boolean')
  assert.equal(plan.labels.channel_id, 'channel')
})

test('a slot the call has no arg for stays empty; an empty arg goes to All fields', () => {
  const args = { channel_id: 'C1', message: 'hi', thread_ts: '' }
  const plan = planCard(SLACK, args, BUILTIN_SPECS)
  assertEachArgOnce(plan, args)
  assert.deepEqual(plan.target, ['channel_id'])
  assert.deepEqual(plan.rest, ['thread_ts'])
})

test('the guard holds for every built-in spec, with args it does and does not name', () => {
  for (const spec of BUILTIN_SPECS) {
    const named = [...(spec.target ?? []), ...(spec.chips ?? []), spec.subject, spec.body].filter((k): k is string => !!k)
    const args: Record<string, unknown> = { extra: { nested: [1, 2] }, other: 7 }
    for (const k of named) args[k] = `v-${k}`
    // The tool name from the glob, with each * filled.
    const tool = spec.tool.replace(/\*/g, 'x')
    const plan = planCard(tool, args, BUILTIN_SPECS)
    assert.equal(plan.spec, spec.id, `${tool} → ${spec.id}`)
    assertEachArgOnce(plan, args)
    assert.deepEqual(plan.rest.sort(), ['extra', 'other'])
  }
})

test('generic: no spec, so target, subject and body are picked by name', () => {
  const args = { service: 'nova-exports', urgency: 'low', title: 'Export timeouts', body: 'Fix in progress.', to: 'oncall' }
  const plan = planCard('mcp__pagerduty__create_incident', args, BUILTIN_SPECS)
  assertEachArgOnce(plan, args)
  assert.equal(plan.spec, null)
  assert.equal(plan.source, null)
  assert.equal(plan.layout, 'generic')
  assert.equal(plan.name, 'pagerduty')
  assert.equal(plan.verb, 'Approve')
  assert.equal(plan.title, null)
  assert.deepEqual(plan.target, ['to'])
  assert.equal(plan.subject, 'title')
  assert.equal(plan.body, 'body')
  assert.deepEqual(plan.rest, ['service', 'urgency'])
})

test('generic: a non-string never leads as subject or body', () => {
  const args = { title: { a: 1 }, body: 3 }
  const plan = planCard('mcp__x__do', args, [])
  assertEachArgOnce(plan, args)
  assert.equal(plan.subject, null)
  assert.equal(plan.body, null)
})

test('a spec word never turns a number or a list into text', () => {
  const spec: CardSpec = { id: 's', tool: 'mcp__x__y', layout: 'ticket', edit: { n: 'markdown', s: 'markdown', o: ['a', 'b'], p: [1, 2] } }
  const plan = planCard('mcp__x__y', { n: 3, s: 'hi', o: 'a', p: 'x' }, [spec])
  assert.equal(plan.edit.n, 'number')
  assert.equal(plan.edit.s, 'markdown')
  assert.deepEqual(plan.edit.o, ['a', 'b'])
  assert.equal(plan.edit.p, 'line', 'number options on a string arg do not apply')
})

test('titles: filled from args, one line, missing parts drop out', () => {
  assert.equal(fillTitle('New {issueTypeName} in {projectKey}', { issueTypeName: 'Bug', projectKey: 'NOVA' }), 'New Bug in NOVA')
  assert.equal(fillTitle('New issue · {title}', {}), 'New issue')
  assert.equal(fillTitle('{a}', { a: 'line one\nline two' }), 'line one line two')
  assert.equal(fillTitle('{a}', { a: 'x'.repeat(200) }).length, 80)
  const plan = planCard('mcp__claude_ai_Atlassian__createJiraIssue', { issueTypeName: 'Bug', projectKey: 'NOVA', summary: 's', cloudId: 'c' }, BUILTIN_SPECS)
  assert.equal(plan.title, 'New Bug in NOVA')
})

test('server names in words', () => {
  assert.equal(serverName(SLACK), 'Slack')
  assert.equal(serverName('mcp__linear__create_issue'), 'linear')
  assert.equal(serverName('mcp__claude_ai_Jira_and_Confluence__createJiraIssue'), 'Jira and Confluence')
  assert.equal(serverName('Bash'), 'Bash')
})

test('edits go back in their own types; untouched args stay exactly as they were', () => {
  const args = { text: 'hi', n: 3, flag: false, list: ['a', 'b'], pick: 'low', obj: { a: 1 } }
  const edit = { text: 'markdown', n: 'number', flag: 'boolean', list: 'json', pick: ['low', 'high'], obj: 'json' } as const
  const r = applyEdits(args, edit, { text: 'hello', n: '4', flag: 'true', list: '["c"]', pick: 'high', obj: editText(args.obj, 'json') })
  assert.ok(r.ok)
  assert.deepEqual(r.args, { text: 'hello', n: 4, flag: true, list: ['c'], pick: 'high', obj: { a: 1 } })
  assert.equal(r.args.obj, args.obj, 'an untouched object is the same object')
})

test('edits: bad input is an error, never a silent change', () => {
  const args = { n: 3, pick: 'low', obj: { a: 1 }, flag: true }
  const edit = { n: 'number', pick: ['low', 'high'], obj: 'json', flag: 'boolean' } as const
  const err = (edits: Record<string, string>) => {
    const r = applyEdits(args, edit, edits)
    assert.equal(r.ok, false)
    return r.ok ? '' : r.error
  }
  assert.match(err({ n: 'four' }), /"n" is a number/)
  assert.match(err({ n: ' ' }), /"n" is a number/)
  assert.match(err({ pick: 'mid' }), /"pick" is one of low, high/)
  assert.match(err({ obj: '{a:' }), /"obj" isn't valid JSON/)
  assert.match(err({ flag: 'yes' }), /true or false/)
  assert.match(err({ added: 'x' }), /not an arg/)
})

test('numeric options come back as numbers', () => {
  const r = applyEdits({ priority: 2 }, { priority: [0, 1, 2, 3] }, { priority: '3' })
  assert.ok(r.ok)
  assert.equal(r.args.priority, 3)
})
