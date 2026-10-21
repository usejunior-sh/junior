import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Connector, Project, SessionEvent } from '../../shared/protocol.js'
import type { JobBrowser, JobOutput, JobPreviewResult, JobPreviewRow } from '../../core/job/types.js'
import { grantLabel, type JobToolGrant, mcpGrants, mcpToolName, RESERVED_SERVER, runAllowedTools, runBaseTools } from '../../core/job/tools.js'
import type { RunSpec as AgentRunSpec, McpServers } from '../providers/types.js'
import { requireVeto } from '../providers/capabilities.js'
import { composeRunPrompt, MAX_ROWS_PER_RUN } from '../../core/job/connectors.js'
import { lookbackMs } from '../../core/job/schedule.js'
import { checkBrowserProfile, checkLibrary } from '../job-files.js'
import { WORKSPACE_PLUGIN } from '../library.js'
import { fenceDecision, fenceFor } from '../../core/job/fence.js'
import { personaAppend } from '../../core/junior/persona.js'
import { safeWhen } from '../../core/sources/slack.js'
import { dryRunDecision, isArgsObject } from '../../core/actions/queue.js'
import { log } from '../log.js'
import { browserGateFor, browserHub, browserMcpFor, WorkspaceRuntime } from '../workspace/runtime.js'
import { listProfiles } from '../browser/profiles.js'
import { downloadDirFor } from '../browser.js'
import type { BrowserProfile } from '../../core/browser/profiles.js'
import { readSettings } from '../settings-ops.js'
import { probeConnectors } from '../workspace/probes.js'
import { jobLibrary } from '../session/changes.js'
import { broadcast } from '../ws/send.js'
import { VERSION } from '../config.js'
import { DIGEST_SHAPE, identityFromUrl, rowFiling, upsertShape } from './scan-mcp.js'
import type { JobFiling } from '../../core/job/filing.js'
import { errResult, okResult } from '../triage-mcp.js'
import { sortForWorkspace } from '../session/actions-record.js'

export type JobPreview = {
  id: string
  status: 'running' | 'ready' | 'failed'
  /** the transcript, minus stream deltas, replayed to late subscribers like a session's log */
  events: SessionEvent[]
  result?: JobPreviewResult
  error?: string
  startedAt: number
}
const PREVIEW_TTL_MS = 15 * 60_000

/** Why a browser job can't run: the pane lives in Triage.app. The job page matches "needs Triage.app" in a skip's reason: keep it. */
export const BROWSER_NEEDS_APP = 'the browser needs Triage.app open'
const BROWSER_PREFIX = mcpToolName('browser', '')

/** What a run (real or dry) is made of: the job as saved, or the form as it stands. */
type RunSpec = {
  instruction: string
  tools: JobToolGrant[]
  project: Project
  model?: string
  output: JobOutput
  schedule: string
  scope?: string
  lateness?: string
  /** the skills and agents the job names, as Claude calls them */
  skills?: string[]
  agents?: string[]
  /** how it files: reason, labels, tiers */
  filing?: JobFiling
  /** the browser profile and sites, when the job names one */
  browser?: JobBrowser
}

type PreviewSpec = Omit<RunSpec, 'project'> & { projectId: string }

// Folder MCP servers: the `project` servers in a
// folder's .mcp.json and the user's private `local` servers for that folder
// (in Claude's own config). Read by triage and passed explicitly, never by
// loading the project's settings, which would also load its hooks, and hooks
// are shell commands that would run unattended.

type FolderMcp = { servers: McpServers; scopes: Map<string, 'project' | 'local'> }

/** `${VAR}` / `${VAR:-default}` in .mcp.json strings, from the run's environment. */
function expandEnv(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === 'string') return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k: string, d?: string) => env[k] ?? d ?? '')
  if (Array.isArray(v)) return v.map((x) => expandEnv(x, env))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x, env)]))
  return v
}

export async function folderMcpServers(rt: WorkspaceRuntime, cwd: string): Promise<FolderMcp> {
  const env = { ...process.env, ...(rt.env ?? {}) }
  const out: FolderMcp = { servers: {}, scopes: new Map() }
  const add = (raw: unknown, scope: 'project' | 'local') => {
    if (!raw || typeof raw !== 'object') return
    for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== 'object') continue
      out.servers[name] = expandEnv(cfg, env) as McpServers[string]
      out.scopes.set(name, scope)
    }
  }
  const configured = await rt.provider.discovery.configuredMcp({ cwd, env: rt.env })
  add(configured.project, 'project')
  add(configured.local[cwd], 'local') // private per-folder servers win over the shared file, as in Claude Code
  delete out.servers.triage // our own in-process server owns that name
  return out
}

/**
 * Local-scope MCP servers the user configured for other folders (names only,
 * never their config). A job runs in one folder, so these aren't usable
 * here, but listing them tells the user which project to pick instead.
 */
export async function localServersElsewhere(rt: WorkspaceRuntime, cwd: string, here: Connector[]): Promise<Array<{ name: string; folder: string }>> {
  const { local } = await rt.provider.discovery.configuredMcp({ cwd, env: rt.env })
  const have = new Set(here.map((c) => c.server))
  const out: Array<{ name: string; folder: string }> = []
  for (const [folder, servers] of Object.entries(local)) {
    if (folder === cwd) continue
    for (const name of Object.keys(servers)) if (!have.has(name)) out.push({ name, folder })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder))
}

/** The workspace's default run limits, under a job's own. */
export async function jobLimits(rt: WorkspaceRuntime, w: { timeoutMs?: number; maxBudgetUsd?: number }): Promise<{ timeoutMs: number; maxBudgetUsd?: number }> {
  const s = await readSettings(rt)
  const budget = w.maxBudgetUsd ?? s.jobBudgetUsd ?? undefined
  return { timeoutMs: w.timeoutMs ?? s.jobTimeoutMs, ...(budget != null ? { maxBudgetUsd: budget } : {}) }
}

/**
 * The run spec every job run shares, real or dry. Same prompt, same fence:
 * built-in tools limited to what the grants need, the allowlist so granted
 * tools never prompt, unattended so nothing else ever does, and the fence as a
 * veto so nothing else ever runs, whatever the user's own global allow rules
 * say. Runs work in the project folder and nowhere else.
 */
export async function jobQuery(
  rt: WorkspaceRuntime,
  spec: RunSpec,
  triage: McpServers[string],
  abort: AbortController,
  /** tab: the browser tab's key, the run's session id (a dry run's preview id); a browser job without one gets no browser */
  extra: { maxBudgetUsd?: number; includePartialMessages?: boolean; tab?: string } = {},
): Promise<AgentRunSpec> {
  // The fence below is the whole safety story: no veto, no run.
  requireVeto(rt.provider, 'job')
  // The browser: the job's profile, checked again (it may have been removed
  // since the file was), and Triage.app open to host the tab.
  let browser: { profile: BrowserProfile; sites?: string[]; tab: string } | null = null
  if (spec.browser && extra.tab) {
    const found = checkBrowserProfile(spec.browser, listProfiles())
    if (!found.profile) throw new Error(found.errors.join('; '))
    if (!browserHub.status.compatible) throw new Error(BROWSER_NEEDS_APP)
    browser = { profile: found.profile, ...(spec.browser.sites?.length ? { sites: spec.browser.sites } : {}), tab: extra.tab }
  }
  const folder = await folderMcpServers(rt, spec.project.path)
  const granted = new Set(mcpGrants(spec.tools).map((g) => g.source.server))
  const folderServers = Object.fromEntries(Object.entries(folder.servers).filter(([name]) => granted.has(name)))
  // Servers the user has connected but this job wasn't granted still load
  // from their settings; take their tools out of the run's context entirely
  // (the fence would deny them anyway). Known from the latest probes.
  // A run right after boot can beat the first probe; wait for it (a few seconds, no API turn).
  const home = rt.connectorCache ?? (await probeConnectors(rt).catch(() => null))
  const known = [...(rt.folderProbes.get(spec.project.path)?.connectors ?? []), ...(home?.connectors ?? [])]
  const ungranted = [...new Set(known.map((c) => c.server))].filter((srv) => !granted.has(srv) && srv !== RESERVED_SERVER)
  const disallowedTools = ungranted.map((srv) => mcpToolName(srv, '').replace(/__$/, ''))
  const now = Date.now()
  const prompt = composeRunPrompt({
    instruction: spec.instruction,
    tools: spec.tools,
    project: { name: spec.project.name, path: spec.project.path },
    output: spec.output,
    lookbackMs: lookbackMs(spec.schedule, now),
    nowIso: new Date(now).toISOString(),
    ...(spec.scope ? { scope: spec.scope } : {}),
    ...(spec.lateness ? { lateness: spec.lateness } : {}),
    ...(spec.skills?.length ? { skills: spec.skills } : {}),
    ...(spec.agents?.length ? { agents: spec.agents } : {}),
    ...(spec.filing ? { filing: spec.filing } : {}),
    ...(browser ? { browser: { profile: browser.profile.name, ...(browser.sites ? { sites: browser.sites } : {}) } } : {}),
  })
  // A job's skills and agents: only the ones it names load, checked again
  // here: the library may have changed since the file was. The workspace
  // library comes in as its plugin only when the job names something in it.
  const skills = spec.skills ?? []
  const agents = spec.agents ?? []
  if (skills.length || agents.length) {
    const missing = checkLibrary({ skills, agents }, await jobLibrary(rt))
    if (missing.length) throw new Error(missing.join('; '))
  }
  const extraTools = [...(skills.length ? ['Skill'] : []), ...(agents.length ? ['Agent'] : [])]
  const fromLibrary = [...skills, ...agents].some((n) => n.startsWith(`${WORKSPACE_PLUGIN}:`))
  const fence = fenceFor(spec.tools, spec.output, spec.project.path, { skills, agents }, browser ? { browser: true, readRoots: [downloadDirFor(browser.tab)] } : {})
  // Past the fence, the browser's own gate: sites, commit clicks, passwords (server/browser/gate.ts).
  const tab = browser ? { id: browser.tab, cwd: spec.project.path } : null
  const gate = tab ? browserGateFor(tab, { mode: 'job', ...(browser?.sites ? { sites: browser.sites } : {}) }) : null
  return {
    prompt,
    // A job run is Junior's too: its name and voice, and the one rule an unattended run can keep.
    systemAppend: personaAppend(rt.persona, 'job'),
    cwd: spec.project.path,
    userConfig: true,
    tools: [...runBaseTools(spec.tools), ...extraTools],
    allowedTools: [...runAllowedTools(spec.tools, spec.output, !!browser), ...extraTools],
    ...(skills.length ? { skills } : {}),
    ...(fromLibrary ? { plugins: [rt.libraryDir] } : {}),
    ...(disallowedTools.length ? { disallowedTools } : {}),
    unattended: true,
    veto: async (toolName, input) => {
      const d = fenceDecision(fence, toolName, input)
      if (!d.allow || !gate || !toolName.startsWith(BROWSER_PREFIX)) return d
      return (await gate(toolName, input)) ?? d
    },
    ...(spec.model ? { model: spec.model } : {}),
    ...(extra.maxBudgetUsd != null ? { maxBudgetUsd: extra.maxBudgetUsd } : {}),
    ...(extra.includePartialMessages ? { streamDeltas: true } : {}),
    mcpServers: {
      ...folderServers,
      triage,
      ...(tab && browser ? { browser: browserMcpFor(rt, tab, { mode: 'job', profile: browser.profile.id, ...(browser.sites ? { sites: browser.sites } : {}) }) } : {}),
    },
    abort,
    ...(rt.env ? { env: rt.env } : {}),
  }
}

/** The project a job runs in, checked: a removed project or a missing folder is an error, never a fallback. */
export async function jobProject(rt: WorkspaceRuntime, projectId: string): Promise<Project> {
  const project = (await rt.store.projects.list()).find((p) => p.id === projectId)
  if (!project) throw new Error('project removed — pick another project for this job')
  const st = await stat(project.path).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`folder not found: ${project.path}`)
  return project
}

export const noConnectorError = (tools: JobToolGrant[]) =>
  tools.length
    ? `no connector tools — connect ${tools.map(grantLabel).join(', ')} for Claude (claude.ai/settings/connectors, or the project's MCP config)`
    : `no browser tools — ${BROWSER_NEEDS_APP}`

/**
 * Start a dry run of a job as the form currently describes it. Same prompt,
 * tools and fences as a real run; the write tool only collects. The run is
 * streamed over the WebSocket under an ephemeral session id so the form can
 * show the transcript live, but nothing is persisted. No session row, no
 * events, no items, no artifact. The caller polls for the outcome.
 */
export function startJobPreview(rt: WorkspaceRuntime, spec: PreviewSpec): string {
  const pv: JobPreview = { id: randomUUID(), status: 'running', events: [], startedAt: Date.now() }
  rt.previews.set(pv.id, pv)
  void runJobPreview(rt, pv, spec)
  return pv.id
}

export async function runJobPreview(rt: WorkspaceRuntime, pv: JobPreview, spec: PreviewSpec): Promise<void> {
  const emit = (event: SessionEvent, keep = true) => {
    if (keep) pv.events.push(event)
    broadcast(rt, { type: 'session_event', sessionId: pv.id, event, at: Date.now() })
  }
  const rows: JobPreviewRow[] = []
  const wouldQueue: Array<{ tool: string; summary: string }> = []
  let digest: { title: string; body: string } | undefined
  const collector = createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools:
      spec.output === 'digest'
        ? [
            tool('write_digest', 'Save this run’s digest: ONE markdown report. Call exactly once with the whole document.', DIGEST_SHAPE, async (args) => {
              if (digest) return errResult('the digest was already written this run — stop calling this tool')
              digest = { title: args.title.trim() || 'Digest', body: args.body }
              return okResult('ok: digest recorded')
            }),
          ]
        : [
            tool('upsert_work_item', 'Record ONE match as a work item. Call once per match; the server derives the id from the link.', upsertShape(spec.filing), async (args) => {
              if (rows.length >= MAX_ROWS_PER_RUN) return errResult(`row cap reached (${MAX_ROWS_PER_RUN}) — stop calling this tool`)
              const ident = identityFromUrl(args.url)
              if (!ident) return errResult('url must be a Slack permalink, a Linear issue URL or key, a GitHub PR/issue URL, or a web page URL')
              if (rows.some((r) => r.id === ident.id)) return okResult(`already filed and open: ${ident.id}. Do not count it as new; move on to the next candidate.`)
              const existing = await rt.store.items.get(ident.id).catch(() => null)
              rows.push({
                id: ident.id,
                title: args.title,
                url: ident.url,
                place: args.place?.trim() || ident.home,
                from: args.from ?? '',
                lastActivity: safeWhen(args.lastActivity, Date.now()),
                why: args.why,
                ask: args.ask,
                ...rowFiling(spec.filing, args),
              })
              return okResult(existing ? `already filed, ${existing.status}: ${ident.id}` : `new: filed ${ident.id}`)
            }),
          ],
  })
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let tokens = 0
  let costUsd: number | undefined
  let resultText = ''
  let sawResult = false
  try {
    const project = await jobProject(rt, spec.projectId)
    const limits = await jobLimits(rt, {})
    timer = setTimeout(() => abort.abort(), limits.timeoutMs)
    const previewSpec = await jobQuery(rt, { ...spec, project }, collector, abort, { ...limits, includePartialMessages: true, tab: pv.id })
    // A dry run never sends: past the fence, anything that counts as an action
    // (a connector write, an outbound command) is refused and listed instead.
    const fence = previewSpec.veto
    if (fence) {
      previewSpec.veto = async (toolName, input, ctx) => {
        const d = await fence(toolName, input, ctx)
        if (!d.allow) return d
        const args = isArgsObject(input) ? input : {}
        let sorted = null
        try {
          sorted = sortForWorkspace(rt)(toolName, args)
        } catch {
          // can't tell: refuse, a dry run loses nothing by it
          sorted = { summary: toolName }
        }
        const out = dryRunDecision(sorted)
        if (!out.allow && sorted && wouldQueue.length < 50) wouldQueue.push({ tool: toolName, summary: sorted.summary })
        return out
      }
    }
    const q = rt.provider.run(previewSpec)
    for await (const ev of q) {
      emit({ kind: 'sdk', message: ev.record }, ev.kind !== 'stream')
      if (ev.kind === 'result') {
        sawResult = true
        resultText = ev.text
        tokens = ev.tokens
        if (ev.costUsd != null) costUsd = ev.costUsd
      }
    }
    if (resultText.includes('no-connector-tools')) throw new Error(noConnectorError(spec.tools))
    if (!sawResult) throw new Error(abort.signal.aborted ? 'the preview timed out' : 'the preview ended without a result')
    pv.result = { output: spec.output, rows, ...(digest ? { digest } : {}), ...(wouldQueue.length ? { wouldQueue } : {}), tokens, ...(costUsd != null ? { costUsd } : {}), durationMs: Date.now() - pv.startedAt }
    pv.status = 'ready'
    log('info', 'job', `preview: ${rows.length} row(s)${digest ? ', digest' : ''}, ${Math.round(tokens / 1000)}k tok`, { previewId: pv.id, workspace: rt.meta.id })
  } catch (err) {
    pv.error = err instanceof Error ? err.message : String(err)
    pv.status = 'failed'
    emit({ kind: 'error', message: pv.error })
    log('warn', 'job', `preview failed: ${pv.error}`, { previewId: pv.id, workspace: rt.meta.id })
  } finally {
    if (timer) clearTimeout(timer)
    // the dry run's tab is single-use: close it
    if (spec.browser) browserHub.forget(pv.id)
    setTimeout(() => rt.previews.delete(pv.id), PREVIEW_TTL_MS).unref()
  }
}
