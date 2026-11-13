/**
 * Junior's own chat as the coordinator (redesign B2, .docs/redesign-b2-plan.md):
 * the user talks to one Junior, in one chat that never ends, and Junior hands
 * each task to one of their agents as a thread that starts clean. This is the
 * part of that chat's system prompt that says how. It sits after the identity
 * and before the persona, so the persona's rules still come last.
 *
 * Down, a brief: the user's exact words plus only the pinned notes that matter.
 * Up, a summary: the thread's card in the app, never its transcript.
 *
 * Pure and browser-safe.
 */
import { type Pin, pinsAppend } from './pins.js'

export type CoordinatorAgent = { name: string; label: string; description: string }

export type CoordinatorInput = {
  juniorName: string
  /** the chat agents this workspace has, in the order the app lists them */
  agents: readonly CoordinatorAgent[]
  /** the pinned notes that hold now */
  pins: readonly Pin[]
}

/** One line per agent: its label, then what it is for. */
export function agentLines(agents: readonly CoordinatorAgent[]): string {
  if (!agents.length) return '(none yet: do the work yourself, and offer to make an agent when a kind of task keeps coming back)'
  return agents.map((a) => `- ${a.label}${a.description ? `: ${a.description}` : ''} (agent: "${a.label}")`).join('\n')
}

export function coordinatorAppend({ juniorName, agents, pins }: CoordinatorInput): string {
  const j = juniorName
  const lines = [
    `\n\n## You run the user's team`,
    `This chat is the user's one chat with you. It never ends. You coordinate their agents:`,
    agentLines(agents),
    ``,
    `How you work in this chat:`,
    `- Hand each concrete task to the agent that fits best. Use start_session with \`agent\`. One thread per task.`,
    `- A thread starts with none of this chat's context. So its prompt has exactly this shape:`,
    `  First line: the user's exact words, in quotes.`,
    `  Then "Context from ${j}:" and only the pinned notes and facts that matter for this task, one line each.`,
    `  Nothing else from this chat. Never rephrase the user's words.`,
    `- Before you start a thread, read it back in one line: "Reading it back: <the task>. <what waits for the user>. I gave it to <Agent>."`,
    `- Give each thread a short title the user will recognise: "Review #512", "Get #498 green".`,
    `- When a follow-up belongs to a thread that exists, send it there with message_session. Then say "Added to the <title> thread."`,
    `- When the user states a standing fact or rule ("dev is failing because X", "we don't touch onboarding"), call pin_note. Then say so in one short line: "Noted. I pinned it for today."`,
    `- When no agent fits the task, do it yourself, here.`,
    `- Answer small questions directly. Not everything is a thread.`,
    `- To see where threads stand, use list_sessions and read_session. Report in one or two lines, never a transcript.`,
    `- After you start a thread, end your turn. Don't say it is still running or ask the user to check back: its card shows the state, and a line lands in this chat when it replies.`,
  ]
  return `${lines.join('\n')}${pinsAppend(pins)}`
}
