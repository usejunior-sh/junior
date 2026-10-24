/**
 * The client half of paged session replay: how pages join in the store
 * (web/src/paging.ts) and how the transcript folds a log that starts partway
 * (buildTranscript's `base` and `midway`, web/src/transcript.ts).
 *
 * The acceptance line is the first test: a fully loaded session folds exactly
 * as it did before paging, whether it arrived whole or a page at a time.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, eventIndexOf, type TranscriptItem } from '../web/src/transcript.js'
import { joinNewest, prependOlder, type LoadedRange } from '../web/src/paging.js'
import type { SdkMessage, SessionEvent } from '../shared/protocol.js'

const sdk = (message: SdkMessage): SessionEvent => ({ kind: 'sdk', message })
const init = () => sdk({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['Read', 'Bash'] })
const you = (text: string): SessionEvent => ({ kind: 'local_user', text })
const say = (text: string) => sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const call = (id: string, name: string, input: Record<string, unknown>) =>
  sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const answer = (id: string, content: string) =>
  sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
const turnEnd = (total: number) => sdk({ type: 'result', subtype: 'success', total_cost_usd: total, duration_ms: 2000, num_turns: 3 })

/** One turn: your message, Junior's init, a read, a run, a reply, the result. 7 events. */
const turn = (n: number, total: number): SessionEvent[] => [
  you(`step ${n}`),
  init(),
  call(`r${n}`, 'Read', { file_path: `/repo/f${n}.ts` }),
  answer(`r${n}`, 'line one\nline two'),
  call(`b${n}`, 'Bash', { command: 'npm test', description: 'Run the tests' }),
  answer(`b${n}`, 'ok'),
  say(`Done with step ${n}.`),
  turnEnd(total),
]

/** A session of `turns` turns: 8 events each, seqs 1..N. */
const session = (turns: number): SessionEvent[] => Array.from({ length: turns }, (_, i) => turn(i + 1, 0.1 * (i + 1))).flat()

const keys = (items: TranscriptItem[]) => items.map((i) => i.key)

/** How the server would page it: the newest `limit`, cut back to a turn, then older pages of the same rule. */
function serverPages(log: SessionEvent[], limit: number) {
  const pageBefore = (beforeSeq: number) => {
    const end = beforeSeq - 1 // events with seq < beforeSeq: indices [0, end)
    let start = Math.max(0, end - limit)
    // cut on a turn: start at a `local_user`
    while (start > 0 && start < end && log[start].kind !== 'local_user') start++
    const events = log.slice(start, end)
    return { events, hasEarlier: start > 0, firstSeq: events.length ? start + 1 : undefined }
  }
  return pageBefore
}

test('a fully loaded session folds exactly as before: no options, explicit defaults, or loaded a page at a time', () => {
  const log = session(6)
  const whole = buildTranscript(log)
  // The fold itself is unchanged: an init card once, each turn's grouped run, its reply and marker.
  assert.deepEqual(
    whole.slice(0, 5).map((i) => [i.key, i.kind]),
    [
      ['u0', 'user'],
      ['i1', 'init'],
      ['gc2.0', 'toolGroup'],
      ['a6.0', 'assistant'],
      ['r7', 'meta'],
    ],
  )
  const firstMarker = whole.find((i) => i.kind === 'meta' && i.turn)
  assert.ok(firstMarker && firstMarker.kind === 'meta' && firstMarker.text.includes('$0.1000'))
  assert.equal(firstMarker.kind === 'meta' && firstMarker.changes, 1)
  assert.deepEqual(buildTranscript(log, undefined, { base: 0, midway: false }), whole)

  // Page it in from the newest end, 10 events at a time, the way the store does.
  const pageBefore = serverPages(log, 10)
  const newest = pageBefore(log.length + 1)
  let { events, range } = joinNewest(undefined, undefined, newest)
  assert.ok(range && range.hasEarlier)
  let r: LoadedRange = range
  while (r.hasEarlier) {
    const older = pageBefore(r.firstSeq)
    ;({ events, range: r } = prependOlder(events, r, older))
  }
  assert.equal(r.firstSeq, 1)
  assert.deepEqual(events, log)
  assert.deepEqual(buildTranscript(events, undefined, { base: r.firstSeq - 1, midway: r.hasEarlier }), whole)
})

test('the newest page folds with the same keys the whole log gives those events', () => {
  const log = session(6)
  const whole = buildTranscript(log)
  const page = serverPages(log, 20)(log.length + 1)
  assert.ok(page.firstSeq && page.firstSeq > 1)
  const base = page.firstSeq - 1
  const part = buildTranscript(page.events, undefined, { base, midway: true })
  const tail = whole.filter((i) => eventIndexOf(i) >= base)
  // midway leaves the opening init card off; the page has no other init card to draw
  assert.deepEqual(keys(part), keys(tail).filter((k) => !k.startsWith('i')))
  // every key names its event's place in the whole log
  for (const item of part) assert.equal(log[eventIndexOf(item)], page.events[eventIndexOf(item) - base])
})

test('midway: no opening init card, no cost on the first marker, no changeset on any marker', () => {
  const log = session(4)
  const base = 16 // turns 3 and 4
  const part = buildTranscript(log.slice(base), undefined, { base, midway: true })
  assert.equal(part.filter((i) => i.kind === 'init').length, 0)
  const markers = part.filter((i): i is Extract<TranscriptItem, { kind: 'meta' }> => i.kind === 'meta' && !!i.turn)
  assert.equal(markers.length, 2)
  // cumulative $0.30 would read as one turn's spend: left off
  assert.ok(!markers[0].text.includes('$'), markers[0].text)
  assert.equal(markers[0].stats, '2.0s · 3 turns')
  // the next one is a step from the first: right
  assert.ok(markers[1].text.includes('$0.1000'), markers[1].text)
  assert.ok(markers.every((m) => m.changes === undefined))
})

test('midway: a fresh subprocess starts the count over, so its first cost shows', () => {
  const part = buildTranscript([you('a'), turnEnd(4.2), { kind: 'subprocess', fresh: true }, you('b'), turnEnd(0.5)], undefined, { base: 40, midway: true })
  const markers = part.filter((i): i is Extract<TranscriptItem, { kind: 'meta' }> => i.kind === 'meta' && !!i.turn)
  assert.ok(!markers[0].text.includes('$'))
  assert.ok(markers[1].text.includes('$0.5000'), markers[1].text)
  assert.equal(part[0].key, 'u40')
})

test('joinNewest: the first page stands alone; an empty session has no range', () => {
  const page = { events: session(1), hasEarlier: true, firstSeq: 33 }
  const { events, range } = joinNewest(undefined, undefined, page)
  assert.equal(events, page.events)
  assert.deepEqual(range, { firstSeq: 33, hasEarlier: true, dense: 8 })
  assert.deepEqual(joinNewest(session(1), range!, { events: [], hasEarlier: false }), { events: [], range: null })
})

test('joinNewest: a reconnect keeps the older pages already held', () => {
  const log = session(6) // seqs 1..48
  const held = log.slice(8) // seqs 9..48, all from pages
  const range: LoadedRange = { firstSeq: 9, hasEarlier: true, dense: 40 }
  // the new newest page starts at seq 41 (index 40), and the log grew by a turn
  const grown = [...log, ...turn(7, 0.7)]
  const page = { events: grown.slice(40), hasEarlier: true, firstSeq: 41 }
  const out = joinNewest(held, range, page)
  assert.deepEqual(out.events, grown.slice(8))
  assert.deepEqual(out.range, { firstSeq: 9, hasEarlier: true, dense: grown.length - 8 })
})

test('joinNewest: the same start replaces what was held; a start past the known part resets', () => {
  const log = session(3)
  const range: LoadedRange = { firstSeq: 9, hasEarlier: true, dense: 16 }
  const held = [...log.slice(8), say('a live line the log may not have kept')]
  const same = joinNewest(held, range, { events: log.slice(8), hasEarlier: true, firstSeq: 9 })
  assert.deepEqual(same.events, log.slice(8))
  assert.equal(same.range?.firstSeq, 9)
  // held runs seqs 9..24 then a live event of unknown seq: a page from seq 26 can't be lined up
  const reset = joinNewest(held, range, { events: session(1), hasEarlier: true, firstSeq: 26 })
  assert.equal(reset.events.length, 8)
  assert.deepEqual(reset.range, { firstSeq: 26, hasEarlier: true, dense: 8 })
  // a page that starts before what is held (the log was cut back) resets too
  const earlier = joinNewest(held, range, { events: log, hasEarlier: false, firstSeq: 1 })
  assert.deepEqual(earlier.range, { firstSeq: 1, hasEarlier: false, dense: log.length })
})

test('prependOlder: an older page goes in front; an empty one is the start', () => {
  const log = session(3)
  const range: LoadedRange = { firstSeq: 17, hasEarlier: true, dense: 8 }
  const held = [...log.slice(16), say('live')]
  const out = prependOlder(held, range, { events: log.slice(8, 16), hasEarlier: true, firstSeq: 9 })
  assert.deepEqual(out.events, [...log.slice(8), say('live')])
  assert.deepEqual(out.range, { firstSeq: 9, hasEarlier: true, dense: 16 })
  const start = prependOlder(out.events, out.range, { events: [], hasEarlier: false })
  assert.equal(start.events, out.events)
  assert.equal(start.range.hasEarlier, false)
  // seq 1 is the start, whatever the flag says
  assert.equal(prependOlder(out.events, out.range, { events: log.slice(0, 8), hasEarlier: true, firstSeq: 1 }).range.hasEarlier, false)
})
