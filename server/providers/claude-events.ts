/**
 * Claude's message stream as `ProviderEvent`s: the one place that knows which
 * SDK message means what. Pure: no SDK import, so a recorded stream can be
 * replayed through it in a test.
 */
import { isToolUseBlock, type SdkMessage } from '../../shared/protocol.js'
import type { CommandEntry, ProviderEvent } from './types.js'

/** The fields of an SDK message read here that the transcript's shape leaves out. */
type ClaudeMessage = SdkMessage & {
  result?: unknown
  is_error?: boolean
  usage?: Record<string, unknown>
}

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']

function sumTokens(usage: Record<string, unknown> | undefined): number {
  let tokens = 0
  for (const k of TOKEN_KEYS) {
    const v = usage?.[k]
    if (typeof v === 'number') tokens += v
  }
  return tokens
}

/** One SDK message as an event. `record` is the message itself, untouched. */
export function claudeEvent(msg: unknown): ProviderEvent {
  const m = msg as ClaudeMessage
  const record = m as SdkMessage
  // init and result both carry it, including why fast mode is not serving.
  const base =
    m.fast_mode_state !== undefined
      ? { record, fastMode: { state: m.fast_mode_state, reason: m.fast_mode_disabled_reason } }
      : { record }
  switch (m.type) {
    case 'stream_event':
      return { ...base, kind: 'stream' }
    case 'assistant':
    case 'user': {
      const toolCalls = (m.message?.content ?? []).filter(isToolUseBlock).map((b) => ({ id: b.id, name: b.name, input: b.input }))
      return { ...base, kind: 'message', role: m.type, toolCalls }
    }
    case 'result':
      return {
        ...base,
        kind: 'result',
        ok: m.subtype === 'success' && m.is_error !== true,
        overBudget: m.subtype === 'error_max_budget_usd',
        text: typeof m.result === 'string' ? m.result : '',
        ...(typeof m.total_cost_usd === 'number' ? { costUsd: m.total_cost_usd } : {}),
        tokens: sumTokens(m.usage),
      }
    case 'system':
      if (m.subtype === 'init') {
        return {
          ...base,
          kind: 'started',
          ...(m.session_id ? { sessionId: m.session_id } : {}),
          ...(m.model ? { model: m.model } : {}),
          ...(m.terminal_slash_commands ? { terminalCommands: m.terminal_slash_commands } : {}),
          ...(Array.isArray(m.tools) ? { tools: m.tools } : {}),
        }
      }
      if (m.subtype === 'commands_changed' && m.commands) {
        return { ...base, kind: 'commands', commands: m.commands as CommandEntry[] }
      }
      return { ...base, kind: 'other' }
    default:
      return { ...base, kind: 'other' }
  }
}

/** A raw SDK stream as events. */
export async function* claudeEvents(stream: AsyncIterable<unknown>): AsyncGenerator<ProviderEvent> {
  for await (const m of stream) yield claudeEvent(m)
}
