/**
 * Ultracode workflows: the fold over a session's events (core/workflows/fold.ts)
 * and the disk reader behind the run panel (server/workflows.ts). The events are
 * copied from a real run (two haiku agents, "alpha-beta"), trimmed; the files
 * mirror what that run left under its session folder, in a temp dir.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentCounts, buildWorkflows, currentPhase, workflowElapsedMs } from '../core/workflows/fold.js'
import { findRunFiles, readAgentTranscript, readWorkflowDetail, unframePrompt, type RunFiles } from '../server/workflows.js'
import { costOf } from '../core/usage/pricing.js'
import type { SdkMessage, SessionEvent, WorkflowProgressEntry } from '../shared/protocol.js'

const SID = '8e11768b-1e3a-49c4-9f45-e0da4e00f0dd'
const TOOL = 'toolu_01PrhLAho111tonCaG59owdJ'
const TASK = 'wntvlfsk4'
const RUN = 'wf_250aeac1-b84'
const SCRIPT = `export const meta = {
  name: 'alpha-beta',
  description: 'Two parallel haiku agents return alpha and beta',
  phases: [{ title: 'Run' }],
}
phase('Run')
const r = await parallel([
  () => agent('Return exactly the word: alpha', {label: 'alpha', phase: 'Run', model: 'haiku', effort: 'low'}),
  () => agent('Return exactly the word: beta', {label: 'beta', phase: 'Run', model: 'haiku', effort: 'low'}),
])
return r`

const sdk = (message: SdkMessage): SessionEvent => ({ kind: 'sdk', message })

/** The session folder the CLI reported, rebased onto `root`. */
const paths = (root: string) => {
  const session = join(root, '-private-tmp-ucprobe-work', SID)
  return {
    session,
    transcriptDir: join(session, 'subagents', 'workflows', RUN),
    scriptPath: join(session, 'workflows', 'scripts', `alpha-beta-${RUN}.js`),
  }
}

const launch = sdk({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: TOOL, name: 'Workflow', input: { script: SCRIPT } }] },
})
const started = sdk({
  type: 'system',
  subtype: 'task_started',
  task_id: TASK,
  tool_use_id: TOOL,
  description: 'Two parallel haiku agents return alpha and beta',
  task_type: 'local_workflow',
  workflow_name: 'alpha-beta',
})
const agentEntry = (index: number, label: string, extra: Partial<WorkflowProgressEntry & { type: 'workflow_agent' }>): WorkflowProgressEntry => ({
  type: 'workflow_agent',
  index,
  label,
  phaseIndex: 1,
  phaseTitle: 'Run',
  promptPreview: `Return exactly the word: ${label}`,
  ...extra,
})
const progress = (agents: WorkflowProgressEntry[], tokens: number) =>
  sdk({
    type: 'system',
    subtype: 'task_progress',
    task_id: TASK,
    tool_use_id: TOOL,
    description: 'Run: alpha',
    usage: { total_tokens: tokens, tool_uses: 0, duration_ms: 1126 },
    last_tool_name: 'alpha',
    summary: 'Two parallel haiku agents return alpha and beta',
    workflow_progress: [{ type: 'workflow_phase', index: 1, title: 'Run' }, ...agents],
  })
const firstSnapshot = progress(
  [
    agentEntry(1, 'alpha', { agentId: 'ad09cddd29f8964ed', model: 'claude-haiku-5-5', state: 'start', startedAt: 1792423867940, queuedAt: 1792423867937, attempt: 1 }),
    agentEntry(2, 'beta', { model: 'haiku', state: 'start', queuedAt: 1792423867938 }),
  ],
  0,
)
const receipt = (root: string) => {
  const p = paths(root)
  return sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: TOOL,
          content: `Workflow launched in background. Task ID: ${TASK}\nSummary: Two parallel haiku agents return alpha and beta\nTranscript dir: ${p.transcriptDir}\nScript file: ${p.scriptPath}\nRun ID: ${RUN}\n\nYou will be notified when it completes.`,
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      status: 'async_launched',
      taskId: TASK,
      taskType: 'local_workflow',
      workflowName: 'alpha-beta',
      runId: RUN,
      summary: 'Two parallel haiku agents return alpha and beta',
      transcriptDir: p.transcriptDir,
      scriptPath: p.scriptPath,
    },
  })
}
const alphaDone = progress(
  [
    agentEntry(1, 'alpha', {
      agentId: 'ad09cddd29f8964ed',
      model: 'claude-haiku-5-5',
      state: 'done',
      startedAt: 1792423867940,
      lastProgressAt: 1792423869031,
      tokens: 18008,
      toolCalls: 0,
      durationMs: 1091,
      resultPreview: 'alpha',
    }),
    agentEntry(2, 'beta', { agentId: 'afe4a7db0d6c85f82', model: 'claude-haiku-5-5', state: 'start', startedAt: 1792423867940, lastToolName: 'Bash', lastToolSummary: 'echo beta' }),
  ],
  18008,
)
const bothDone = progress(
  [
    agentEntry(1, 'alpha', { agentId: 'ad09cddd29f8964ed', model: 'claude-haiku-5-5', state: 'done', startedAt: 1792423867940, tokens: 18008, resultPreview: 'alpha' }),
    agentEntry(2, 'beta', { agentId: 'afe4a7db0d6c85f82', model: 'claude-haiku-5-5', state: 'done', startedAt: 1792423867940, tokens: 18007, resultPreview: 'beta' }),
  ],
  36015,
)
const updated = sdk({ type: 'system', subtype: 'task_updated', task_id: TASK, patch: { status: 'completed', end_time: 1792423870191 } })
const notified = sdk({
  type: 'system',
  subtype: 'task_notification',
  task_id: TASK,
  tool_use_id: TOOL,
  status: 'completed',
  summary: 'Dynamic workflow "Two parallel haiku agents return alpha and beta" completed',
  usage: { total_tokens: 36015, tool_uses: 0, duration_ms: 2261 },
})

const ROOT = '/Users/me/.claude/projects'

test('the launch receipt binds the run: running, with its task id, run id and files', () => {
  const [run] = buildWorkflows([launch, started, firstSnapshot, receipt(ROOT)])
  assert.equal(run.toolUseId, TOOL)
  assert.equal(run.state, 'running')
  assert.equal(run.taskId, TASK)
  assert.equal(run.runId, RUN)
  assert.equal(run.name, 'alpha-beta')
  assert.equal(run.summary, 'Two parallel haiku agents return alpha and beta')
  assert.equal(run.transcriptDir, paths(ROOT).transcriptDir)
  assert.equal(run.scriptPath, paths(ROOT).scriptPath)
  assert.equal(run.parentToolUseId, null)
})

test('a snapshot gives the phases and agents; the latest one wins', () => {
  const [run] = buildWorkflows([launch, started, firstSnapshot, receipt(ROOT), alphaDone])
  assert.deepEqual(run.phases, [{ index: 1, title: 'Run' }])
  assert.equal(run.agents.length, 2)
  const [alpha, beta] = run.agents
  assert.equal(alpha.state, 'done')
  assert.equal(alpha.resultPreview, 'alpha')
  assert.equal(alpha.tokens, 18008)
  assert.equal(beta.state, 'running')
  assert.equal(beta.agentId, 'afe4a7db0d6c85f82')
  assert.equal(beta.activity, 'Bash · echo beta')
  assert.equal(run.tokens, 18008)
  assert.deepEqual({ done: agentCounts(run).done, running: agentCounts(run).running, total: agentCounts(run).total }, { done: 1, running: 1, total: 2 })
  assert.equal(currentPhase(run)?.title, 'Run')
})

test('the notification ends it: done, with the totals the CLI counted', () => {
  const [run] = buildWorkflows([launch, started, firstSnapshot, receipt(ROOT), alphaDone, bothDone, updated, notified])
  assert.equal(run.state, 'done')
  assert.equal(run.endedAt, 1792423870191)
  assert.equal(run.tokens, 36015)
  assert.equal(run.durationMs, 2261)
  assert.equal(agentCounts(run).done, 2)
  assert.equal(run.error, undefined)
})

test('a new subprocess interrupts a run still going, and its running agents with it', () => {
  const [run] = buildWorkflows([launch, started, firstSnapshot, receipt(ROOT), alphaDone, { kind: 'subprocess' }])
  assert.equal(run.state, 'interrupted')
  assert.equal(run.agents[0].state, 'done')
  assert.equal(run.agents[1].state, 'interrupted')
  // Nothing after the revival brings it back.
  const [later] = buildWorkflows([launch, started, firstSnapshot, receipt(ROOT), { kind: 'subprocess' }, notified])
  assert.equal(later.state, 'interrupted')
})

test('a refused launch fails the card with the reason', () => {
  const refused = sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: TOOL, content: 'The user doesn\'t want to proceed with this tool use.', is_error: true }],
    },
  })
  const [run] = buildWorkflows([launch, refused])
  assert.equal(run.state, 'failed')
  assert.equal(run.taskId, undefined)
  assert.equal(run.launched, false)
  assert.match(run.error ?? '', /doesn't want to proceed/)
})

test('the clock starts at launch, not at the call: a prompt wait does not count', () => {
  const r = receipt(ROOT)
  const times = new Map<SessionEvent, number>([
    [launch, 1_000],
    [started, 158_000],
    [r, 158_100],
  ])
  const [unlaunched] = buildWorkflows([launch], (ev) => times.get(ev))
  assert.equal(unlaunched.launched, false)
  assert.equal(unlaunched.requestedAt, 1_000)
  assert.equal(unlaunched.startedAt, undefined)
  assert.equal(workflowElapsedMs(unlaunched, 200_000), undefined)
  const [run] = buildWorkflows([launch, started, r], (ev) => times.get(ev))
  assert.equal(run.launched, true)
  assert.equal(run.requestedAt, 1_000)
  assert.equal(run.startedAt, 158_000)
  assert.equal(workflowElapsedMs(run, 160_000), 2_000)
})

test('the receipt alone launches a run, and its time starts the clock', () => {
  const r = receipt(ROOT)
  const [run] = buildWorkflows([launch, r], (ev) => (ev === launch ? 5 : ev === r ? 90 : undefined))
  assert.equal(run.launched, true)
  assert.equal(run.startedAt, 90)
})

test('a settled run shows the CLI duration over its own clock', () => {
  const [run] = buildWorkflows([launch, started, receipt(ROOT), bothDone, updated, notified], (ev) => (ev === started ? 1792423000000 : undefined))
  assert.equal(workflowElapsedMs(run, Date.now()), 2261)
})

test('a call waiting on its permission prompt is unlaunched and awaiting your OK until answered', () => {
  const ask: SessionEvent = { kind: 'permission_request', id: 'p1', toolName: 'Workflow', input: {}, toolUseId: TOOL }
  const ok: SessionEvent = { kind: 'permission_resolved', id: 'p1', behavior: 'allow' }
  const [waiting] = buildWorkflows([launch, ask])
  assert.equal(waiting.state, 'running')
  assert.equal(waiting.launched, false)
  assert.equal(waiting.awaitingOk, true)
  const [allowed] = buildWorkflows([launch, ask, ok])
  assert.equal(allowed.launched, false)
  assert.equal(allowed.awaitingOk, undefined)
  const [run] = buildWorkflows([launch, ask, ok, started, receipt(ROOT)])
  assert.equal(run.launched, true)
  assert.equal(run.awaitingOk, undefined)
  // The prompt may land before the call it asks about; an older log's prompt has no toolUseId.
  assert.equal(buildWorkflows([ask, launch])[0].awaitingOk, true)
  const legacy: SessionEvent = { kind: 'permission_request', id: 'p2', toolName: 'Workflow', input: {} }
  assert.equal(buildWorkflows([launch, legacy])[0].awaitingOk, true)
})

test("an agent the CLI says 'start' for without a start time is still queued", () => {
  const [run] = buildWorkflows([launch, started, firstSnapshot, receipt(ROOT)])
  assert.equal(run.agents[0].state, 'running')
  assert.equal(run.agents[1].state, 'queued')
  assert.deepEqual({ running: agentCounts(run).running, queued: agentCounts(run).queued }, { running: 1, queued: 1 })
})

test('a receipt with only text still gives the task id, which rides on its first line', () => {
  const textOnly = sdk({ ...(receipt(ROOT) as { message: SdkMessage }).message, tool_use_result: undefined })
  const [run] = buildWorkflows([launch, textOnly])
  assert.equal(run.taskId, TASK)
  assert.equal(run.runId, RUN)
  assert.equal(run.state, 'running')
})

test('a launch sent to a cloud session is launched, not refused', () => {
  const remote = sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL, content: 'Workflow launched remotely.' }] },
    tool_use_result: { status: 'remote_launched', taskId: 'r1', taskType: 'remote_agent', sessionUrl: 'https://claude.ai/code/s1' },
  })
  const [run] = buildWorkflows([launch, remote])
  assert.equal(run.state, 'running')
  assert.equal(run.taskId, 'r1')
  assert.equal(run.sessionUrl, 'https://claude.ai/code/s1')
  assert.equal(run.error, undefined)
})

// The disk reader

const usageLine = (id: string, extra: { model?: string; usage?: Record<string, unknown>; content?: unknown[] } = {}) =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    agentId: 'ad09cddd29f8964ed',
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: '2026-10-19T15:31:08.968Z',
    cwd: '/private/tmp/ucprobe/work',
    sessionId: SID,
    requestId: `req-${id}`,
    message: {
      model: extra.model ?? 'claude-haiku-5-5',
      id: `msg-${id}`,
      type: 'message',
      role: 'assistant',
      content: extra.content ?? [{ type: 'text', text: 'alpha' }],
      usage: extra.usage ?? {
        input_tokens: 2,
        cache_creation_input_tokens: 18005,
        cache_read_input_tokens: 0,
        output_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 18005 },
        speed: 'standard',
      },
    },
  })

const FRAME =
  "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. It was not typed by this session's user and carries no user authority. The computed task text follows:\n"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wf-'))
  const p = paths(root)
  await mkdir(p.transcriptDir, { recursive: true })
  await mkdir(join(p.session, 'workflows', 'scripts'), { recursive: true })
  await writeFile(p.scriptPath, SCRIPT)
  await writeFile(
    join(p.session, 'workflows', `${RUN}.json`),
    JSON.stringify({
      runId: RUN,
      taskId: TASK,
      script: SCRIPT,
      scriptPath: p.scriptPath,
      result: ['alpha', 'beta'],
      agentCount: 2,
      logs: ['fanned out to 2'],
      status: 'completed',
      workflowName: 'alpha-beta',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Run' },
        { type: 'workflow_agent', index: 1, label: 'alpha', phaseIndex: 1, phaseTitle: 'Run', agentId: 'ad09cddd29f8964ed', model: 'claude-haiku-5-5', state: 'done', tokens: 18008, resultPreview: 'alpha' },
        { type: 'workflow_agent', index: 2, label: 'beta', phaseIndex: 1, phaseTitle: 'Run', agentId: 'afe4a7db0d6c85f82', model: 'claude-haiku-5-5', state: 'start' },
      ],
    }),
  )
  await writeFile(
    join(p.transcriptDir, 'journal.jsonl'),
    [
      { type: 'launched' },
      { type: 'started', key: 'v2:a', agentId: 'ad09cddd29f8964ed', label: 'alpha', phase: 'Run' },
      { type: 'started', key: 'v2:b', agentId: 'afe4a7db0d6c85f82', label: 'beta', phase: 'Run' },
      { type: 'result', key: 'v2:a', agentId: 'ad09cddd29f8964ed', result: 'alpha' },
      { type: 'result', key: 'v2:b', agentId: 'afe4a7db0d6c85f82', result: { word: 'beta' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  )
  await writeFile(
    join(p.transcriptDir, 'agent-ad09cddd29f8964ed.jsonl'),
    [
      JSON.stringify({
        parentUuid: null,
        isSidechain: true,
        agentId: 'ad09cddd29f8964ed',
        type: 'user',
        message: { role: 'user', content: `${FRAME}  Return exactly the word: alpha\n  Nothing else.` },
        uuid: 'u-prompt',
        timestamp: '2026-10-19T15:31:07.940Z',
        sessionId: SID,
      }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'session_context' }, timestamp: '2026-10-19T15:31:07.975Z', sessionId: SID }),
      JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'text', text: 'system prompt' }] } }),
      usageLine('a1', { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'echo alpha' } }] }),
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        uuid: 'u-res',
        timestamp: '2026-10-19T15:31:08.500Z',
        sessionId: SID,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'alpha' }] },
      }),
      // A message written over two lines counts once.
      usageLine('a2'),
      usageLine('a2'),
    ].join('\n'),
  )
  await writeFile(
    join(p.transcriptDir, 'agent-ad09cddd29f8964ed.meta.json'),
    JSON.stringify({ agentType: 'workflow-subagent', description: 'alpha', workflowPhase: 'Run', model: 'haiku' }),
  )
  await writeFile(join(p.transcriptDir, 'agent-afe4a7db0d6c85f82.jsonl'), usageLine('b1'))
  return { root, p }
}

const haikuCall = costOf('claude-haiku-5-5', { input: 2, output: 5, cacheWrite5m: 18005, cacheWrite1h: 0, cacheRead: 0 })!

test('the run files come from the event log, checked against the session folder', async () => {
  const { root, p } = await fixture()
  const events = [launch, started, firstSnapshot, receipt(root)]
  const files = (await findRunFiles(events, TASK, root, SID)) as RunFiles
  assert.equal(typeof files, 'object')
  assert.equal(files.runId, RUN)
  assert.equal(files.transcriptDir, p.transcriptDir)
  assert.equal(files.stateFile, join(p.session, 'workflows', `${RUN}.json`))
  assert.equal(files.scriptPath, p.scriptPath)

  assert.equal(await findRunFiles(events, 'nope', root, SID), 'no such workflow in this session')
  // Another session's folder, or a dir outside the projects root, is refused.
  assert.equal(typeof (await findRunFiles(events, TASK, root, 'another-session')), 'string')
  assert.equal(typeof (await findRunFiles(events, TASK, join(root, 'elsewhere'), SID)), 'string')
  assert.equal(typeof (await findRunFiles(events, TASK, root, null)), 'string')
  const forged = sdk({ ...(receipt(root) as { message: SdkMessage }).message, tool_use_result: { status: 'async_launched', taskId: TASK, runId: RUN, transcriptDir: `/etc/${SID}/subagents/workflows/${RUN}` } })
  assert.equal(typeof (await findRunFiles([launch, forged], TASK, root, SID)), 'string')
})

test("a run launched under an earlier Claude session id is still found after a fresh revival changed it", async () => {
  const { root, p } = await fixture()
  const init = sdk({ type: 'system', subtype: 'init', session_id: SID, tools: [] })
  const files = (await findRunFiles([init, launch, started, receipt(root)], TASK, root, 'a-newer-session')) as RunFiles
  assert.equal(typeof files, 'object')
  assert.equal(files.transcriptDir, p.transcriptDir)
})

test("the Script tab shows what the run executed, not the script file edited since", async () => {
  const { root, p } = await fixture()
  const files = (await findRunFiles([launch, receipt(root)], TASK, root, SID)) as RunFiles
  await writeFile(p.scriptPath, 'export const meta = { name: "edited" }')
  const d = await readWorkflowDetail(files)
  assert.equal(d.script, SCRIPT)
})

test('the detail: per-agent cost priced like the ledger, the script, result, logs and final state', async () => {
  const { root } = await fixture()
  const files = (await findRunFiles([launch, receipt(root)], TASK, root, SID)) as RunFiles
  const d = await readWorkflowDetail(files)
  assert.equal(d.runId, RUN)
  assert.equal(d.script, SCRIPT)
  assert.equal(d.result, JSON.stringify(['alpha', 'beta'], null, 2))
  assert.deepEqual(d.logs, ['fanned out to 2'])
  assert.equal(d.state, 'done')
  assert.deepEqual(Object.keys(d.agents).sort(), ['ad09cddd29f8964ed', 'afe4a7db0d6c85f82'])
  const alpha = d.agents.ad09cddd29f8964ed
  assert.equal(alpha.toolCalls, 1)
  assert.equal(alpha.model, 'claude-haiku-5-5')
  assert.equal(alpha.tokens, 2 * 18012)
  assert.ok(Math.abs(alpha.costUsd - 2 * haikuCall) < 1e-12)
  assert.ok(Math.abs(d.costUsd - 3 * haikuCall) < 1e-12)
  assert.deepEqual(d.phases, [{ index: 1, title: 'Run' }])
  // A finished run's state file can't leave an agent running.
  assert.deepEqual(
    d.runAgents?.map((a) => [a.label, a.state]),
    [
      ['alpha', 'done'],
      ['beta', 'stopped'],
    ],
  )
})

test("an agent's transcript: its task without the frame, its messages as main-agent events, its result", async () => {
  const { root } = await fixture()
  const files = (await findRunFiles([launch, receipt(root)], TASK, root, SID)) as RunFiles
  const t = await readAgentTranscript(files, 'ad09cddd29f8964ed')
  assert.ok(typeof t === 'object')
  assert.equal(t.prompt, 'Return exactly the word: alpha\nNothing else.')
  assert.equal(t.label, 'alpha')
  assert.equal(t.phase, 'Run')
  assert.equal(t.model, 'claude-haiku-5-5')
  assert.equal(t.result, 'alpha')
  assert.equal(t.events.length, 4)
  assert.equal(t.times.length, 4)
  assert.equal(t.times[0], Date.parse('2026-10-19T15:31:08.968Z'))
  for (const ev of t.events) {
    assert.equal(ev.kind, 'sdk')
    if (ev.kind === 'sdk') assert.equal(ev.message.parent_tool_use_id, null)
  }
  const first = t.events[0]
  assert.ok(first.kind === 'sdk' && first.message.type === 'assistant' && first.message.message?.content?.[0].type === 'tool_use')
  assert.ok(Math.abs(t.costUsd - 2 * haikuCall) < 1e-12)

  const beta = await readAgentTranscript(files, 'afe4a7db0d6c85f82')
  assert.ok(typeof beta === 'object')
  assert.equal(beta.result, JSON.stringify({ word: 'beta' }, null, 2))
  assert.equal(await readAgentTranscript(files, '../../etc'), 'not an agent id')
  assert.equal(await readAgentTranscript(files, 'a0000'), 'no such agent in this run')
})

test('a prompt with no harness frame is left as it is', () => {
  assert.equal(unframePrompt('  just this'), '  just this')
  assert.equal(unframePrompt(`${FRAME}  line one\n    indented`), 'line one\n  indented')
})
