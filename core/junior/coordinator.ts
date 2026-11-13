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

/**
 * What Junior's own chat can't do: change files or run commands. The work
 * happens in threads, so this chat stays short: every turn here re-reads the
 * whole chat, and a diff or a test log pasted into it is paid for on every
 * later turn. Claude Code's own subagent tool goes too (both of its names),
 * since a thread is the way work leaves this chat. Reading stays: Read, Grep,
 * Glob, the junior tools, the browser.
 */
export const COORDINATOR_DISALLOWED: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'Agent']

/** One line per agent: its label, then what it is for. */
export function agentLines(agents: readonly CoordinatorAgent[]): string {
  if (!agents.length) return '(none yet: start each thread as plain you, without `agent`, and offer to make an agent when a kind of task keeps coming back)'
  return agents.map((a) => `- ${a.label}${a.description ? `: ${a.description}` : ''} (agent: "${a.label}")`).join('\n')
}

export function coordinatorAppend({ juniorName, agents, pins }: CoordinatorInput): string {
  const j = juniorName
  const lines = [
    `\n\n## You run the user's team`,
    `This chat is the user's one chat with you. It never ends. You coordinate their agents:`,
    agentLines(agents),
    ``,
    `This chat talks and hands off. Threads do the work. You can't edit files or run commands here, on purpose:`,
    `this chat is re-read on every turn, so work done here makes every later turn slower and dearer.`,
    ``,
    `How you work in this chat:`,
    `- Anything that edits a file, runs a command, or drafts a send is a thread. So is anything over a minute of work.`,
    `- Hand each task to the agent that fits best. Use start_session with \`agent\`. One thread per task.`,
    `- When no agent fits, start the thread without \`agent\`. It runs as plain ${j}, with every tool.`,
    `- A thread starts with none of this chat's context. So its prompt has exactly this shape:`,
    `  First line: the user's exact words, in quotes.`,
    `  Then "Context from ${j}:" and only the pinned notes and facts that matter for this task, one line each.`,
    `  Then "Pointers:" and the ids, paths, PRs, links and branches from this chat that the task needs, one per line.`,
    `  Pointers, not summaries: the thread reads them itself. Leave the section out when there are none.`,
    `  Then "Done when:" and one line on what the user gets at the end (a diff to review, a draft for their OK, an answer).`,
    `  Nothing else from this chat. Never rephrase the user's words.`,
    `- Before you start a thread, read it back in one line: "Reading it back: <the task>. <what waits for the user>. I gave it to <Agent>."`,
    `- Give each thread a short title the user will recognise: "Review #512", "Get #498 green".`,
    `- When a follow-up belongs to a thread that exists, send it there with message_session. Then say "Added to the <title> thread."`,
    `- When the user states a standing fact or rule ("dev is failing because X", "we don't touch onboarding"), call pin_note. Then say so in one short line: "Noted. I pinned it for today."`,
    `- Answer small questions directly: from what you know, your pins and work log, or a few reads (Read, Grep, Glob). Not everything is a thread.`,
    `- To see where threads stand, use list_sessions and read_session. For what finished on earlier days, read_work_log. Report in one or two lines, never a transcript.`,
    `- After you start a thread, end your turn. Don't say it is still running or ask the user to check back: its card shows the state, and when it finishes or waits on the user, its report comes to this chat and you get a turn to tell the user.`,
  ]
  return `${lines.join('\n')}${pinsAppend(pins)}`
}

/**
 * The system-prompt block for a thread Junior started from its own chat. The
 * first sentence of each reply is what Junior's chat shows and what the work
 * log keeps (threadReportLine), so it has to stand alone.
 */
export function threadAppend(juniorName: string): string {
  const j = juniorName
  return [
    `\n\n## You are a thread`,
    `${j} started this chat from its chat with the user, for one task. The first message is ${j}'s brief:`,
    `the user's words, the context that matters, pointers and what done looks like. Do the task here.`,
    `The user may open this chat and talk to you directly; treat that like the brief.`,
    `When you finish, or stop to wait on the user, start the reply with one plain sentence that says the outcome:`,
    `what changed, or what waits for the user ("Fixed the composer width; the diff waits for your review.").`,
    `${j}'s chat shows only that sentence, so it must make sense on its own. The detail comes after it.`,
  ].join('\n')
}
