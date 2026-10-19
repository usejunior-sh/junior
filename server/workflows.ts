/**
 * What an Ultracode Workflow run left on disk, for the run panel and an
 * agent's transcript. The stream carries a run's phases and agents
 * (core/workflows/fold.ts); Claude Code writes the rest under the session's
 * own folder, `<projects>/<slug>/<sdkSessionId>/`:
 *
 *   workflows/<runId>.json                       final state, progress, result, logs
 *   workflows/scripts/<name>-<runId>.js          the script
 *   subagents/workflows/<runId>/journal.jsonl    one line per agent start and result
 *   subagents/workflows/<runId>/agent-<id>.jsonl each agent's transcript, with usage
 *   subagents/workflows/<runId>/agent-<id>.meta.json  its label, phase and model
 *
 * The paths come only from the session's own event log, through the same fold
 * the UI uses, never from the request, and each must sit in this session's
 * folder under the workspace's Claude projects dir. Reads are cached by
 * (size, mtime), so polling a running run re-reads only what changed.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { buildWorkflows, progressSnapshot, settled } from '../core/workflows/fold.js'
import { entryCost, isWorkflowAgentFile, usageEntryFrom, type UsageEntry } from '../core/usage/ledger.js'
import type {
  RawBlock,
  SdkMessage,
  SessionEvent,
  WorkflowAgent,
  WorkflowAgentCost,
  WorkflowAgentResponse,
  WorkflowAgentTranscript,
  WorkflowDetail,
  WorkflowDetailResponse,
} from '../shared/protocol.js'
import { claudeTranscriptDir } from './providers/claude-config.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

const SCRIPT_MAX_CHARS = 200_000
const RESULT_MAX_CHARS = 20_000
/** A runaway agent shouldn't send megabytes to a page that polls it. */
const TRANSCRIPT_MAX_EVENTS = 4000

const SAFE_ID = /^[\w-]+$/
const AGENT_ID = /^[a-z0-9]+$/

/** The files of one run, every path checked. */
export type RunFiles = {
  runId: string
  /** `subagents/workflows/<runId>`: the journal and the agents' transcripts. */
  transcriptDir: string
  /** `workflows/<runId>.json`. */
  stateFile: string
  scriptPath?: string
}

// Containment

async function rootsOf(projectsRoot: string): Promise<string[]> {
  const roots = [path.resolve(projectsRoot)]
  // The CLI may report the real path of a symlinked config dir.
  const real = await realpath(projectsRoot).catch(() => null)
  if (real && real !== roots[0]) roots.push(real)
  return roots
}

/** `file`'s parts below the projects root when it sits in `<slug>/<one of sdkSessionIds>/…`, else null. */
function partsUnder(roots: string[], file: string, sdkSessionIds: ReadonlySet<string>): string[] | null {
  const abs = path.resolve(file)
  for (const root of roots) {
    if (!abs.startsWith(root + path.sep)) continue
    const parts = path.relative(root, abs).split(path.sep)
    if (parts.length > 2 && parts[0] && parts[0] !== '..' && sdkSessionIds.has(parts[1])) return parts
  }
  return null
}

/**
 * Every Claude session id this session has run under: a revival without
 * resume starts a new one, and a run keeps the folder of the one that launched it.
 */
function sdkSessionIdsOf(events: readonly SessionEvent[], current: string | null): Set<string> {
  const ids = new Set<string>()
  if (current) ids.add(current)
  for (const ev of events) {
    if (ev.kind === 'sdk' && ev.message.type === 'system' && ev.message.subtype === 'init' && ev.message.session_id) ids.add(ev.message.session_id)
  }
  for (const id of ids) if (!SAFE_ID.test(id)) ids.delete(id)
  return ids
}

/**
 * Find the run `taskId` names in a session's events and check where its files
 * are: a string is why it can't be read.
 */
export async function findRunFiles(
  events: readonly SessionEvent[],
  taskId: string,
  projectsRoot: string,
  sdkSessionId: string | null,
): Promise<RunFiles | string> {
  const run = buildWorkflows(events).find((r) => r.taskId === taskId)
  if (!run) return 'no such workflow in this session'
  const sdkSessionIds = sdkSessionIdsOf(events, sdkSessionId)
  if (!sdkSessionIds.size) return 'this session has no Claude transcript'
  const roots = await rootsOf(projectsRoot)

  // <session>/subagents/workflows/<runId>, or <session>/workflows/scripts/<file>.
  let sessionDir: string | undefined
  let runId = run.runId
  if (run.transcriptDir) {
    const parts = partsUnder(roots, run.transcriptDir, sdkSessionIds)
    if (!parts || parts.length !== 5 || parts[2] !== 'subagents' || parts[3] !== 'workflows') return "this workflow's files are outside its session"
    runId ??= parts[4]
    if (parts[4] !== runId) return "this workflow's files don't match its run"
    sessionDir = path.resolve(run.transcriptDir, '..', '..', '..')
  }
  let scriptPath: string | undefined
  if (run.scriptPath) {
    const parts = partsUnder(roots, run.scriptPath, sdkSessionIds)
    // In the same session folder as the transcripts, when both are known.
    const sameDir = !sessionDir || (parts && path.resolve(run.scriptPath, '..', '..', '..') === sessionDir)
    if (parts && sameDir && parts.length === 5 && parts[2] === 'workflows' && parts[3] === 'scripts') {
      scriptPath = path.resolve(run.scriptPath)
      sessionDir ??= path.resolve(scriptPath, '..', '..', '..')
    }
  }
  if (!sessionDir || !runId) return 'this workflow did not say where its files are'
  if (!SAFE_ID.test(runId)) return 'this workflow has an unexpected run id'
  return {
    runId,
    transcriptDir: path.join(sessionDir, 'subagents', 'workflows', runId),
    stateFile: path.join(sessionDir, 'workflows', `${runId}.json`),
    ...(scriptPath ? { scriptPath } : {}),
  }
}

// Cached reads

/** A file read and parsed once per (size, mtime). `undefined` = missing or unreadable. */
function cachedFile<T>(parse: (text: string) => T, limit: number) {
  const cache = new Map<string, { size: number; mtimeMs: number; value: T }>()
  return async (file: string): Promise<T | undefined> => {
    try {
      const info = await stat(file)
      const hit = cache.get(file)
      if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.value
      const value = parse(await readFile(file, 'utf8'))
      cache.delete(file)
      cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, value })
      if (cache.size > limit) cache.delete(cache.keys().next().value!)
      return value
    } catch {
      cache.delete(file)
      return undefined
    }
  }
}

type Json = Record<string, unknown>
const objectOf = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function jsonLines(text: string): Json[] {
  const out: Json[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = objectOf(JSON.parse(line))
      if (row) out.push(row)
    } catch {
      // A line still being written.
    }
  }
  return out
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (clipped)` : text)
const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '')

/** An agent's spend, priced exactly as the usage ledger prices it. */
function agentCostOf(text: string): WorkflowAgentCost {
  const byKey = new Map<string, UsageEntry>()
  const loose: UsageEntry[] = []
  const tools = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.includes('"tool_use"')) {
      try {
        const row = JSON.parse(line) as Json
        const content = objectOf(row.message)?.content
        if (row.type === 'assistant' && Array.isArray(content)) {
          for (const b of content as RawBlock[]) if (b?.type === 'tool_use' && typeof b.id === 'string') tools.add(b.id)
        }
      } catch {
        // skip
      }
    }
    if (!line.includes('"usage"')) continue
    const e = usageEntryFrom(line, '')
    if (!e) continue
    // A line per content block: keep the one that counts the most output.
    if (e.key === ':') loose.push(e)
    else if ((byKey.get(e.key)?.output ?? -1) < e.output) byKey.set(e.key, e)
  }
  const entries = [...byKey.values(), ...loose]
  const models = new Map<string, number>()
  let costUsd = 0
  let tokens = 0
  for (const e of entries) {
    costUsd += entryCost(e) ?? 0
    tokens += e.input + e.output + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead
    models.set(e.model, (models.get(e.model) ?? 0) + 1)
  }
  const model = [...models].sort((a, b) => b[1] - a[1])[0]?.[0]
  return { costUsd, tokens, toolCalls: tools.size, ...(model ? { model } : {}) }
}

const readState = cachedFile((t) => objectOf(JSON.parse(t)), 128)
const readScript = cachedFile((t) => clip(t, SCRIPT_MAX_CHARS), 64)
const readAgentCost = cachedFile(agentCostOf, 1024)
const readMeta = cachedFile((t) => objectOf(JSON.parse(t)), 1024)
const readJournal = cachedFile((t) => {
  const results = new Map<string, string>()
  for (const row of jsonLines(t)) {
    // A retried agent writes a result per attempt: the last one is what it returned.
    if (row.type === 'result' && typeof row.agentId === 'string') results.set(row.agentId, clip(asText(row.result), RESULT_MAX_CHARS))
  }
  return results
}, 128)
const readTranscript = cachedFile(transcriptOf, 32)

const agentFile = (files: RunFiles, agentId: string) => path.join(files.transcriptDir, `agent-${agentId}.jsonl`)

// The run

export async function readWorkflowDetail(files: RunFiles): Promise<WorkflowDetail> {
  const names = await readdir(files.transcriptDir).catch(() => [] as string[])
  const ids = names.filter(isWorkflowAgentFile).map((n) => n.slice('agent-'.length, -'.jsonl'.length)).filter((id) => AGENT_ID.test(id))

  const agents: Record<string, WorkflowAgentCost> = {}
  let costUsd = 0
  await Promise.all(
    ids.map(async (id) => {
      const cost = await readAgentCost(agentFile(files, id))
      if (!cost) return
      agents[id] = cost
      costUsd += cost.costUsd
    }),
  )

  const state = await readState(files.stateFile)
  // The script file is the model's to edit and re-run, so once the run's state
  // file exists, its copy is the script this run executed.
  const script = (str(state?.script) ? clip(str(state?.script), SCRIPT_MAX_CHARS) : undefined) ?? (files.scriptPath ? await readScript(files.scriptPath) : undefined)
  const detail: WorkflowDetail = { runId: files.runId, costUsd, agents, ...(script ? { script } : {}) }
  if (!state) return detail

  if (state.result !== undefined && state.result !== null) detail.result = clip(asText(state.result), RESULT_MAX_CHARS)
  if (Array.isArray(state.logs)) detail.logs = state.logs.map(asText)
  const ended = settled(str(state.status) || undefined)
  if (ended) detail.state = ended
  if (Array.isArray(state.workflowProgress)) {
    const snap = progressSnapshot(state.workflowProgress)
    detail.phases = snap.phases
    // An agent can't outlive its run, as in the fold.
    detail.runAgents = ended ? snap.agents.map((a): WorkflowAgent => (a.state === 'running' || a.state === 'queued' ? { ...a, state: 'stopped' } : a)) : snap.agents
  }
  return detail
}

// One agent

const HARNESS_FRAME = /^\[Workflow harness[^\n]*\n/

/** The task text without the harness frame, which indents every line of it by two spaces. */
export function unframePrompt(text: string): string {
  if (!HARNESS_FRAME.test(text)) return text
  return text.replace(HARNESS_FRAME, '').replace(/^ {2}/gm, '')
}

const textOf = (content: RawBlock[]) => content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')

/** Image bytes inside tool results are for the model; the page gets the block without them. */
function slimImages(content: RawBlock[]): RawBlock[] {
  return content.map((b) =>
    b?.type === 'tool_result' && Array.isArray(b.content) && (b.content as RawBlock[]).some((c) => c?.type === 'image')
      ? { ...b, content: (b.content as RawBlock[]).map((c) => (c?.type === 'image' ? { type: 'image', omitted: true } : c)) }
      : b,
  )
}

type ParsedTranscript = { prompt?: string; events: SessionEvent[]; times: number[] }

/** An agent's transcript as main-agent `sdk` events, so buildTranscript draws it like a chat. */
function transcriptOf(text: string): ParsedTranscript {
  let prompt: string | undefined
  let events: SessionEvent[] = []
  let times: number[] = []
  for (const row of jsonLines(text)) {
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta === true) continue
    const msg = objectOf(row.message)
    if (!msg) continue
    const raw = msg.content
    const content: RawBlock[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? slimImages(raw as RawBlock[]) : []
    // The first thing it was told is its task: shown as the brief, not as a message.
    if (prompt === undefined && row.type === 'user' && !content.some((b) => b?.type === 'tool_result')) {
      prompt = unframePrompt(textOf(content))
      continue
    }
    const message: SdkMessage & { uuid?: string } = {
      type: row.type,
      message: { role: str(msg.role) || row.type, content },
      parent_tool_use_id: null,
    }
    if (typeof row.uuid === 'string') message.uuid = row.uuid
    events.push({ kind: 'sdk', message })
    const at = Date.parse(str(row.timestamp))
    times.push(Number.isFinite(at) ? at : 0)
  }
  if (events.length > TRANSCRIPT_MAX_EVENTS) {
    events = events.slice(-TRANSCRIPT_MAX_EVENTS)
    times = times.slice(-TRANSCRIPT_MAX_EVENTS)
  }
  return { prompt, events, times }
}

export async function readAgentTranscript(files: RunFiles, agentId: string): Promise<WorkflowAgentTranscript | string> {
  if (!AGENT_ID.test(agentId)) return 'not an agent id'
  const file = agentFile(files, agentId)
  const [parsed, cost, meta, journal] = await Promise.all([
    readTranscript(file),
    readAgentCost(file),
    readMeta(path.join(files.transcriptDir, `agent-${agentId}.meta.json`)),
    readJournal(path.join(files.transcriptDir, 'journal.jsonl')),
  ])
  if (!parsed) return 'no such agent in this run'
  const result = journal?.get(agentId)
  return {
    agentId,
    ...(str(meta?.description) ? { label: str(meta?.description) } : {}),
    ...(str(meta?.workflowPhase) ? { phase: str(meta?.workflowPhase) } : {}),
    ...(cost?.model || str(meta?.model) ? { model: cost?.model || str(meta?.model) } : {}),
    ...(parsed.prompt !== undefined ? { prompt: parsed.prompt } : {}),
    events: parsed.events,
    times: parsed.times,
    ...(result !== undefined ? { result } : {}),
    costUsd: cost?.costUsd ?? 0,
  }
}

// Session-scoped entry points (server/routes/sessions.ts)

/** Checked paths, by workspace, session and task: polling doesn't re-fold the log. */
const known = new Map<string, RunFiles>()

async function runFilesFor(rt: WorkspaceRuntime, sessionId: string, taskId: string): Promise<RunFiles | string> {
  if (!SAFE_ID.test(taskId)) return 'not a task id'
  const key = `${rt.meta.id}\0${sessionId}\0${taskId}`
  const hit = known.get(key)
  if (hit) return hit
  const row = rt.rows.get(sessionId) ?? (await rt.store.sessions.get(sessionId))
  if (!row) return 'no such session'
  const events = (await rt.store.events.read(sessionId)).map((e) => e.event)
  const files = await findRunFiles(events, taskId, claudeTranscriptDir(rt.envFor(row.provider)), row.sdkSessionId)
  if (typeof files !== 'string') known.set(key, files)
  return files
}

export async function workflowDetailOp(rt: WorkspaceRuntime, sessionId: string, taskId: string): Promise<WorkflowDetailResponse> {
  const files = await runFilesFor(rt, sessionId, taskId)
  if (typeof files === 'string') return { ok: false, error: files }
  return { ok: true, workflow: await readWorkflowDetail(files) }
}

export async function workflowAgentOp(rt: WorkspaceRuntime, sessionId: string, taskId: string, agentId: string): Promise<WorkflowAgentResponse> {
  const files = await runFilesFor(rt, sessionId, taskId)
  if (typeof files === 'string') return { ok: false, error: files }
  const transcript = await readAgentTranscript(files, agentId)
  return typeof transcript === 'string' ? { ok: false, error: transcript } : { ok: true, transcript }
}
