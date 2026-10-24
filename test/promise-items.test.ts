/**
 * Promise items (core/work/promise-items.ts, server/inbox/promises.ts): your
 * own words become `promise` items, deduped by thread + quote, filed from any
 * source (a job's `source:` included), and "Not a promise" suppresses the
 * thread. Runs on a real SQLite file; times are fixed local dates.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { WorkItem } from '../core/work/types.js'
import {
  promiseItemId,
  promiseItemsFrom,
  promiseThreadOf,
  quoteKey,
  saidFrom,
  suppressedThreads,
  type PromiseThread,
} from '../core/work/promise-items.js'
import { filedSource } from '../core/job/filing.js'
import { builtinPromiseThreads, normalizeBuiltinRows, parseScanRows } from '../core/sources/slack.js'
import { filePromises, markNotAPromise } from '../server/inbox/promises.js'
import { rank } from '../core/work/score.js'

/** 2026-10-<day> at h:00, local time. Oct 21 2026 is a Wednesday. */
const at = (day: number, h = 10) => new Date(2026, 9, day, h, 0).getTime()
const NOW = at(21, 12)

async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'junior-promises-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    await fn(store)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const slackThread = (messages: PromiseThread['messages'], thread = 'slack:C1/p100'): PromiseThread => ({
  thread,
  source: 'slack',
  url: 'https://acme.slack.com/archives/C1/p100',
  place: '#eng',
  messages,
})

test('a promise in your own words becomes one promise item, linked to its thread', () => {
  const items = promiseItemsFrom(slackThread([{ text: "Dev, I'll review your PR tomorrow.", at: at(21) }]))
  assert.equal(items.length, 1)
  const p = items[0]!
  assert.equal(p.kind, 'promise')
  assert.equal(p.source, 'slack')
  assert.equal(p.title, "Dev, I'll review your PR tomorrow.")
  assert.deepEqual(p.refs, ['slack:C1/p100'])
  assert.equal(p.author, 'Dev')
  assert.equal(p.peopleWaiting, 1)
  assert.equal(p.promise?.owedTo, 'Dev')
  assert.equal(p.promise?.thread, 'slack:C1/p100')
  assert.equal(p.dueAt, new Date(2026, 9, 22).getTime())
  assert.ok(p.id.startsWith('promise:slack:C1/p100~'))
})

test('text that promises nothing files nothing', () => {
  assert.deepEqual(promiseItemsFrom(slackThread([{ text: 'Thanks, looks good to me', at: at(21) }])), [])
  assert.deepEqual(promiseItemsFrom(slackThread([])), [])
})

test('the id is thread + quote: same words dedupe, new words or a new thread do not', () => {
  const q = "I'll fix the flaky test tomorrow."
  assert.equal(promiseItemId('slack:C1/p1', q), promiseItemId('slack:C1/p1', "i'll  fix the flaky test tomorrow"))
  assert.notEqual(promiseItemId('slack:C1/p1', q), promiseItemId('slack:C1/p2', q))
  assert.notEqual(promiseItemId('slack:C1/p1', q), promiseItemId('slack:C1/p1', "I'll fix the build tomorrow."))
  assert.equal(quoteKey(' On it!  '), 'on it')
  // the same quote said twice in one thread is one item
  const twice = promiseItemsFrom(slackThread([
    { text: "I'll fix the flaky test tomorrow.", at: at(20) },
    { text: "I'll fix the flaky test tomorrow.", at: at(21) },
  ]))
  assert.equal(twice.length, 1)
  assert.equal(twice[0]!.updatedAt, new Date(at(21)).toISOString())
})

test('promise items dedupe by thread + quote in the store', async () => {
  await withStore(async (store) => {
    const msg = { text: "I'll send the migration plan by Friday.", at: at(21) }
    const first = await filePromises(store.items, slackThread([msg]))
    assert.equal(first.inserted.length, 1)
    // a second run reads the same thread again: no new item
    const again = await filePromises(store.items, slackThread([msg, { text: 'Sounds good', at: at(21, 11) }]))
    assert.equal(again.inserted.length, 0)
    assert.deepEqual(again.filed, first.inserted)
    // a new promise in the same thread is a new item
    const more = await filePromises(store.items, slackThread([msg, { text: "Will also update the runbook.", at: at(21, 11) }]))
    assert.equal(more.inserted.length, 1)
    // the same words in another thread are another promise
    const other = await filePromises(store.items, slackThread([msg], 'slack:C2/p7'))
    assert.equal(other.inserted.length, 1)
    const promises = (await store.items.listAll()).filter((i) => i.kind === 'promise')
    assert.equal(promises.length, 3)
  })
})

test('a re-read never reopens a promise you closed', async () => {
  await withStore(async (store) => {
    const msg = { text: "I'll look into the timeout tomorrow.", at: at(20) }
    const { inserted } = await filePromises(store.items, slackThread([msg]))
    const id = inserted[0]!
    await store.items.transition(id, { status: 'done', actor: 'user' })
    const again = await filePromises(store.items, slackThread([msg]))
    assert.equal(again.inserted.length, 0)
    assert.equal((await store.items.get(id))?.status, 'done')
  })
})

test('filing from a non-Slack job source creates a promise item under that source', async () => {
  await withStore(async (store) => {
    // what a Sentry job's upsert_work_item files: a web link, read as sentry (filing.ts filedSource)
    const row: WorkItem = {
      id: 'web:acme.sentry.io/issues/4242',
      source: filedSource({ reasons: ['found'], labels: [], source: 'sentry' }, 'web'),
      kind: 'job-hit',
      title: 'TypeError in checkout',
      url: 'https://acme.sentry.io/issues/4242/',
      repo: 'acme-web',
      author: '',
      peopleWaiting: 0,
      createdAt: new Date(at(21)).toISOString(),
      updatedAt: new Date(at(21)).toISOString(),
      jobId: 'job-sentry',
    }
    assert.equal(row.source, 'sentry')
    const yours = [{ text: "Mia, I'll take a look at this one later today.", at: new Date(at(21, 9)).toISOString() }]
    const thread = promiseThreadOf(row, yours, NOW, 'job-sentry')
    const res = await filePromises(store.items, thread, { jobId: 'job-sentry', runId: 'run-1', at: NOW })
    assert.equal(res.inserted.length, 1)
    const p = await store.items.get(res.inserted[0]!)
    assert.ok(p)
    assert.equal(p.kind, 'promise')
    assert.equal(p.source, 'sentry')
    assert.equal(p.url, 'https://acme.sentry.io/issues/4242/')
    assert.equal(p.repo, 'acme-web')
    assert.equal(p.jobId, 'job-sentry')
    assert.deepEqual(p.refs, ['web:acme.sentry.io/issues/4242'])
    assert.equal(p.promise?.quote, "Mia, I'll take a look at this one later today.")
    assert.equal(p.promise?.owedTo, 'Mia')
    assert.equal(p.foundBy?.[0]?.jobId, 'job-sentry')
    assert.equal(p.foundBy?.[0]?.runId, 'run-1')
    // it ranks as something you owe
    const [scored] = rank([p], NOW)
    assert.equal(scored?.group, 'blocking')
    assert.equal(scored?.ask, 'do')
  })
})

test('not a promise archives the item and suppresses its thread', async () => {
  await withStore(async (store) => {
    const first = await filePromises(store.items, slackThread([{ text: "I'll fix it tomorrow.", at: at(21) }]))
    const id = first.inserted[0]!
    const res = await markNotAPromise(store.items, { id }, NOW)
    assert.deepEqual(res, { id, thread: 'slack:C1/p100' })
    assert.equal((await store.items.get(id))?.status, 'archived')
    const events = await store.items.events(id)
    assert.ok(events.some((e) => e.event === 'not-a-promise' && e.actor === 'user' && e.detail?.thread === 'slack:C1/p100'))
    assert.deepEqual([...suppressedThreads(await store.items.notesOf('not-a-promise'))], ['slack:C1/p100'])
    // that thread files no more promises, new words included
    const later = await filePromises(store.items, slackThread([{ text: "Will push a patch on Monday.", at: at(21, 15) }]))
    assert.equal(later.suppressed, true)
    assert.deepEqual(later.filed, [])
    // another thread still does
    const other = await filePromises(store.items, slackThread([{ text: "Will push a patch on Monday.", at: at(21, 15) }], 'slack:C9/p1'))
    assert.equal(other.inserted.length, 1)
    // only promise items can be marked
    await assert.rejects(markNotAPromise(store.items, { id: 'slack:C1/p100' }), /promise item id/)
    await assert.rejects(markNotAPromise(store.items, { id: 'promise:slack:C1/p100~0' }), /no such item/)
  })
})

test('your messages from a tool call: malformed ones dropped, future times read as now', () => {
  const said = saidFrom(
    [
      { text: "I'll check", at: new Date(at(21, 9)).toISOString(), replyTo: ' Dev ' },
      { text: '', at: new Date(at(21)).toISOString() },
      { text: 'later', at: new Date(at(25)).toISOString() },
      { at: 'x' },
      42,
      'plain string',
    ],
    NOW,
  )
  assert.deepEqual(said, [
    { text: "I'll check", at: at(21, 9), replyTo: 'Dev' },
    { text: 'later', at: NOW },
    { text: 'plain string', at: NOW },
  ])
  assert.deepEqual(saidFrom('nope', NOW), [])
})

test('built-in Slack rows: your messages are read for promises, a "yours" row files no thread item', () => {
  const raw = JSON.stringify([
    {
      title: 'Deploy question',
      permalink: 'https://acme.slack.com/archives/C1/p100',
      channel: '#eng',
      from: 'Dev',
      lastActivity: new Date(at(21)).toISOString(),
      kind: 'yours',
      refs: [],
      yours: [{ text: "I'll update the deploy doc tomorrow.", at: new Date(at(21)).toISOString() }],
    },
    {
      title: 'Can you review?',
      permalink: 'https://acme.slack.com/archives/C2/p200',
      channel: '#web',
      from: 'Mia',
      lastActivity: new Date(at(21)).toISOString(),
      kind: 'reply-pending',
      refs: [],
      yours: [],
    },
  ])
  const { builtins } = parseScanRows(raw, new Set())
  assert.equal(builtins.length, 2)
  const items = normalizeBuiltinRows(builtins, NOW)
  assert.deepEqual(items.map((i) => i.id), ['slack:C2/p200'])
  const threads = builtinPromiseThreads(builtins, NOW)
  assert.equal(threads.length, 1)
  assert.equal(threads[0]!.thread, 'slack:C1/p100')
  const promises = promiseItemsFrom(threads[0]!)
  assert.equal(promises.length, 1)
  assert.equal(promises[0]!.source, 'slack')
  assert.equal(promises[0]!.repo, '#eng')
})
