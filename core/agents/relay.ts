import type { AgentRelay } from '../../shared/protocol.js'

/**
 * What the main agent reads when the user writes to one of its subagents. The
 * SDK can't address a subagent directly, so main is asked to pass the text on
 * with SendMessage, verbatim, which also resumes an agent that has finished.
 * The transcript shows the raw text, marked as relayed, instead of this.
 */
export function frameAgentRelay(relay: AgentRelay, text: string): string {
  return [
    `[triage relay] The user wrote a message for your subagent "${relay.label}" (agentId ${relay.agentId}).`,
    `Pass it on unchanged: call SendMessage with to: "${relay.agentId}" and the message text below, word for word.`,
    `Don't answer it yourself and don't rephrase it. Then carry on with what you were doing.`,
    '',
    '<message>',
    text,
    '</message>',
  ].join('\n')
}
