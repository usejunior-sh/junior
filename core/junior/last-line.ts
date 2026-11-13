/**
 * A chat's latest line, for the sidebar (conversation rows, like a messages
 * app): what the agent last said, or what you last wrote, as one line of plain
 * text. Pure: the server folds every saved event of a DM through `lineOf`.
 */
import type { SessionEvent } from '../../shared/protocol.js'
import { isQuietReply } from './thread-wake.js'

/** Long enough to fill a sidebar row twice over; the row cuts it with an ellipsis. */
const LINE_MAX = 140

/** Markdown out, whitespace folded, cut at LINE_MAX. Empty when nothing readable is left. */
export function plainLine(text: string, max = LINE_MAX): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    // headings and quotes at a line's start, bold, inline code. "#498" and "webhook_spec.rb" stay as written.
    .replace(/^[ \t]{0,3}(#{1,6}|>)[ \t]?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

/**
 * The line this event leaves as the chat's latest, or null when it leaves none
 * (tool calls, notices, results, messages from other agents). An assistant
 * message counts by its text; your own message counts prefixed "You: ".
 */
export function lineOf(event: SessionEvent): string | null {
  if (event.kind === 'local_user') {
    if (event.from) return null
    const line = plainLine(event.text)
    return line ? `You: ${line}` : null
  }
  if (event.kind !== 'sdk') return null
  const m = event.message as { type?: string; message?: { content?: unknown } }
  if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) return null
  const text = (m.message.content as { type?: string; text?: unknown }[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join(' ')
  // A DM's quiet answer to a thread report isn't a line.
  if (isQuietReply(text)) return null
  return plainLine(text) || null
}
