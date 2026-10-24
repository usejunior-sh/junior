/**
 * File checkpoints and rewind for chats: the rewind_files frame as
 * server/ws/parse.ts validates it, the rules and words in
 * core/sessions/rewind.ts, and server/session/rewind-ops.ts over a fake
 * runtime and a fake agent. A dry run never reaches the real rewind; a real
 * one previews first, then writes one line and tells the agent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RewindResult, ServerMessage, SessionEvent } from '../shared/protocol.js'
import type { StoredSession } from '../core/store/types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'
import type { RewindOutcome } from '../server/providers/types.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-rewind-'))
process.env.JUNIOR_HOME = home
const { parseClientMessage } = await import('../server/ws/parse.js')
const { REWIND_MESSAGE_ID } = await import('../shared/protocol.js')
const rw = await import('../core/sessions/rewind.js')
const { rewindFilesOp } = await import('../server/session/rewind-ops.js')
const { LiveSession } = await import('../server/session/live-session.js')

const MID = '3f2b8c1e-9a4d-4e7b-8c21-5d6e7f809a1b'

// Parsing

test('parse: rewind_files is a dry run unless dryRun is exactly false', () => {
  assert.deepEqual(parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: MID }), { type: 'rewind_files', sessionId: 's1', messageId: MID, dryRun: true })
  assert.deepEqual(parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: MID, dryRun: true }), { type: 'rewind_files', sessionId: 's1', messageId: MID, dryRun: true })
  assert.deepEqual(parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: MID, dryRun: false }), { type: 'rewind_files', sessionId: 's1', messageId: MID, dryRun: false })
  // The destructive reading has to be spelled out exactly.
  for (const dryRun of ['false', 0, null, 'no', {}]) {
    assert.equal((parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: MID, dryRun }) as { dryRun: boolean }).dryRun, true, String(dryRun))
  }
})

test('parse: rewind_files needs a session and a UUID message id', () => {
  assert.equal(parseClientMessage({ type: 'rewind_files', messageId: MID }), null)
  assert.equal(parseClientMessage({ type: 'rewind_files', sessionId: '', messageId: MID }), null)
  assert.equal(parseClientMessage({ type: 'rewind_files', sessionId: 7, messageId: MID }), null)
  assert.equal(parseClientMessage({ type: 'rewind_files', sessionId: 's1' }), null)
  assert.equal(parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: 'abc' }), null)
  assert.equal(parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: `${MID} ` }), null)
  assert.equal(parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: `${MID}\n--force` }), null)
  assert.equal(parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: 42 }), null)
  // One spelling of an id: lowercase, the way Junior writes them.
  assert.equal((parseClientMessage({ type: 'rewind_files', sessionId: 's1', messageId: MID.toUpperCase() }) as { messageId: string }).messageId, MID)
})

// Rules and words

const gate = (over: Partial<Parameters<typeof rw.rewindRefusal>[0]> = {}) =>
  rw.rewindRefusal({ exists: true, checkpoints: true, agentLabel: 'Claude Code', kind: 'chat', dryRun: true, busy: false, freshNext: false, ...over })

test('refusal: who may rewind, and when', () => {
  assert.equal(gate(), null)
  assert.equal(gate({ dryRun: false }), null)
  assert.equal(gate({ exists: false }), 'That chat is gone.')
  assert.equal(gate({ checkpoints: false, agentLabel: 'Codex' }), "File rewind isn't supported on Codex chats.")
  assert.match(gate({ kind: 'job-run' }) ?? '', /Only chats/)
  assert.match(gate({ kind: 'brief' }) ?? '', /Only chats/)
  assert.match(gate({ freshNext: true }) ?? '', /starts fresh/)
  // Looking is fine mid-turn; putting files back is not.
  assert.equal(gate({ busy: true }), null)
  assert.match(gate({ busy: true, dryRun: false }) ?? '', /Stop it first/)
})

test('findRewindTarget: only a local_user event carrying the id', () => {
  const evs: SessionEvent[] = [
    { kind: 'notice', text: MID },
    { kind: 'local_user', text: 'first' },
    { kind: 'local_user', text: 'fix the login page', messageId: MID },
  ]
  assert.deepEqual(rw.findRewindTarget(evs, MID), { text: 'fix the login page' })
  assert.deepEqual(rw.findRewindTarget(evs.map((event, i) => ({ seq: i + 1, event })), MID), { text: 'fix the login page', seq: 3 })
  assert.equal(rw.findRewindTarget(evs, '00000000-0000-4000-8000-000000000000'), null)
})

test('toRewindResult: keeps what the agent set, says why on a refusal', () => {
  const req = { sessionId: 's1', messageId: MID, dryRun: true }
  assert.deepEqual(rw.toRewindResult(req, { canRewind: true, filesChanged: ['/p/a.ts'], insertions: 3, deletions: 1 }), {
    ...req,
    ok: true,
    filesChanged: ['/p/a.ts'],
    insertions: 3,
    deletions: 1,
  })
  assert.deepEqual(rw.toRewindResult(req, { canRewind: false, error: 'No file checkpoint found for this message.' }), {
    ...req,
    ok: false,
    error: 'No file checkpoint found for this message.',
  })
  assert.equal(rw.toRewindResult(req, { canRewind: false }).error, 'Junior could not rewind these files.')
  // Junk counts are dropped, not passed on.
  const r = rw.toRewindResult({ ...req, dryRun: false }, { canRewind: true, insertions: -1, deletions: Number.NaN, skippedLinks: 0 })
  assert.deepEqual(r, { ...req, dryRun: false, ok: true })
})

test('notice and agent note: short, with paths relative to the chat', () => {
  const target = { text: 'Fix the login page\nand the footer' }
  assert.equal(rw.rewindNotice(target, [], '/p'), 'Files rewound to before “Fix the login page and the footer”. Nothing needed changing.')
  assert.equal(rw.rewindNotice(target, ['/p/src/a.ts'], '/p'), 'Files rewound to before “Fix the login page and the footer”. 1 file put back: src/a.ts.')
  assert.equal(
    rw.rewindNotice({ text: 'x' }, ['/p/a', '/p/b', '/p/c', '/p/d', '/p/e', '/elsewhere/f'], '/p', 2),
    'Files rewound to before “x”. 6 files put back: a, b, c, d and 2 more. 2 linked files were left alone.',
  )
  assert.equal(rw.quoteOf('a'.repeat(100), 10), `“${'a'.repeat(9)}…”`)
  assert.equal(rw.quoteOf('   '), 'your message')
  const note = rw.agentRewindNote(target, ['/p/src/a.ts'], '/p')
  assert.match(note, /^Note from Junior: the user rewound the files/)
  assert.match(note, /Files put back: src\/a\.ts\./)
  assert.match(note, /Read a file again before you change it\.$/)
})

// The op, over a fake runtime and agent

type Call = { messageId: string; dryRun: boolean }

function fakeSession(opts: { busy?: boolean; checkpoints?: boolean; answer?: (dryRun: boolean) => RewindOutcome | Promise<RewindOutcome> } = {}) {
  const calls: Call[] = []
  const notices: string[] = []
  const notes: string[] = []
  const session = {
    busy: opts.busy ?? false,
    checkpoints: opts.checkpoints ?? true,
    async rewindFiles(messageId: string, dryRun: boolean): Promise<RewindOutcome> {
      calls.push({ messageId, dryRun })
      return opts.answer ? opts.answer(dryRun) : dryRun ? { canRewind: true, filesChanged: ['/p/src/a.ts', '/p/b.md'], insertions: 4, deletions: 2 } : { canRewind: true }
    },
    notice: (t: string) => void notices.push(t),
    noteRewound: (t: string) => void notes.push(t),
  }
  return { session, calls, notices, notes }
}

function fakeRuntime(opts: { provider?: 'claude' | 'codex'; kind?: StoredSession['kind']; live?: unknown; events?: SessionEvent[]; freshNext?: boolean } = {}) {
  const sent: ServerMessage[] = []
  const invalidated: string[] = []
  const row = { id: 's1', provider: opts.provider ?? 'claude', kind: opts.kind ?? 'chat', cwd: '/p' } as unknown as StoredSession
  const events = opts.events ?? [{ kind: 'local_user', text: 'add a login page', messageId: MID } satisfies SessionEvent]
  const rt = {
    meta: { id: 'ws-test' },
    rows: new Map([['s1', row]]),
    live: new Map(opts.live ? [['s1', opts.live]] : []),
    freshNext: new Set(opts.freshNext ? ['s1'] : []),
    clients: new Set([{ readyState: 1, send: (d: string) => sent.push(JSON.parse(d)) }]),
    files: { invalidate: (cwd: string) => void invalidated.push(cwd) },
    store: { events: { read: async () => events.map((event, i) => ({ seq: i + 1, event, createdAt: 0 })) } },
  } as unknown as WorkspaceRuntime
  return { rt, sent, invalidated }
}

const noRevive = async () => {
  throw new Error('should not revive')
}

test('op: a dry run never calls the real rewind and writes nothing', async () => {
  const f = fakeSession()
  const { rt, sent, invalidated } = fakeRuntime({ live: f.session })
  const r = await rewindFilesOp(rt, { sessionId: 's1', messageId: MID, dryRun: true }, noRevive)
  assert.deepEqual(r, { sessionId: 's1', messageId: MID, dryRun: true, ok: true, filesChanged: ['/p/src/a.ts', '/p/b.md'], insertions: 4, deletions: 2 })
  assert.deepEqual(f.calls, [{ messageId: MID, dryRun: true }])
  assert.deepEqual(f.notices, [])
  assert.deepEqual(f.notes, [])
  assert.deepEqual(sent, [])
  assert.deepEqual(invalidated, [])
})

test('op: a real rewind previews, rewinds, writes one line and tells the agent', async () => {
  const f = fakeSession()
  const { rt, sent, invalidated } = fakeRuntime({ live: f.session })
  const r: RewindResult = await rewindFilesOp(rt, { sessionId: 's1', messageId: MID, dryRun: false }, noRevive)
  assert.deepEqual(r, { sessionId: 's1', messageId: MID, dryRun: false, ok: true, filesChanged: ['/p/src/a.ts', '/p/b.md'], insertions: 4, deletions: 2 })
  assert.deepEqual(f.calls, [
    { messageId: MID, dryRun: true },
    { messageId: MID, dryRun: false },
  ])
  assert.deepEqual(f.notices, ['Files rewound to before “add a login page”. 2 files put back: src/a.ts, b.md.'])
  assert.equal(f.notes.length, 1)
  assert.deepEqual(invalidated, ['/p'])
  assert.deepEqual(sent, [{ type: 'session_changed', sessionId: 's1' }])
})

test('op: a preview that says no stops before the real rewind', async () => {
  const f = fakeSession({ answer: (dry) => (dry ? { canRewind: false, error: 'No file checkpoint found for this message.' } : { canRewind: true }) })
  const { rt } = fakeRuntime({ live: f.session })
  const r = await rewindFilesOp(rt, { sessionId: 's1', messageId: MID, dryRun: false }, noRevive)
  assert.equal(r.ok, false)
  assert.equal(r.dryRun, false)
  assert.equal(r.error, 'No file checkpoint found for this message.')
  assert.deepEqual(f.calls, [{ messageId: MID, dryRun: true }])
  assert.deepEqual(f.notices, [])
})

test('op: the agent failing is a refusal, not a crash', async () => {
  const f = fakeSession({
    answer: (dry) => {
      if (dry) return { canRewind: true, filesChanged: [] }
      throw new Error('Failed to rewind: disk full')
    },
  })
  const { rt } = fakeRuntime({ live: f.session })
  const r = await rewindFilesOp(rt, { sessionId: 's1', messageId: MID, dryRun: false }, noRevive)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /disk full/)
  assert.deepEqual(f.notices, [])
})

test('op: a busy chat may preview but not rewind', async () => {
  const f = fakeSession({ busy: true })
  const { rt } = fakeRuntime({ live: f.session })
  assert.equal((await rewindFilesOp(rt, { sessionId: 's1', messageId: MID, dryRun: true }, noRevive)).ok, true)
  const r = await rewindFilesOp(rt, { sessionId: 's1', messageId: MID, dryRun: false }, noRevive)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /Stop it first/)
  assert.deepEqual(f.calls, [{ messageId: MID, dryRun: true }])
})

test('op: Codex chats, unknown messages and gone chats are refused without asking an agent', async () => {
  const codex = fakeRuntime({ provider: 'codex' })
  assert.equal((await rewindFilesOp(codex.rt, { sessionId: 's1', messageId: MID, dryRun: true }, noRevive)).error, "File rewind isn't supported on Codex chats.")
  const f = fakeSession()
  const other = fakeRuntime({ live: f.session, events: [{ kind: 'local_user', text: 'old message' }] })
  assert.match((await rewindFilesOp(other.rt, { sessionId: 's1', messageId: MID, dryRun: true }, noRevive)).error ?? '', /no file checkpoint/)
  assert.equal((await rewindFilesOp(other.rt, { sessionId: 'nope', messageId: MID, dryRun: true }, noRevive)).error, 'That chat is gone.')
  assert.deepEqual(f.calls, [])
})

test('op: a chat with no subprocess is revived to reach its checkpoints', async () => {
  const f = fakeSession()
  const { rt } = fakeRuntime()
  let revived = 0
  const r = await rewindFilesOp(rt, { sessionId: 's1', messageId: MID, dryRun: true }, async () => {
    revived += 1
    return f.session as never
  })
  assert.equal(r.ok, true)
  assert.equal(revived, 1)
  // One that starts fresh next has nothing to revive into.
  const fresh = fakeRuntime({ freshNext: true })
  assert.match((await rewindFilesOp(fresh.rt, { sessionId: 's1', messageId: MID, dryRun: true }, noRevive)).error ?? '', /starts fresh/)
})

// The live session's side: a turn id only where checkpoints are kept

test('live session: user turns get a UUID only when the subprocess keeps checkpoints', () => {
  const turnId = (LiveSession.prototype as unknown as { turnId: () => string | undefined }).turnId
  const id = turnId.call({ q: { rewindFiles: async () => ({ canRewind: true }) } })
  assert.ok(id && REWIND_MESSAGE_ID.test(id))
  assert.equal(turnId.call({ q: {} }), undefined)
})
