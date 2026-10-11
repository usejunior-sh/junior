/**
 * Codex through `codex app-server` — JSON-RPC 2.0 as newline-delimited JSON
 * over stdio, one subprocess per session. Chat sessions only: Codex has no
 * hook triage could fence a tool call with, so watches, scans and team workers
 * stay on Claude (`hooks: false` keeps `requireVeto` refusing them), and it
 * can't host triage's in-process MCP server — the user's own
 * ~/.codex/config.toml brings its MCP servers instead.
 *
 * Every approval Codex asks for goes through `SessionSpec.approve`, so the
 * normal permission prompt decides it: a command is asked as `Bash`, each file
 * of a patch as the `Edit`/`Write` it maps to (codex-events.ts).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { EffortLevel, PermissionMode } from '../../shared/protocol.js'
import { codexModels, createCodexMapper, toolCallsOf, unwrapShell, type CodexMapper } from './codex-events.js'
import type { AgentSession, PermissionResult, PermissionUpdate, Provider, ProviderEvent, SpawnEnv, ToolApprovalContext, UserTurn } from './types.js'

const CODEX_API_KEY_VAR = 'OPENAI_API_KEY'
const CLIENT_INFO = { name: 'triage', title: 'triage', version: '1' }

type Params = Record<string, unknown>
type RpcError = { code?: number; message?: string }

/**
 * One `codex app-server` subprocess as a JSON-RPC peer. Server requests (the
 * approvals) are always answered — an unanswered one hangs the turn — so a
 * handler that throws replies with an error instead.
 */
class CodexClient {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  private stderr = ''
  private exited = false
  onNotification: (method: string, params: Params) => void = () => {}
  onRequest: (method: string, params: Params) => Promise<unknown> = async (method) => {
    throw new Error(`unhandled request ${method}`)
  }
  onExit: (err: Error | null) => void = () => {}

  constructor(cwd: string, env: SpawnEnv) {
    this.proc = spawn('codex', ['app-server'], { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.read(chunk))
    this.proc.stderr.setEncoding('utf8')
    // Kept only to explain an early exit; Codex logs MCP chatter here.
    this.proc.stderr.on('data', (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-4000)))
    this.proc.stdin.on('error', () => {})
    this.proc.on('error', (err) => this.exit(err))
    this.proc.on('exit', (code, signal) =>
      this.exit(code === 0 || signal === 'SIGTERM' ? null : new Error(`codex app-server exited (${signal ?? code})${this.lastLog()}`)),
    )
  }

  private lastLog(): string {
    const line = this.stderr.trim().split('\n').at(-1)
    return line ? `: ${line}` : ''
  }

  private exit(err: Error | null) {
    if (this.exited) return
    this.exited = true
    const reason = err ?? new Error('codex app-server closed')
    for (const p of this.pending.values()) p.reject(reason)
    this.pending.clear()
    this.onExit(err)
  }

  private send(msg: Params) {
    if (!this.exited) this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  }

  private read(chunk: string) {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number | string; method?: string; params?: Params; result?: unknown; error?: RpcError }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.method && msg.id != null) void this.answer(msg.id, msg.method, msg.params ?? {})
      else if (msg.method) this.onNotification(msg.method, msg.params ?? {})
      else if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? `codex error ${msg.error.code}`))
        else p.resolve(msg.result)
      }
    }
  }

  private async answer(id: number | string, method: string, params: Params) {
    try {
      this.send({ id, result: await this.onRequest(method, params) })
    } catch (err) {
      this.send({ id, error: { code: -32601, message: err instanceof Error ? err.message : String(err) } })
    }
  }

  request<T = Params>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error('codex app-server is not running'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject })
      this.send({ id, method, params })
    })
  }

  async initialize() {
    await this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
    this.send({ method: 'initialized' })
  }

  close() {
    if (!this.exited) this.proc.kill('SIGTERM')
  }
}

/** A short-lived app-server for one question (models, auth). */
async function withClient<T>(cwd: string, env: SpawnEnv, ask: (c: CodexClient) => Promise<T>): Promise<T> {
  const client = new CodexClient(cwd, env)
  try {
    await client.initialize()
    return await ask(client)
  } finally {
    client.close()
  }
}

/** Events out, pushed as the subprocess talks; fails the reader when it dies. */
class EventQueue implements AsyncIterable<ProviderEvent> {
  private items: ProviderEvent[] = []
  private waiters: Array<{ resolve: (r: IteratorResult<ProviderEvent>) => void; reject: (e: Error) => void }> = []
  private ended = false
  private error: Error | null = null

  push(ev: ProviderEvent) {
    const w = this.waiters.shift()
    if (w) w.resolve({ value: ev, done: false })
    else this.items.push(ev)
  }

  end(err: Error | null = null) {
    if (this.ended) return
    this.ended = true
    this.error = err
    for (const w of this.waiters.splice(0)) (err ? w.reject(err) : w.resolve({ value: undefined, done: true }))
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
    }
  }
}

/**
 * Claude's permission modes as Codex's approval policy and sandbox. Bypass is
 * Codex's own full access; every other mode keeps the workspace sandbox and
 * asks — `acceptEdits`/`auto` answer patches here without asking (see below).
 */
const threadPolicy = (mode: PermissionMode | null | undefined) =>
  mode === 'bypassPermissions'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }

/** The same, in turn/start's shape (a mode changed mid-session). */
const turnPolicy = (mode: PermissionMode | null | undefined) =>
  mode === 'bypassPermissions'
    ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
    : {
        approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      }

const autoAcceptsEdits = (mode: PermissionMode | null | undefined) =>
  mode === 'acceptEdits' || mode === 'auto' || mode === 'bypassPermissions'

/** Our turn as app-server input: text as text, images as data URLs. */
const turnInput = (turn: UserTurn) =>
  turn.content.map((b) =>
    b.type === 'text'
      ? { type: 'text', text: b.text, text_elements: [] }
      : { type: 'image', url: `data:${b.source.media_type};base64,${b.source.data}` },
  )

/**
 * The "always allow" the prompt offers: Codex's own accept-for-session,
 * phrased as a session rule so the prompt shows the button and hands it back.
 */
const sessionRule = (toolName: string, ruleContent?: string): PermissionUpdate[] => [
  { type: 'addRules', rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }], behavior: 'allow', destination: 'session' },
]

const allowed = (r: PermissionResult) => r.behavior === 'allow'
const forSession = (r: PermissionResult) => r.behavior === 'allow' && !!r.updatedPermissions?.length

export const codex: Provider = {
  id: 'codex',
  label: 'Codex',
  capabilities: {
    resume: true,
    interrupt: true,
    setModel: true,
    toolApproval: true,
    inProcessMcp: false,
    hooks: false,
    streamDeltas: true,
  },
  auth: {
    apiKeyVar: CODEX_API_KEY_VAR,
    env: (auth): Record<string, string> | undefined => {
      if (auth.backend === 'api-key') return auth.apiKey ? { [CODEX_API_KEY_VAR]: auth.apiKey } : undefined
      if (auth.backend === 'config-dir') return { CODEX_HOME: auth.dir }
      return undefined
    },
    loginCommand: (dir) => `CODEX_HOME=${dir} codex login`,
  },
  discovery: {
    // Codex's servers live in config.toml and connect inside its own process;
    // triage doesn't hand any to it, so there is nothing to merge.
    configuredMcp: async () => ({ project: {}, local: {} }),
    transcriptDir: (env) => path.join(env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  },
  agentTools() {
    throw new Error("Codex can't run team agents")
  },

  openSession(input, spec): AgentSession {
    const events = new EventQueue()
    const client = new CodexClient(spec.cwd, spec.env)
    let mode = spec.permissionMode
    let modeChanged = false
    let model = spec.model
    let effort: EffortLevel | undefined = spec.effort
    let threadId = ''
    let mapper: CodexMapper | null = null
    let turnId: string | undefined
    let turnDone: (() => void) | undefined

    client.onNotification = (method, params) => {
      if (!mapper) return
      if (method === 'turn/started') turnId = (params.turn as { id?: string } | undefined)?.id
      for (const ev of mapper.notification(method, params)) events.push(ev)
      if (method === 'turn/completed') {
        turnId = undefined
        turnDone?.()
      }
    }

    const ask = (toolName: string, toolInput: Record<string, unknown>, ctx: ToolApprovalContext) => spec.approve(toolName, toolInput, ctx)

    client.onRequest = async (method, params) => {
      const reason = typeof params.reason === 'string' && params.reason ? params.reason : undefined
      const item = typeof params.itemId === 'string' ? mapper?.item(params.itemId) : undefined
      switch (method) {
        case 'item/commandExecution/requestApproval': {
          const raw = typeof params.command === 'string' ? params.command : typeof item?.command === 'string' ? item.command : ''
          const command = unwrapShell(raw)
          const r = await ask('Bash', { command }, { description: reason, suggestions: sessionRule('Bash', command) })
          return { decision: !allowed(r) ? 'decline' : forSession(r) ? 'acceptForSession' : 'accept' }
        }
        case 'item/fileChange/requestApproval': {
          if (autoAcceptsEdits(mode)) return { decision: 'accept' }
          const calls = item ? toolCallsOf(item) : []
          if (!calls.length) {
            const r = await ask('Edit', {}, { description: reason ?? 'Codex wants to apply a patch.' })
            return { decision: allowed(r) ? 'accept' : 'decline' }
          }
          let session = true
          for (const c of calls) {
            const r = await ask(c.name, c.input as Record<string, unknown>, { description: reason, suggestions: sessionRule(c.name) })
            if (!allowed(r)) return { decision: 'decline' }
            session &&= forSession(r)
          }
          return { decision: session ? 'acceptForSession' : 'accept' }
        }
        // The pre-v2 approval requests, in case this Codex still sends them.
        case 'execCommandApproval': {
          const argv = Array.isArray(params.command) ? (params.command as unknown[]).map(String) : []
          const command = unwrapShell(argv.length >= 3 && /sh$/.test(argv[0]) ? `${argv[0]} ${argv[1]} '${argv.slice(2).join(' ')}'` : argv.join(' '))
          const r = await ask('Bash', { command }, { description: reason })
          return { decision: allowed(r) ? 'approved' : { denied: { rejection: 'Denied by the user in triage.' } } }
        }
        case 'applyPatchApproval': {
          if (autoAcceptsEdits(mode)) return { decision: 'approved' }
          const files = Object.keys((params.fileChanges as Params | undefined) ?? {})
          for (const file_path of files.length ? files : ['']) {
            const r = await ask('Edit', { file_path }, { description: reason })
            if (!allowed(r)) return { decision: { denied: { rejection: 'Denied by the user in triage.' } } }
          }
          return { decision: 'approved' }
        }
        // Extra sandbox access, questions and MCP forms have no prompt in
        // triage yet: grant nothing and answer, so the turn carries on.
        case 'item/permissions/requestApproval':
          return { permissions: {}, scope: 'turn' }
        case 'item/tool/requestUserInput':
          return { answers: {} }
        case 'mcpServer/elicitation/request':
          return { action: 'decline', content: null, _meta: null }
        default:
          throw new Error(`triage doesn't handle ${method}`)
      }
    }

    client.onExit = (err) => {
      turnDone?.()
      events.end(err)
    }

    void (async () => {
      await client.initialize()
      const base = {
        cwd: spec.cwd,
        ...(model ? { model } : {}),
        ...threadPolicy(mode),
        ...(spec.systemAppend ? { developerInstructions: spec.systemAppend } : {}),
      }
      const res = spec.resume
        ? await client.request<{ thread: { id: string }; model?: string }>('thread/resume', { threadId: spec.resume, ...base })
        : await client.request<{ thread: { id: string }; model?: string }>('thread/start', base)
      threadId = res.thread.id
      mapper = createCodexMapper(threadId)
      events.push(mapper.started(res.model))
      // One turn at a time: the next queued message waits for this one to end.
      for await (const turn of input) {
        const done = new Promise<void>((resolve) => (turnDone = resolve))
        await client.request('turn/start', {
          threadId,
          input: turnInput(turn),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(modeChanged ? turnPolicy(mode) : {}),
        })
        modeChanged = false
        await done
      }
      client.close()
      events.end()
    })().catch((err: unknown) => {
      client.close()
      events.end(err instanceof Error ? err : new Error(String(err)))
    })

    return {
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
      // Codex takes model and effort per turn: both apply from the next one.
      setModel: async (m) => {
        model = m
      },
      setEffort: async (e) => {
        effort = e ?? undefined
      },
      setFastMode: async () => {},
      setPermissionMode: async (m) => {
        if (m !== mode) modeChanged = true
        mode = m
      },
      commands: async () => [],
      interrupt: async () => {
        if (turnId) await client.request('turn/interrupt', { threadId, turnId })
      },
      stopTask: async () => {},
      backgroundTask: async () => {},
    }
  },

  run() {
    throw new Error("Codex can't run headless prompts: it has no tool-call veto")
  },

  async mcpStatus() {
    return []
  },

  models({ cwd, env }) {
    return withClient(cwd, env, async (c) => {
      // Paged; a handful of pages is far more than Codex lists.
      const data: unknown[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const res: { data?: unknown; nextCursor?: string | null } = await c.request('model/list', cursor ? { cursor } : {})
        if (Array.isArray(res.data)) data.push(...res.data)
        cursor = res.nextCursor ?? null
        if (!cursor) break
      }
      return codexModels(data)
    })
  },

  async commands() {
    return []
  },

  async checkAuth(env) {
    try {
      const res = await withClient(os.homedir(), env, (c) =>
        c.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', {}),
      )
      return res.account || !res.requiresOpenaiAuth ? { ok: true } : { ok: false, error: 'Codex is not logged in (run `codex login`)' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}
