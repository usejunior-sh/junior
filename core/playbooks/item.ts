/**
 * The first passes on work that comes from conversations and jobs (M4), for
 * any item, not just a PR (plan artifact cb50520f, "Rules"):
 *
 *   answer        read the thread and the code, draft a reply. Sending it is
 *                 a task on you ("Send reply"), from an editable card.
 *   investigate   read-only; an options brief on the item, then stop: its
 *                 recommendation waits for you ("Decide"). Do it, and the
 *                 change runs like an approved fix plan; or look again.
 *   debug-fix     plan first (debug-plan, read-only), then stop: the plan
 *                 waits for you ("Approve plan"). Approved, the fix runs in
 *                 a worktree and opens a draft PR, which babysit then keeps green.
 *
 * Each step is one short fresh session, like babysit's. What it learned goes
 * back on the item (memory), what it made is its output.
 *
 * Pure and browser-safe: the runner fills in the item and the folders.
 */
import { memoryBlock, reasonOf, type ItemMemory } from '../work/fields.js'
import type { WorkItem } from '../work/types.js'

export const ANSWER_STEP = 'answer'
export const SEND_REPLY_STEP = 'send-reply'
export const INVESTIGATE_STEP = 'investigate'
export const DECIDE_STEP = 'decide'
export const DEBUG_PLAN_STEP = 'debug-plan'
export const APPROVE_PLAN_STEP = 'approve-plan'
export const DEBUG_FIX_STEP = 'debug-fix'

/** Steps Junior runs on an item that isn't a PR it watches. */
export const ITEM_STEPS: readonly string[] = [ANSWER_STEP, INVESTIGATE_STEP, DEBUG_PLAN_STEP, DEBUG_FIX_STEP]
export const isItemStep = (step: string | undefined): boolean => !!step && ITEM_STEPS.includes(step)

/** Read-only steps: they read and hand in, never change a file or send. */
export const READ_ONLY_STEPS: readonly string[] = [ANSWER_STEP, INVESTIGATE_STEP, DEBUG_PLAN_STEP]

/** Model and cap per step (decided Oct 21: Sonnet reads and plans, Opus fixes). */
export const ITEM_STEP_RUN: Record<string, { model: string; capUsd: number }> = {
  [ANSWER_STEP]: { model: 'sonnet', capUsd: 0.5 },
  [INVESTIGATE_STEP]: { model: 'sonnet', capUsd: 1 },
  [DEBUG_PLAN_STEP]: { model: 'sonnet', capUsd: 1 },
  [DEBUG_FIX_STEP]: { model: 'opus', capUsd: 3 },
}

export const MAX_REPLY_CHARS = 4000

/** The branch a fix is made on: Junior's own, so pushing it is free. */
export function fixBranch(item: Pick<WorkItem, 'id' | 'title'>): string {
  const words = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  const tail = item.id.replace(/[^a-zA-Z0-9]+/g, '').slice(-6).toLowerCase()
  return `fix/${words || 'item'}-${tail}`
}

const READ_SOURCE: Record<string, string> = {
  slack: 'This came from Slack. Read the whole thread first: load the Slack tools with ToolSearch ("select:mcp__claude_ai_Slack__slack_read_thread,mcp__claude_ai_Slack__slack_read_channel,mcp__claude_ai_Slack__slack_read_user_profile") and read the thread at the link.',
  linear: 'This came from Linear. Read the issue and its comments with the Linear tools (load them with ToolSearch first).',
  github: 'This is on GitHub. Read it with `gh issue view` / `gh pr view` (read verbs only).',
}

function readSource(item: WorkItem): string {
  return READ_SOURCE[item.source] ?? 'Read what the link points to with whatever tool reaches it (a connector, `gh`, or WebFetch for a public page). If nothing reaches it, work from what is written here.'
}

/** The item, as every step's prompt shows it. */
export function itemBlock(item: WorkItem, memory: ItemMemory | undefined): string {
  const reason = reasonOf(item)
  const out = [
    '## The item',
    `**${item.title}**`,
    '',
    `- link: ${item.url || '(none)'}`,
    ...(item.repo || item.author ? [`- where: ${[item.repo, item.author ? `from ${item.author}` : ''].filter(Boolean).join(' · ')}`] : []),
    `- why it is here: ${reason}${item.label ? ` · it is a ${item.label}` : ''}`,
    ...(item.why ? [`- what matched: ${item.why}`] : []),
  ]
  if (item.description?.trim()) out.push('', item.description.trim())
  const mem = memoryBlock(memory)
  if (mem) out.push('', mem)
  return out.join('\n')
}

const clean = (lines: string[]) => lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n')

export function answerPrompt(item: WorkItem, project: { name: string; path: string }): string {
  return clean([
    `You are Junior, the user's junior engineer. ${item.author || 'Someone'} asked the user something. Draft the reply the user would send: they read it, edit it if they want, and send it themselves.`,
    '',
    '## How you work here',
    `- ${readSource(item)}`,
    `- The folder ${project.path} (${project.name}) is the user's code. Read it (Read, Grep, Glob, git log/show) when the question is about it: answer from what the code says, not from memory.`,
    '- Read-only. Change no file, send nothing, post nothing: those are refused. The reply goes out only when the user sends it.',
    '',
    itemBlock(item, item.memory),
    '',
    '## The reply',
    '- Write as the user, first person, to the person who asked. Plain and short, the way an engineer answers in Slack: the answer first, then the one detail that matters (a file, a command, a link).',
    '- No greeting, no sign-off, no "Great question". No promises on the user\'s behalf ("I\'ll fix it today").',
    '- If you could not confirm something, the reply says what to check, and `unsure` says it to the user. Never invent an answer.',
    '- If the thread was already answered, or nothing is asked, say so in `summary` and leave `reply` as one line the user may not need.',
    '',
    '## When you finish',
    'Call `submit_reply` once: `reply` (the message, Slack markdown), `summary` (one line for the user: what you answered), `unsure` (what you could not confirm, if anything), `decisions` (what a later task on this item should know). Then end your turn.',
  ])
}

export function investigatePrompt(item: WorkItem, project: { name: string; path: string }): string {
  return clean([
    "You are Junior, the user's junior engineer. Investigate this item and hand the user the options: they decide what to do.",
    '',
    '## How you work here',
    `- ${readSource(item)}`,
    `- The folder ${project.path} (${project.name}) is the user's code. Read it (Read, Grep, Glob, git log/show) to ground every option in what is there.`,
    '- Read-only. Change no file, send nothing.',
    '',
    itemBlock(item, item.memory),
    '',
    '## The brief',
    'Markdown, short, in this order:',
    '1. **The ask**: one or two lines, what is wanted and why.',
    '2. **What is there now**: the code and behaviour that matter, with `path:line`.',
    '3. **Options**: two to four, each with what it changes, the cost (rough size), and the risk.',
    '4. **Recommendation**: one option and why.',
    '5. **Open questions**: only the ones the user must answer.',
    '',
    '## When you finish',
    'Call `submit_brief` once: `title`, `body` (the whole brief), `summary` (one line: the recommendation, as what you would do: "Add Inbox to PAGE_TABS in App.tsx"), `decisions`. Then end your turn. The user decides next: if they say do it, a later task makes the change.',
  ])
}

export function debugPlanPrompt(item: WorkItem, project: { name: string; path: string }): string {
  return clean([
    "You are Junior, the user's junior engineer, on a bug. Find the cause and write the plan for the fix. Then stop: the user approves the plan before anything changes.",
    '',
    '## How you work here',
    `- ${readSource(item)} Read the error and stack trace in full when there is one.`,
    `- The folder ${project.path} (${project.name}) is the code. Read it, its tests and its history (git log/show/blame) to find where it breaks and why.`,
    '- Read-only. Change no file, run nothing that writes, send nothing. You may run read-only commands and the existing tests.',
    '',
    itemBlock(item, item.memory),
    '',
    '## The plan',
    'Markdown, short, in this order:',
    '1. **Cause**: what breaks and why, with the evidence (`path:line`, the stack frame, the commit that brought it in).',
    '2. **Fix**: the files to change and what changes in each. The smallest change that fixes the cause.',
    '3. **Test**: the test that would have caught it, and which existing tests to run.',
    '4. **Risk**: what else the change touches.',
    'If you could not find the cause, say what you ruled out and what you would need (logs, a repro, access), with `confidence: low`.',
    '',
    '## When you finish',
    'Call `submit_plan` once: `plan` (the markdown), `summary` (one line: cause and fix), `confidence` (high, medium or low), `decisions`. Then end your turn.',
  ])
}

export function debugFixPrompt(item: WorkItem, w: { branch: string; base: string; note?: string }): string {
  return clean([
    "You are Junior, the user's junior engineer. The user approved your plan for this item (the Plan below). Make the change and open a draft PR.",
    '',
    '## How you work here',
    `- This folder is your own worktree on a new branch, \`${w.branch}\`, from \`${w.base}\`. Change what the plan says, and nothing else.`,
    '- Add the test the plan names, and run the tests around the change until they pass. Fix what you broke.',
    `- Commit with a one-line message. Push your branch: \`git push -u origin HEAD:${w.branch}\`. Nothing else is pushed.`,
    `- Open a draft PR: \`gh pr create --draft --base ${w.base} --head ${w.branch} --title "<one line>" --body "<what and why, the link: ${item.url || 'none'}>"\`. A draft asks nobody to look yet; marking it ready or requesting a reviewer is the user's call.`,
    '- If the plan turns out wrong, stop: hand in blocked with what you found. Do not improvise a different fix.',
    ...(w.note ? ['', `The user's note on the plan: ${w.note}`] : []),
    '',
    itemBlock(item, item.memory),
    '',
    '## When you finish',
    'Call `submit_task` once: done (`summary`: one line with the draft PR\'s URL, `sha`: the commit you pushed) or blocked (`summary`: the question). Then end your turn.',
  ])
}

/** The Plan artifact on the item. */
export function planMarkdown(item: Pick<WorkItem, 'title' | 'url'>, plan: string, confidence: string): string {
  return [`# Plan: ${item.title}`, '', `${item.url ? `[the item](${item.url}) · ` : ''}confidence: **${confidence}**`, '', plan.trim(), '', '_Junior changes nothing until you approve this plan on the item._'].join('\n')
}

/** Slack's thread coordinates, read off a permalink: the channel, and the thread's root ts. */
export function slackThreadOf(permalink: string): { channel: string; threadTs: string } | null {
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(permalink)
  if (!m) return null
  const own = `${m[2]}.${m[3]}`
  let thread: string | null = null
  try {
    thread = new URL(permalink).searchParams.get('thread_ts')
  } catch {}
  return { channel: m[1]!, threadTs: thread && /^\d{10}\.\d{6}$/.test(thread) ? thread : own }
}
