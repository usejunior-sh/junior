/**
 * Sending the reply you approved (M4). Junior holds no Slack token: the send
 * goes through the Slack connector, from a one-turn headless run whose only
 * tool is slack_send_message. The model does not get to word it. The veto
 * lets exactly one call through, and only with the channel, the thread and
 * the message the card showed you, byte for byte. Anything else is refused.
 *
 * Pure.
 */
export const SLACK_SEND_TOOL = 'mcp__claude_ai_Slack__slack_send_message'

export type ApprovedSend = { channel: string; threadTs: string; message: string }

/** Whether this call is the approved send, exactly. */
export function isApprovedSend(toolName: string, input: unknown, want: ApprovedSend): { ok: true } | { ok: false; reason: string } {
  if (toolName !== SLACK_SEND_TOOL) return { ok: false, reason: `only ${SLACK_SEND_TOOL} may run here` }
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (a.channel_id !== want.channel) return { ok: false, reason: `channel_id must be ${want.channel}` }
  if (a.thread_ts !== want.threadTs) return { ok: false, reason: `thread_ts must be ${want.threadTs}` }
  if (a.message !== want.message) return { ok: false, reason: 'message must be exactly the approved text, unchanged' }
  if (a.reply_broadcast === true) return { ok: false, reason: 'no reply_broadcast: the reply stays in the thread' }
  if (a.draft_id !== undefined) return { ok: false, reason: 'no draft_id' }
  return { ok: true }
}

/** The run's one prompt: the call to make, as data. */
export function sendPrompt(want: ApprovedSend): string {
  return [
    `Load the tool with ToolSearch ("select:${SLACK_SEND_TOOL}"), then call ${SLACK_SEND_TOOL} exactly once with these arguments, unchanged:`,
    '```json',
    JSON.stringify({ channel_id: want.channel, thread_ts: want.threadTs, message: want.message }, null, 2),
    '```',
    'Then reply with the message link it returns, and nothing else. If the call fails, reply with the error.',
  ].join('\n')
}

/** The link the run reported back, if it gave one. */
export function sentLink(text: string): string | null {
  return /https:\/\/[\w.-]+\.slack\.com\/archives\/\S+/.exec(text)?.[0]?.replace(/[)>.,]+$/, '') ?? null
}
