import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noteWork, parseWorklog, recentWork, serializeWorklog, WORKLOG_KEEP_DAYS, WORKLOG_MAX, WORKLOG_PROMPT_MAX, worklogAppend, worklogLine, type WorklogEntry } from '../core/junior/worklog.js'

const DAY = 86_400_000
const now = new Date(2026, 10, 14, 12).getTime()
const entry = (id: string, at: number, extra: Partial<WorklogEntry> = {}): WorklogEntry => ({ sessionId: id, title: `Thread ${id}`, said: `Did ${id}.`, at, ...extra })

test('a thread that reports again replaces its entry and moves to the top', () => {
  let log = noteWork([], entry('a', now - 3000), now)
  log = noteWork(log, entry('b', now - 2000), now)
  log = noteWork(log, entry('a', now - 1000, { said: 'Fixed it.' }), now)
  assert.deepEqual(
    log.map((e) => [e.sessionId, e.said]),
    [
      ['a', 'Fixed it.'],
      ['b', 'Did b.'],
    ],
  )
})

test('old entries and entries past the cap go', () => {
  const old = entry('old', now - (WORKLOG_KEEP_DAYS + 1) * DAY)
  assert.equal(noteWork([old], entry('new', now), now).length, 1)
  let log: WorklogEntry[] = []
  for (let i = 0; i < WORKLOG_MAX + 5; i++) log = noteWork(log, entry(`s${i}`, now - i * 1000), now)
  assert.equal(log.length, WORKLOG_MAX)
  assert.equal(log[0].sessionId, 's0')
})

test('text is folded to one line and cut', () => {
  const [e] = noteWork([], entry('a', now, { title: 'Fix\n  the   box', said: 'x'.repeat(500) }), now)
  assert.equal(e.title, 'Fix the box')
  assert.ok(e.said.length <= 240 && e.said.endsWith('…'))
})

test('the file round-trips; bad rows are dropped and named', () => {
  const log = [entry('a', now, { agent: 'Reviewer' }), entry('b', now - 1)]
  assert.deepEqual(parseWorklog(serializeWorklog(log)).entries, log)
  const bad = parseWorklog(JSON.stringify([entry('ok', now), { ...entry('x', now), extra: 1 }, { sessionId: 'y', title: 't', said: 's', at: 'nope' }]))
  assert.deepEqual(
    bad.entries.map((e) => e.sessionId),
    ['ok'],
  )
  assert.equal(bad.errors.length, 2)
  assert.deepEqual(parseWorklog('{').errors, ['not JSON'])
})

test('the prompt carries the last week, at most the cap, and nothing when empty', () => {
  assert.equal(worklogAppend([], now), '')
  const log = [entry('recent', now - DAY), entry('older', now - 10 * DAY)]
  const text = worklogAppend(log, now)
  assert.match(text, /## Work log/)
  assert.match(text, /- 2026-11-13 · Thread recent: Did recent\./)
  assert.doesNotMatch(text, /older/)
  const many = Array.from({ length: 40 }, (_, i) => entry(`s${i}`, now - i * 1000))
  assert.equal(recentWork(many, now).length, WORKLOG_PROMPT_MAX)
})

test('a line names the agent when there is one', () => {
  assert.equal(worklogLine(entry('a', now, { agent: 'Reviewer', title: 'Review #512' })), '- 2026-11-14 · Review #512 (Reviewer): Did a.')
})
