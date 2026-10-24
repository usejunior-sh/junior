/**
 * The friction capture (⌘⇧., web/src/components/FrictionCapture.tsx): the
 * create op it files through, the key and its place in the shortcut list, the
 * description it writes, and jobs being kept off the `friction` label.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import { dueOf } from '../core/work/due.js'
import { ITEM_LABELS } from '../core/work/fields.js'
import { filingFromJson, filingPrompt, JOB_LABELS, labelsOf } from '../core/job/filing.js'
import { parseJobFile } from '../server/job-files.js'
import { rowFiling } from '../server/jobs/scan-mcp.js'
import { createManualOp, editManualOp } from '../server/items-ops.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'
import { FRICTION_MAX, frictionContext, frictionDescription, frictionError, frictionTitle, pageName, shortId } from '../web/src/friction.js'
import { frictionKeyLabel, isFrictionKey, shortcutsFor } from '../web/src/shortcuts.js'

async function withRt(fn: (rt: WorkspaceRuntime) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-friction-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const rt = { store, meta: { id: 'test' }, clients: new Set(), inboxCache: null, attachmentsDir: path.join(dir, 'attachments') } as unknown as WorkspaceRuntime
  try {
    await fn(rt)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The op: one manual item, labelled friction, due Later, with where it was noted
// ---------------------------------------------------------------------------

test('filing a note makes one manual item labelled friction, due Later, with the route and item', () =>
  withRt(async (rt) => {
    const description = frictionDescription({ page: 'inbox', hash: '#/inbox', selected: 'github:acme/api#412' })
    const id = await createManualOp(rt, { title: 'transcript jumps to top', description, label: 'friction', due: 'later' })
    const all = await rt.store.items.listAll()
    assert.equal(all.length, 1)
    const item = await rt.store.items.get(id)
    assert.ok(item)
    assert.equal(item.kind, 'manual')
    assert.equal(item.title, 'transcript jumps to top')
    assert.equal(item.label, 'friction')
    assert.equal(item.description, 'Noted on Inbox (#/inbox) · selected github:acme/api#412')
    assert.ok(item.description?.includes('#/inbox'))
    assert.ok(item.description?.includes('github:acme/api#412'))
    // the description is the row's muted reason in the Inbox
    assert.equal(item.why, item.description)
    assert.equal(item.dueSource, 'you', 'filed into a section, not left to the default')
    assert.equal(dueOf({ ask: 'do', dueAt: item.dueAt, dueSource: item.dueSource }, Date.now()).section, 'later')
  }))

test('a manual item without a label still has none', () =>
  withRt(async (rt) => {
    const id = await createManualOp(rt, { title: 'plain' })
    assert.equal((await rt.store.items.get(id))?.label, undefined)
  }))

test('a bad label is refused and nothing is created', () =>
  withRt(async (rt) => {
    await assert.rejects(createManualOp(rt, { title: 'x', label: 'annoyance' }), /label must be one of: .*friction/)
    await assert.rejects(createManualOp(rt, { title: 'x', label: 3 }), /label must be one of/)
    assert.equal((await rt.store.items.listAll()).length, 0)
  }))

test('an edit can set the label on a manual item', () =>
  withRt(async (rt) => {
    const id = await createManualOp(rt, { title: 'x' })
    await editManualOp(rt, id, { label: 'friction' })
    assert.equal((await rt.store.items.get(id))?.label, 'friction')
    await assert.rejects(editManualOp(rt, id, { label: 'nope' }), /label must be one of/)
  }))

// ---------------------------------------------------------------------------
// Jobs can't file friction
// ---------------------------------------------------------------------------

const jobFile = (extra: string) => `---
id: j1
title: Sentry
schedule: "*/30 * * * *"
project: p1
tools: [web]
${extra}
---
New Sentry issues.
`

test("friction is yours: a job file naming it is an error, and runs never see it", () => {
  assert.ok(ITEM_LABELS.includes('friction'))
  assert.ok(!JOB_LABELS.includes('friction'))
  const bad = parseJobFile('j', jobFile('labels: [bug, friction]'))
  assert.ok(bad.errors.some((e) => e.includes("friction is yours to file, not a job's")), bad.errors.join('\n'))
  // the default list a run picks from leaves it out, and so does the prompt
  assert.deepEqual([...labelsOf(undefined)], [...JOB_LABELS])
  assert.ok(!filingPrompt(undefined).includes('friction'))
  // a stored filing that somehow names it drops it
  assert.deepEqual(filingFromJson(JSON.stringify({ reasons: ['found'], labels: ['friction', 'bug'] }))?.labels, ['bug'])
  // a run that tries it files no label
  assert.equal(rowFiling(undefined, { label: 'friction' }).label, undefined)
  assert.equal(rowFiling(undefined, { label: 'bug' }).label, 'bug')
})

// ---------------------------------------------------------------------------
// The key: listed, unique, and matched on the physical key
// ---------------------------------------------------------------------------

test('the key is in the shortcut list, once, and collides with nothing', () => {
  for (const mod of ['⌘', 'Ctrl+']) {
    const list = shortcutsFor(mod)
    const keys = list.map(([k]) => k)
    assert.equal(new Set(keys).size, keys.length, `duplicate key in ${keys.join(', ')}`)
    const row = list.find(([k]) => k === frictionKeyLabel(mod))
    assert.ok(row, 'friction row present')
    assert.equal(row[1], 'Note what annoyed you, for later')
    // no other row uses the period key
    assert.deepEqual(keys.filter((k) => k.includes('.')), [frictionKeyLabel(mod)])
  }
  assert.equal(frictionKeyLabel('⌘'), '⌘⇧.')
  assert.equal(frictionKeyLabel('Ctrl+'), 'Ctrl+Shift+.')
})

test('isFrictionKey: ⌘⇧. and Ctrl+Shift+., by the Period code only', () => {
  const k = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }>) =>
    isFrictionKey({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, code: 'Period', ...o })
  assert.equal(k({ metaKey: true, shiftKey: true }), true)
  assert.equal(k({ ctrlKey: true, shiftKey: true }), true)
  assert.equal(k({ metaKey: true }), false, 'no Shift')
  assert.equal(k({ shiftKey: true }), false, 'no modifier')
  assert.equal(k({ metaKey: true, shiftKey: true, altKey: true }), false, 'with Alt')
  assert.equal(k({ metaKey: true, shiftKey: true, code: 'Comma' }), false, 'another key')
  assert.equal(k({ metaKey: true, shiftKey: true, code: 'Slash' }), false, '⌘? is not it')
})

// ---------------------------------------------------------------------------
// What it records
// ---------------------------------------------------------------------------

test('description: page, hash, and the selected item when there is one', () => {
  assert.equal(frictionDescription({ page: 'inbox', hash: '#/inbox', selected: 'github:acme/api#412' }), 'Noted on Inbox (#/inbox) · selected github:acme/api#412')
  assert.equal(frictionDescription({ page: 'settings', hash: '#/settings/connectors' }), 'Noted on Settings (#/settings/connectors)')
  assert.equal(frictionDescription({ page: 'session', hash: '#/abc', selected: null }), 'Noted on Chat (#/abc)')
  assert.equal(frictionDescription({ page: 'home', hash: '' }), 'Noted on Junior (#/)')
  assert.equal(frictionDescription({ page: 'mystery', hash: '#/whatever' }), 'Noted at #/whatever')
})

test('footer context: on Page · selected id; unknown page shows the hash', () => {
  assert.deepEqual(frictionContext({ page: 'item', hash: '#/item/x', selected: 'manual:3f2c' }), { place: 'on Item', selected: 'manual:3f2c' })
  assert.deepEqual(frictionContext({ page: 'settings', hash: '#/settings/system' }), { place: 'on Settings', selected: null })
  assert.deepEqual(frictionContext({ page: 'mystery', hash: '#/whatever' }), { place: 'on #/whatever', selected: null })
})

test('page names cover the routes; prototype keys are not pages', () => {
  for (const [page, name] of [['junior', 'Junior'], ['draft', 'Chat'], ['terminal', 'Terminals'], ['job-form', 'Jobs'], ['artifact', 'Artifacts'], ['run', 'Run'], ['change', 'Changes'], ['goal', 'Goals']] as const)
    assert.equal(pageName(page), name)
  assert.equal(pageName('toString'), null)
  assert.equal(pageName('constructor'), null)
})

test('the line as filed: newlines become spaces, trimmed, capped', () => {
  assert.equal(frictionTitle('  a\nb\r\n  c  '), 'a b c')
  assert.equal(frictionTitle('   '), '')
  assert.equal(frictionTitle('x'.repeat(900)).length, FRICTION_MAX)
})

test('a long id is cut in the middle, keeping its end', () => {
  assert.equal(shortId('github:acme/api#412'), 'github:acme/api#412')
  const long = 'github:acme/a-very-long-repository-name-indeed/pull#41234'
  const s = shortId(long)
  assert.equal(s.length, 44)
  assert.ok(s.includes('…'))
  assert.ok(s.endsWith('pull#41234'))
})

test('error line: the op reason as a sentence, else Junior is not answering', () => {
  assert.equal(frictionError('a work item needs a title'), "Couldn't note it. A work item needs a title.")
  assert.equal(frictionError('Disk full!'), "Couldn't note it. Disk full!")
  assert.equal(frictionError(null), "Couldn't note it. Junior isn't answering.")
  assert.equal(frictionError('  '), "Couldn't note it. Junior isn't answering.")
})

test('copy rules: every new string is short and free of banned words', () => {
  const strings = [
    'What annoyed you?',
    'Note what annoyed you',
    'Note what annoyed you, for later',
    'Noted for later',
    "Noted for later. It's in your inbox.",
    "Couldn't note it. Junior isn't answering.",
    "friction is yours to file, not a job's",
  ]
  for (const s of strings) {
    for (const sentence of s.split(/(?<=[.?!])\s+/)) assert.ok(sentence.split(/\s+/).length <= 15, sentence)
    assert.ok(!/\b(AI|24\/7|walk away)\b/i.test(s), s)
  }
})
