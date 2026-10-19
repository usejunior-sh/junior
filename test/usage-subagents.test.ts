/**
 * Subagent spend (core/usage): a subagent writes its own transcript under
 * `<session>/subagents/`, with the parent's sessionId on every line. The
 * ledger has to find those files, or a session that fans out reads as a
 * fraction of what it cost.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetUsageCache, scanUsage } from '../core/usage/ledger.js'
import { summarizeBySession } from '../core/usage/summary.js'

const line = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-1',
    requestId: `req-${id}`,
    timestamp: new Date().toISOString(),
    cwd: '/repo',
    message: { id: `msg-${id}`, model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 1000 } },
    ...extra,
  })

test("a session's spend includes its subagents', split out", async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-'))
  const slug = join(root, '-repo')
  await mkdir(join(slug, 'sess-1', 'subagents'), { recursive: true })
  await mkdir(join(slug, 'sess-1', 'tool-results'), { recursive: true })
  await writeFile(join(slug, 'sess-1.jsonl'), [line('m1'), line('m2')].join('\n'))
  await writeFile(
    join(slug, 'sess-1', 'subagents', 'agent-a1.jsonl'),
    [line('s1', { isSidechain: true, agentId: 'a1' }), line('s2', { isSidechain: true, agentId: 'a1' }), line('s3', { isSidechain: true, agentId: 'a1' })].join('\n'),
  )
  resetUsageCache()
  const { entries } = await scanUsage([root], 0)
  assert.equal(entries.length, 5)
  const spend = summarizeBySession(entries).get('sess-1')!
  assert.equal(spend.messages, 5)
  assert.equal(spend.subagents?.messages, 3)
  assert.ok(Math.abs(spend.subagents!.cost - (spend.cost * 3) / 5) < 1e-9)
})

test('a message written over several lines counts once, at its fullest output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-'))
  const slug = join(root, '-repo')
  await mkdir(slug, { recursive: true })
  const block = (output: number) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-2',
      requestId: 'req-x',
      timestamp: new Date().toISOString(),
      message: { id: 'msg-x', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: output } },
    })
  // Claude Code's line per content block: the first can carry an output count that isn't final.
  await writeFile(join(slug, 'sess-2.jsonl'), [block(12), block(12), block(840)].join('\n'))
  resetUsageCache()
  const { entries } = await scanUsage([root], 0)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].output, 840)
})

test("a session's spend includes its workflow agents', split out from its subagents", async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-'))
  const slug = join(root, '-repo')
  const run = join(slug, 'sess-1', 'subagents', 'workflows', 'wf_1')
  await mkdir(run, { recursive: true })
  await writeFile(join(slug, 'sess-1.jsonl'), line('m1'))
  await writeFile(join(slug, 'sess-1', 'subagents', 'agent-a1.jsonl'), line('s1', { isSidechain: true, agentId: 'a1' }))
  await writeFile(join(run, 'agent-w1.jsonl'), [line('w1', { isSidechain: true, agentId: 'w1' }), line('w2', { isSidechain: true, agentId: 'w1' })].join('\n'))
  await writeFile(join(run, 'agent-w2.jsonl'), line('w3', { isSidechain: true, agentId: 'w2' }))
  // The journal and meta files sit beside them and are not transcripts.
  await writeFile(join(run, 'journal.jsonl'), JSON.stringify({ type: 'result', agentId: 'w1', result: 'ok' }))
  await writeFile(join(run, 'agent-w1.meta.json'), JSON.stringify({ description: 'w1' }))
  resetUsageCache()
  const { entries } = await scanUsage([root], 0)
  assert.equal(entries.length, 5)
  assert.equal(entries.filter((e) => e.workflow).length, 3)
  const spend = summarizeBySession(entries).get('sess-1')!
  assert.equal(spend.messages, 5)
  assert.equal(spend.subagents?.messages, 1)
  assert.equal(spend.workflows?.messages, 3)
  assert.equal(spend.workflows?.tokens, 3 * 2000)
  assert.ok(Math.abs(spend.workflows!.cost - (spend.cost * 3) / 5) < 1e-9)
})

test('a session with no workflow runs has no workflow split', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-'))
  const slug = join(root, '-repo')
  await mkdir(join(slug, 'sess-1', 'subagents'), { recursive: true })
  await writeFile(join(slug, 'sess-1.jsonl'), line('m1'))
  await writeFile(join(slug, 'sess-1', 'subagents', 'agent-a1.jsonl'), line('s1', { isSidechain: true }))
  resetUsageCache()
  const { entries } = await scanUsage([root], 0)
  assert.ok(entries.every((e) => !('workflow' in e)))
  const spend = summarizeBySession(entries).get('sess-1')!
  assert.equal(spend.workflows, undefined)
  assert.equal(spend.subagents?.messages, 1)
})
