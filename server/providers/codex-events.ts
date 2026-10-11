/**
 * Codex's app-server notifications as `ProviderEvent`s — the one place that
 * knows which notification means what. Pure: no process, no I/O, so a
 * recorded turn can be replayed through it in a test.
 *
 * Codex speaks in items (a message, a command, a patch) that start and
 * complete; the transcript speaks in Claude's shape (assistant `tool_use`, user
 * `tool_result`, a closing `result`). Each item is folded into that shape here,
 * so `record` is something `buildTranscript` already draws: a command is a
 * `Bash` card, a patch is one `Edit`/`Write` card per file (so the Changes view
 * and the turn's touched paths work), an MCP call is `mcp__<server>__<tool>`.
 */
import { isEffortLevel, type ModelOption, type RawBlock, type SdkMessage } from '../../shared/protocol.js'
import type { ProviderEvent, ToolCall } from './types.js'

/** The fields of a Codex thread item read here (see `codex app-server generate-ts`, v2/ThreadItem.ts). */
export type CodexItem = { type: string; id: string } & Record<string, unknown>

type FileChange = { path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null }; diff: string }

type TokenBreakdown = { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * `model/list`'s answer as the picker's rows. Hidden models are dropped. Codex
 * names its efforts with the same strings triage does (low…max), plus a few of
 * its own (`ultra`) that triage has no slot for, so those are left out — a
 * chosen effort then goes back to `turn/start` as the string Codex gave.
 */
export function codexModels(data: unknown): ModelOption[] {
  if (!Array.isArray(data)) return []
  return data
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof m.id === 'string' && m.hidden !== true)
    .map((m) => ({
      id: m.id as string,
      ...(typeof m.model === 'string' ? { resolvedModel: m.model } : {}),
      name: str(m.displayName) || (m.id as string),
      description: str(m.description),
      efforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
        .map((e) => (e as { reasoningEffort?: unknown } | null)?.reasoningEffort)
        .filter(isEffortLevel),
    }))
}

/**
 * The command a person typed, out of the login-shell wrapper Codex runs it in
 * (`/bin/zsh -lc 'cat notes.txt'` → `cat notes.txt`). Anything else is left as it is.
 */
export function unwrapShell(command: string): string {
  const single = /^\S*sh -l?c '((?:[^']|'\\'')*)'$/.exec(command)
  if (single) return single[1].replaceAll(`'\\''`, `'`)
  const double = /^\S*sh -l?c "((?:[^"\\]|\\.)*)"$/.exec(command)
  if (double) return double[1].replace(/\\([\\"$`])/g, '$1')
  return command
}

/**
 * A unified diff's hunks as the text before and after (context lines in both).
 * Lines keep their newline, except where `\ No newline at end of file` says
 * the line above it had none.
 */
export function splitDiff(diff: string): { before: string; after: string } {
  const before: string[] = []
  const after: string[] = []
  let inHunk = false
  let last: string[][] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue // file headers (---/+++) before the first hunk
    if (line.startsWith('\\')) {
      for (const side of last) side[side.length - 1] = side[side.length - 1].replace(/\n$/, '')
      continue
    }
    const sides = line.startsWith('-') ? [before] : line.startsWith('+') ? [after] : line.startsWith(' ') ? [before, after] : []
    for (const side of sides) side.push(`${line.slice(1)}\n`)
    if (sides.length) last = sides
  }
  return { before: before.join(''), after: after.join('') }
}

/**
 * One file of a patch as the edit tool Claude would have used: an added file
 * is a `Write` of its content, an update an `Edit` from its hunks, a delete an
 * `Edit` that empties it. `file_path` is what the touched-paths bookkeeping reads.
 */
export function fileChangeTool(change: FileChange): { name: string; input: Record<string, unknown> } {
  const file_path = change.kind.type === 'update' && change.kind.move_path ? change.kind.move_path : change.path
  if (change.kind.type === 'add') return { name: 'Write', input: { file_path, content: change.diff } }
  if (change.kind.type === 'delete') return { name: 'Edit', input: { file_path, old_string: change.diff, new_string: '' } }
  const { before, after } = splitDiff(change.diff)
  return { name: 'Edit', input: { file_path, old_string: before, new_string: after } }
}

const fileChangesOf = (item: CodexItem): FileChange[] =>
  Array.isArray(item.changes) ? (item.changes as FileChange[]).filter((c) => c && typeof c.path === 'string') : []

/** The tool calls an item stands for, in Claude's naming. Empty for anything that isn't a tool. */
export function toolCallsOf(item: CodexItem): ToolCall[] {
  switch (item.type) {
    case 'commandExecution':
      return [{ id: item.id, name: 'Bash', input: { command: unwrapShell(str(item.command)) } }]
    case 'fileChange':
      return fileChangesOf(item).map((c, i) => ({ id: `${item.id}:${i}`, ...fileChangeTool(c) }))
    case 'mcpToolCall': {
      const args = item.arguments && typeof item.arguments === 'object' ? (item.arguments as Record<string, unknown>) : {}
      return [{ id: item.id, name: `mcp__${str(item.server)}__${str(item.tool)}`, input: args }]
    }
    case 'webSearch':
      return [{ id: item.id, name: 'WebSearch', input: { query: str(item.query) } }]
    default:
      return []
  }
}

/** A completed tool item's output as `tool_result` blocks, one per call `toolCallsOf` made. */
function toolResultsOf(item: CodexItem): RawBlock[] {
  const calls = toolCallsOf(item)
  switch (item.type) {
    case 'commandExecution': {
      const exit = typeof item.exitCode === 'number' ? item.exitCode : null
      const failed = item.status === 'failed' || item.status === 'declined' || (exit !== null && exit !== 0)
      const out = str(item.aggregatedOutput) || (item.status === 'declined' ? 'Declined.' : '')
      return [{ type: 'tool_result', tool_use_id: item.id, content: out, is_error: failed }]
    }
    case 'fileChange': {
      const failed = item.status === 'failed' || item.status === 'declined'
      const text = failed ? (item.status === 'declined' ? 'Declined.' : 'Patch failed.') : 'Applied.'
      return calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: text, is_error: failed }))
    }
    case 'mcpToolCall': {
      const error = item.error as { message?: unknown } | null | undefined
      const result = item.result as { content?: unknown } | null | undefined
      const content = error ? str(error.message) || 'MCP call failed.' : Array.isArray(result?.content) ? result.content : JSON.stringify(result ?? null)
      return [{ type: 'tool_result', tool_use_id: item.id, content, is_error: !!error || item.status === 'failed' }]
    }
    case 'webSearch':
      return [{ type: 'tool_result', tool_use_id: item.id, content: 'Searched.' }]
    default:
      return []
  }
}

const assistant = (sessionId: string, content: RawBlock[]): SdkMessage => ({
  type: 'assistant',
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { role: 'assistant', content },
})

const user = (sessionId: string, content: RawBlock[]): SdkMessage => ({
  type: 'user',
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { role: 'user', content },
})

/**
 * The fold of one thread's notifications. Stateful only in what a turn
 * accumulates (its final answer, its token usage, which tool items have
 * already shown their call), so one mapper lives as long as its thread.
 */
export function createCodexMapper(threadId: string) {
  /** tool items whose call has been emitted, so completion only adds the result */
  const shown = new Set<string>()
  /** every item seen, by id: an approval request names only the item */
  const items = new Map<string, CodexItem>()
  let finalText = ''
  let lastText = ''
  let error = ''
  let tokensAtTurnStart: TokenBreakdown | null = null
  let tokens: TokenBreakdown | null = null

  const callEvent = (item: CodexItem): ProviderEvent[] => {
    const calls = toolCallsOf(item)
    if (!calls.length || shown.has(item.id)) return []
    shown.add(item.id)
    const blocks: RawBlock[] = calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }))
    return [{ kind: 'message', role: 'assistant', toolCalls: calls, record: assistant(threadId, blocks) }]
  }

  const completed = (item: CodexItem): ProviderEvent[] => {
    switch (item.type) {
      case 'agentMessage': {
        const text = str(item.text)
        if (!text.trim()) return []
        lastText = text
        if (item.phase === 'final_answer') finalText = text
        return [{ kind: 'message', role: 'assistant', toolCalls: [], record: assistant(threadId, [{ type: 'text', text }]) }]
      }
      case 'reasoning': {
        const parts = (Array.isArray(item.summary) && item.summary.length ? item.summary : item.content) as unknown[] | undefined
        const thinking = (parts ?? []).filter((p): p is string => typeof p === 'string').join('\n\n')
        if (!thinking.trim()) return []
        return [{ kind: 'message', role: 'assistant', toolCalls: [], record: assistant(threadId, [{ type: 'thinking', thinking }]) }]
      }
      default: {
        const results = toolResultsOf(item)
        if (!results.length) return []
        return [...callEvent(item), { kind: 'message', role: 'user', toolCalls: [], record: user(threadId, results) }]
      }
    }
  }

  return {
    /** The thread is up — its id is the resume key. */
    started(model?: string): ProviderEvent {
      return {
        kind: 'started',
        sessionId: threadId,
        ...(model ? { model } : {}),
        record: { type: 'system', subtype: 'init', session_id: threadId, ...(model ? { model } : {}), tools: [], mcp_servers: [] },
      }
    },

    /** The last-seen state of an item, by id. */
    item(id: string): CodexItem | undefined {
      return items.get(id)
    },

    /** One server notification as zero or more events. Unknown or noisy methods map to nothing. */
    notification(method: string, params: Record<string, unknown>): ProviderEvent[] {
      switch (method) {
        case 'turn/started':
          finalText = ''
          lastText = ''
          error = ''
          tokensAtTurnStart = tokens
          return []
        case 'item/agentMessage/delta':
          return [
            {
              kind: 'stream',
              record: { type: 'stream_event', session_id: threadId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: str(params.delta) } } },
            },
          ]
        case 'item/started': {
          const item = params.item as CodexItem | undefined
          if (!item?.id) return []
          items.set(item.id, item)
          return callEvent(item)
        }
        case 'item/completed': {
          const item = params.item as CodexItem | undefined
          if (!item?.id) return []
          items.set(item.id, item)
          return completed(item)
        }
        case 'thread/tokenUsage/updated': {
          const total = (params.tokenUsage as { total?: TokenBreakdown } | undefined)?.total
          if (total) tokens = total
          return []
        }
        case 'error': {
          const e = params.error as { message?: unknown } | undefined
          if (params.willRetry !== true) error = str(e?.message)
          return []
        }
        case 'turn/completed': {
          const turn = (params.turn ?? {}) as { status?: string; error?: { message?: unknown } | null; durationMs?: number | null }
          const ok = turn.status === 'completed'
          const text = ok ? finalText || lastText : str(turn.error?.message) || error || (turn.status === 'interrupted' ? 'Interrupted.' : '')
          // The thread's totals are cumulative: the turn's share is the difference.
          const d = (k: keyof TokenBreakdown) => Math.max(0, (tokens?.[k] ?? 0) - (tokensAtTurnStart?.[k] ?? 0))
          const cached = d('cachedInputTokens')
          const usage = { input_tokens: Math.max(0, d('inputTokens') - cached), output_tokens: d('outputTokens'), cache_read_input_tokens: cached }
          const total = d('totalTokens')
          tokensAtTurnStart = tokens
          shown.clear()
          items.clear()
          return [
            {
              kind: 'result',
              ok,
              overBudget: false,
              text,
              tokens: total,
              record: {
                type: 'result',
                subtype: ok ? 'success' : 'error_during_execution',
                is_error: !ok,
                session_id: threadId,
                result: text,
                duration_ms: turn.durationMs ?? 0,
                num_turns: 1,
                usage,
              } as SdkMessage,
            },
          ]
        }
        default:
          return []
      }
    },
  }
}

export type CodexMapper = ReturnType<typeof createCodexMapper>
