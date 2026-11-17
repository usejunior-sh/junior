/**
 * Thread jobs (mode: thread): a job owned by an agent, each run a thread
 * from that agent's DM. The file's `agent:` and `mode:` keys, the owner
 * check, how a run's message is framed (never as the user's), the quiet
 * "Nothing new." reply, and put-away threads leaving the open list.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkOwner, parseJobFile, serializeJobFile, type JobFileSpec } from '../server/job-files.js'
import { builtinGrant } from '../core/job/tools.js'
import { frameJobMessage, isJobRunRow, isNothingNew, jobReplyReports, jobRunLine, jobThreadTitle, NOTHING_NEW } from '../core/job/thread.js'
import { buildTranscript } from '../web/src/transcript.js'
import { openThreads, type ThreadSession } from '../core/junior/threads.js'
import { reportsUp } from '../core/junior/thread-wake.js'

const threadJob: JobFileSpec = {
  id: 'j-1',
  title: 'Log check',
  schedule: '0 * * * *',
  agent: 'junior:debugger',
  mode: 'thread',
  project: 'p-1',
  tools: [],
  output: 'items',
  notify: 'on_failure',
  enabled: false,
  draft: true,
  instruction: 'Check the logs. If something is wrong, investigate and write the investigation report.',
}

test('a thread job survives the round trip, with no tools and no output', () => {
  const text = serializeJobFile(threadJob)
  assert.match(text, /^agent: "junior:debugger"$/m)
  assert.match(text, /^mode: thread$/m)
  assert.doesNotMatch(text, /^tools:/m)
  assert.doesNotMatch(text, /^output:/m)
  const back = parseJobFile('log-check', text)
  assert.deepEqual(back.errors, [])
  assert.deepEqual(back.spec, threadJob)
})

test('a file without mode is a scan, and a scan still needs a tool', () => {
  const text = '---\nid: j-2\ntitle: Old\nschedule: 0 9 * * *\nproject: p-1\n---\nFind things.\n'
  const back = parseJobFile('old', text)
  assert.equal(back.spec.mode, undefined)
  assert.ok(back.errors.some((e) => e.startsWith('tools must list')))
})

test('a scan job may have an owner too, and keeps its tools', () => {
  const scan: JobFileSpec = { ...threadJob, mode: undefined, tools: [builtinGrant('github')], agent: 'junior:reviewer' }
  delete scan.mode
  const back = parseJobFile('scan', serializeJobFile(scan))
  assert.deepEqual(back.errors, [])
  assert.equal(back.spec.agent, 'junior:reviewer')
  assert.equal(back.spec.mode, undefined)
})

test('a thread job refuses what only a scan uses', () => {
  const text = serializeJobFile({ ...threadJob, tools: [builtinGrant('web')], skills: ['junior:pr-review'] }).replace('mode: thread', 'mode: thread\noutput: digest\nbrief: true')
  const { errors } = parseJobFile('x', text)
  for (const want of ['tools are for mode: scan', 'output is for mode: scan', 'brief is for mode: scan', 'skills and agents are for mode: scan']) {
    assert.ok(errors.some((e) => e.startsWith(want)), want)
  }
})

test('mode and agent are checked', () => {
  const bad = parseJobFile('x', serializeJobFile(threadJob).replace('mode: thread', 'mode: loop').replace(/^agent: .*$/m, 'agent: [a, b]'))
  assert.ok(bad.errors.some((e) => e.startsWith('mode must be one of')))
  assert.ok(bad.errors.some((e) => e.startsWith('agent must be one chat agent')))
})

test('the owner must be a chat agent, by the name a chat stores', () => {
  assert.deepEqual(checkOwner(undefined, []), [])
  assert.deepEqual(checkOwner('junior:debugger', ['junior:debugger']), [])
  const [err] = checkOwner('debugger', ['junior:debugger', 'junior:reviewer'])
  assert.match(err, /no chat agent named "debugger" — the workspace library's is called junior:debugger/)
  assert.match(checkOwner('nope', [])[0], /no chat agent named "nope"$/)
})

test('a run’s message is framed as the job’s, never as the user’s', () => {
  const at = Date.UTC(2026, 10, 16, 14, 0)
  const text = frameJobMessage({ id: 'j-1', title: 'Log check', runAt: at, trigger: 'scheduled', every: 'every hour' }, 'Check the logs.')
  assert.match(text, /^\[Job run: "Log check", every hour\. Run on its schedule at 2026-11-16T14:00:00\.000Z\./)
  assert.match(text, /not a message the user typed/)
  assert.match(text, /reply with exactly "Nothing new\."/)
  assert.match(text, /call job_seen/)
  assert.match(text, /job_handled/)
  assert.ok(text.endsWith('\n\nCheck the logs.'), 'the instruction comes last, as written')
  const late = frameJobMessage({ id: 'j-1', title: 'Log check', runAt: at, trigger: 'catch_up', lateness: 'This run is 3h late.' }, 'x')
  assert.match(late, /as a catch-up/)
  assert.match(late, /This run is 3h late\./)
})

test('"Nothing new." is the quiet reply, however it is dressed', () => {
  assert.ok(isNothingNew(NOTHING_NEW))
  assert.ok(isNothingNew('nothing new'))
  assert.ok(isNothingNew('  **Nothing new.** No errors in the last hour.'))
  assert.ok(!isNothingNew('Found 2 new errors; nothing new otherwise.'))
  assert.ok(!isNothingNew('Nothing newer than yesterday failed.'))
})

test('a run’s thread is titled by its job and local time', () => {
  const at = new Date(2026, 10, 16, 9, 5).getTime()
  assert.equal(jobThreadTitle('PR reviews', at), 'PR reviews · 09:05')
})

test('a job’s thread counts as one of its runs; a plain chat does not', () => {
  assert.ok(isJobRunRow({ kind: 'job-run', jobId: 'j' }))
  assert.ok(isJobRunRow({ kind: 'chat', jobId: 'j' }))
  assert.ok(!isJobRunRow({ kind: 'chat', jobId: null }))
  assert.ok(!isJobRunRow({ kind: 'dm', jobId: 'j' }))
})

test('the run’s first message comes from the DM, so its reply reports up', () => {
  assert.ok(reportsUp('dm-1', 'dm-1'))
  assert.ok(!reportsUp('dm-1', undefined))
})

test('a put-away thread leaves the open threads, unless it waits on you', () => {
  const now = Date.now()
  const base = { status: 'idle', updatedAt: now - 60_000 }
  const sessions: ThreadSession[] = [
    { id: 'dm', title: 'Debugger', kind: 'dm', agent: 'junior:debugger', ...base },
    { id: 'quiet', title: 'Log check · 13:00', startedBy: 'dm', agent: 'junior:debugger', jobId: 'j', archived: true, ...base },
    { id: 'found', title: 'Log check · 14:00', startedBy: 'dm', agent: 'junior:debugger', jobId: 'j', ...base },
    { id: 'asks', title: 'Log check · 15:00', startedBy: 'dm', agent: 'junior:debugger', jobId: 'j', archived: true, ...base, waiting: true },
  ]
  const open = openThreads(sessions, now)
  assert.deepEqual(open.map((t) => t.id).sort(), ['asks', 'found'])
  assert.ok(open.every((t) => t.job))
})

test('only a real reply reports up; nothing new and an empty reply leave a quiet run line instead', () => {
  assert.ok(jobReplyReports('Reviewed #4425: safe to merge.'))
  assert.ok(jobReplyReports('No new PR requests from Lakhan in the last 2 hours.'))
  assert.ok(!jobReplyReports(NOTHING_NEW))
  assert.ok(!jobReplyReports('**Nothing new.**'))
  assert.ok(!jobReplyReports(''))
  assert.ok(!jobReplyReports('  \n'))
  assert.equal(jobRunLine('Log check · 14:00', 'nothing new'), 'Log check · 14:00 · nothing new')
})

test('a run line in the DM folds to a row that opens its thread; a plain notice stays a meta line', () => {
  const items = buildTranscript([
    { kind: 'notice', text: 'Log check · 14:00 · nothing new', thread: 't-1' },
    { kind: 'notice', text: 'A team paused' },
  ])
  assert.deepEqual(
    items.map((i) => (i.kind === 'runLine' ? [i.kind, i.text, i.thread] : [i.kind])),
    [['runLine', 'Log check · 14:00 · nothing new', 't-1'], ['meta']],
  )
})
