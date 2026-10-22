/**
 * Claude Code through the Agent SDK: the one place triage calls `query()`.
 * Every session is full Claude Code: its own system prompt and tools, plus the
 * user's settings, plugins and MCP connectors from ~/.claude unless a spec
 * says otherwise.
 */
import os from 'node:os'
import { query, type HookCallback, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode, ProviderLimit, SdkMessage } from '../../shared/protocol.js'
import { claudeEvents } from './claude-events.js'
import {
  CLAUDE_API_KEY_VAR,
  claudeAgentTools,
  claudeAuthEnv,
  claudeConfiguredMcp,
  claudeLoginCommand,
  claudeTranscriptDir,
} from './claude-config.js'
import type { AccountStatus, AgentSession, Provider, ProviderEvent, SpawnEnv, ToolVeto, UserTurn } from './types.js'
import { noteClaudeStart } from '../usage/login-ledger.js'

// The permission modes the SDK understands and can be handed straight through.
// 'gated' and 'default' are absent: 'default' is the SDK's own baseline (pinning
// it would say nothing), and 'gated' is enforced by the caller's approval with
// the SDK left at that baseline so every call reaches canUseTool.
type SdkPermissionMode = Exclude<PermissionMode, 'default' | 'gated'>
const SDK_MODES: SdkPermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions']
const sdkMode = (m: PermissionMode | null | undefined): SdkPermissionMode | undefined =>
  m && (SDK_MODES as PermissionMode[]).includes(m) ? (m as SdkPermissionMode) : undefined

const PRESET = { type: 'preset', preset: 'claude_code' } as const

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

/** Our turns as the SDK's streaming-input messages. */
async function* sdkTurns(input: AsyncIterable<UserTurn>): AsyncGenerator<SDKUserMessage> {
  for await (const turn of input) {
    yield { type: 'user', message: { role: 'user', content: turn.content }, parent_tool_use_id: null } as SDKUserMessage
  }
}

/** A veto as a PreToolUse hook: a refusal never reaches the tool. */
function vetoHook(veto: ToolVeto): HookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const d = await veto(input.tool_name, input.tool_input, { toolUseId: input.tool_use_id ?? toolUseID })
    if (d.allow) return d.sure ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: d.sure } } : {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.ask ? 'ask' : 'deny', permissionDecisionReason: d.reason } }
  }
}

/**
 * The Workflow tool's receipt ends "Use /workflows to watch live progress", a
 * terminal command that doesn't exist in triage. A note right after the
 * receipt outweighs the system prompt; the receipt itself stays untouched,
 * since the run card reads it.
 */
const WORKFLOW_NOTE =
  'Note from triage: /workflows does not exist here. The user watches this run in triage: its card in the chat opens a panel with every agent, its transcript and its cost, and Stop in the dock above the composer ends it. Point them there.'
const workflowNoteHook: HookCallback = async (input) =>
  input.hook_event_name === 'PostToolUse' && input.tool_name === 'Workflow'
    ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: WORKFLOW_NOTE } }
    : {}

type Window = { utilization: number | null; resets_at?: string | null } | null | undefined

/** One claude.ai plan window as a limit; a window it doesn't report is skipped. */
function limit(label: string, w: Window): ProviderLimit[] {
  if (!w || w.utilization == null) return []
  const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN
  return [{ label, usedPercent: w.utilization, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) }]
}

/**
 * A subprocess with no turn, for asking it what it knows (models, commands,
 * connectors). The input stays open until `done`, then the subprocess goes.
 */
async function withProbe<T>(options: Parameters<typeof query>[0]['options'], ask: (q: ReturnType<typeof query>) => Promise<T>): Promise<T> {
  let close!: () => void
  const closed = new Promise<void>((res) => (close = res))
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await closed
  }
  const q = query({ prompt: idle(), options })
  try {
    return await ask(q)
  } finally {
    close()
    void q.return(undefined).catch(() => {}) // dispose the subprocess
  }
}

/** The key a spawn with `env` bills to, if any: its own env, else the daemon's, which it inherits. */
const spawnKey = (env: SpawnEnv): string | undefined => (env ?? process.env)[CLAUDE_API_KEY_VAR]

/** The stream as it is, each spawn's login noted for the usage ledger on the way past. */
async function* noted(events: AsyncGenerator<ProviderEvent>, env: SpawnEnv): AsyncGenerator<ProviderEvent> {
  for await (const ev of events) {
    if (ev.kind === 'started') void noteClaudeStart(ev.record as object, spawnKey(env))
    yield ev
  }
}

export const claude: Provider = {
  id: 'claude',
  label: 'Claude Code',
  capabilities: {
    resume: true,
    interrupt: true,
    setModel: true,
    toolApproval: true,
    inProcessMcp: true,
    hooks: true,
    streamDeltas: true,
  },
  auth: { apiKeyVar: CLAUDE_API_KEY_VAR, env: claudeAuthEnv, loginCommand: claudeLoginCommand },
  discovery: { configuredMcp: claudeConfiguredMcp, transcriptDir: claudeTranscriptDir },
  agentTools: claudeAgentTools,

  openSession(input, spec): AgentSession {
    const q = query({
      prompt: sdkTurns(input),
      options: {
        cwd: spec.cwd,
        systemPrompt: { ...PRESET, ...(spec.systemAppend ? { append: spec.systemAppend } : {}) },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        // Subagents: their prose and thinking too, not only their tool calls, so
        // an agent's own view reads like a chat. Not agentProgressSummaries: its
        // ~30s forks came to ~15% of a 4-agent run, and they are never written
        // to a transcript, so the cost pill can't see them. The dock shows the
        // CLI's own line for the agent's last tool call instead.
        forwardSubagentText: true,
        mcpServers: spec.mcpServers,
        ...(spec.tools ? { tools: spec.tools } : {}),
        ...(spec.strictMcp ? { strictMcpConfig: true } : {}),
        ...(spec.disallowedTools?.length ? { disallowedTools: spec.disallowedTools } : {}),
        ...(spec.env ? { env: spec.env } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
        // Fast mode: the SDK only honours it from the inline (flag) settings
        // layer and only when it is explicitly true, a user/project setting is
        // ignored in the Agent SDK ('sdk_opt_in_required'), so it is set at
        // spawn here and cleared, not set false, when turned off.
        // Ultracode rides the same layer: a session-scoped flag setting.
        ...(spec.fastMode || spec.ultracode || spec.settings
          ? { settings: { ...(spec.settings ?? {}), ...(spec.fastMode ? { fastMode: true } : {}), ...(spec.ultracode ? { ultracode: true } : {}) } }
          : {}),
        ...(spec.maxBudgetUsd ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
        ...(spec.planning ? { permissionMode: 'plan' as const } : sdkMode(spec.permissionMode) ? { permissionMode: sdkMode(spec.permissionMode) } : {}),
        // The SDK refuses 'bypassPermissions' without this explicit opt-in.
        ...(spec.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        ...(spec.additionalDirectories?.length ? { additionalDirectories: spec.additionalDirectories } : {}),
        ...(spec.resume ? { resume: spec.resume } : {}),
        ...(spec.title && !spec.resume ? { title: spec.title } : {}),
        ...(spec.plugins?.length ? { plugins: spec.plugins.map((p) => ({ type: 'local' as const, path: p })) } : {}),
        hooks: {
          ...(spec.veto ? { PreToolUse: [{ hooks: [vetoHook(spec.veto)] }] } : {}),
          PostToolUse: [{ matcher: 'Workflow', hooks: [workflowNoteHook] }],
        },
        canUseTool: (toolName, toolInput, opts) => spec.approve(toolName, toolInput, opts),
      },
    })
    const events = noted(claudeEvents(q), spec.env)
    // An effort change sent without an `ultracode` key turns ultracode off, so it travels with one.
    let ultracode = spec.ultracode === true
    return {
      [Symbol.asyncIterator]: () => events,
      setModel: (model) => q.setModel(model),
      setEffort: async (effort) => {
        await q.applyFlagSettings({ effortLevel: effort, ...(ultracode ? { ultracode: true } : {}) })
      },
      setUltracode: async (on) => {
        await q.applyFlagSettings({ ultracode: on ? true : null })
        ultracode = on
      },
      setFastMode: async (on) => {
        await q.applyFlagSettings({ fastMode: on ? true : null })
      },
      setPermissionMode: (mode) => q.setPermissionMode(sdkMode(mode) ?? 'default'),
      setPlanning: (on, mode) => q.setPermissionMode(on ? 'plan' : sdkMode(mode) ?? 'default'),
      commands: () => q.supportedCommands(),
      interrupt: async () => {
        await q.interrupt()
      },
      stopTask: (taskId) => q.stopTask(taskId),
      backgroundTask: async (toolUseId) => {
        await q.backgroundTasks(toolUseId)
      },
      // Plugins, skills and agents in one go, project and personal ones too, not only plugins'.
      reloadLibrary: async () => (await q.reloadPlugins()).commands,
    }
  },

  run(spec) {
    const q = query({
      prompt: spec.prompt,
      options: {
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        systemPrompt: spec.systemAppend ? { ...PRESET, append: spec.systemAppend } : PRESET,
        settingSources: spec.userConfig ? ['user'] : [],
        ...(spec.tools ? { tools: spec.tools } : {}),
        ...(spec.allowedTools ? { allowedTools: spec.allowedTools } : {}),
        ...(spec.disallowedTools?.length ? { disallowedTools: spec.disallowedTools } : {}),
        ...(spec.unattended ? { permissionMode: 'dontAsk' as const } : {}),
        ...(spec.veto ? { hooks: { PreToolUse: [{ hooks: [vetoHook(spec.veto)] }] } } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.maxBudgetUsd != null ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
        ...(spec.maxTurns != null ? { maxTurns: spec.maxTurns } : {}),
        ...(spec.skills ? { skills: spec.skills } : {}),
        ...(spec.plugins?.length ? { plugins: spec.plugins.map((p) => ({ type: 'local' as const, path: p })) } : {}),
        ...(spec.resume ? { resume: spec.resume } : {}),
        ...(spec.streamDeltas ? { includePartialMessages: true } : {}),
        ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
        ...(spec.abort ? { abortController: spec.abort } : {}),
        ...(spec.env ? { env: spec.env } : {}),
      },
    })
    return noted(claudeEvents(q), spec.env)
  },

  mcpStatus({ cwd, env, servers }) {
    return withProbe(
      servers
        ? // Exactly what a job run in `cwd` loads: the user's servers plus the
          // folder's, passed explicitly (never by loading the project's settings/hooks).
          { cwd, systemPrompt: PRESET, settingSources: ['user'], mcpServers: servers, ...(env ? { env } : {}) }
        : { cwd, systemPrompt: PRESET, settingSources: ['user', 'project', 'local'], ...(env ? { env } : {}) },
      async (q) => {
        // Servers connect asynchronously; poll until none are pending (or the
        // budget runs out and we report the stragglers as they are).
        const deadline = Date.now() + 45_000
        let statuses = await q.mcpServerStatus()
        while (statuses.some((srv) => srv.status === 'pending') && Date.now() < deadline) {
          await sleep(1_000)
          statuses = await q.mcpServerStatus()
        }
        return statuses
      },
    )
  },

  models({ cwd, env }) {
    return withProbe({ cwd, systemPrompt: PRESET, settingSources: ['user', 'project', 'local'], ...(env ? { env } : {}) }, async (q) =>
      (await q.supportedModels()).map((m) => ({
        id: m.value,
        resolvedModel: m.resolvedModel,
        name: m.displayName,
        description: m.description,
        efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
        supportsFastMode: m.supportsFastMode,
      })),
    )
  },

  commands({ cwd, env }) {
    // The same sources a real session gets, or the probe would miss exactly
    // the project-local commands it is being asked about.
    return withProbe({ cwd, systemPrompt: PRESET, settingSources: ['user', 'project', 'local'], ...(env ? { env } : {}) }, (q) =>
      q.supportedCommands(),
    )
  },

  // `accountInfo` says who is signed in; the plan windows come from the
  // SDK's `/usage` call, marked experimental, so it is asked separately and
  // a failure there costs the limits, never the account.
  account(env) {
    return withProbe(
      { cwd: os.homedir(), systemPrompt: PRESET, settingSources: [], ...(env ? { env } : {}) },
      async (q): Promise<AccountStatus> => {
        const info = await q.accountInfo()
        let limits: ProviderLimit[] = []
        let plan = info.subscriptionType
        try {
          const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
          plan = usage.subscription_type ?? plan
          const r = usage.rate_limits
          if (r) {
            limits = [
              ...limit('5-hour', r.five_hour),
              ...limit('Weekly', r.seven_day),
              ...limit('Weekly · Opus', r.seven_day_opus),
              ...limit('Weekly · Sonnet', r.seven_day_sonnet),
              ...(r.model_scoped ?? []).flatMap((m) => limit(`Weekly · ${m.display_name}`, m)),
              ...(r.extra_usage?.is_enabled ? limit('Extra usage · monthly', r.extra_usage) : []),
            ]
          }
        } catch {
          // no plan windows on this CLI, or none for this login (API key, Bedrock)
        }
        const kind = info.apiKeySource ? 'apiKey' : info.apiProvider && info.apiProvider !== 'firstParty' ? info.apiProvider : 'claude.ai'
        return {
          ok: true,
          account: {
            kind,
            ...(info.email ? { email: info.email } : {}),
            ...(plan ? { plan } : {}),
            ...(info.organization ? { org: info.organization } : {}),
          },
          limits,
        }
      },
    ).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err), limits: [] }))
  },

  // The model catalog is static and "succeeds" on a bogus key, so this runs
  // one trivial turn to actually reach the API.
  async checkAuth(env) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 90_000)
    try {
      const q = query({
        prompt: 'Reply with exactly: OK',
        options: {
          cwd: os.homedir(),
          maxTurns: 1,
          settingSources: [],
          allowedTools: [],
          abortController: abort,
          ...(env ? { env } : {}),
        },
      })
      for await (const msg of q) {
        const m = msg as unknown as SdkMessage & { subtype?: string; result?: string }
        if (m.type === 'system' && m.subtype === 'init') void noteClaudeStart(m, spawnKey(env))
        if (m.type === 'result') {
          if (m.subtype === 'success') return { ok: true }
          return { ok: false, error: typeof m.result === 'string' && m.result ? m.result : `auth check failed (${m.subtype})` }
        }
      }
      return { ok: false, error: 'auth check ended without a result' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  },
}
