/**
 * Chat agents: Junior's personas. Any Settings → Agents file (a Claude Code
 * agent file) with `chat: true` is one. A chat picks one at the start and
 * talks as "Junior · <label>": the agent's prompt, skills and tools for that
 * chat, its colour on the face. Same face shape, same name first, same rules:
 * an agent only narrows what Junior may do, never widens it.
 *
 *   ---
 *   name: explainer
 *   label: Explainer
 *   description: Teaches code from the outside in.
 *   color: blue
 *   chat: true
 *   skills: book, indian-mode
 *   tools: Read, Grep, Glob
 *   ask: What do you want to understand?
 *   starters: Explain how this repo is laid out | Walk me through a request
 *   sends: none
 *   ---
 *   <the prompt>
 *
 * Sends work in lanes. `sends:` lists the kinds of send in the agent's job
 * (a Reviewer's review comments, a Babysitter's push): those it may propose
 * on its own when the job calls for one. Anything else it sends only when the
 * user asks for it in that chat, never unprompted. Either way the call goes
 * through the one policy (core/actions/policy.ts) and waits on a card: lanes
 * decide what an agent may propose, the card decides what leaves.
 *
 * Pure and browser-safe: the server lists and spawns with it, the web draws
 * faces and names with it.
 */
import { bodyOf, readFields } from '../../shared/skillFile.js'

export type ChatAgent = {
  /** what the session stores and Claude calls it: `junior:explainer`, `explainer` */
  name: string
  /** the file stem */
  slug: string
  /** "Explainer": the part after "Junior · " */
  label: string
  description: string
  /** the face's colour (`#rrggbb`), or null to wear the persona's */
  colour: string | null
  /** the model the agent asks for; null = the chat's own pick */
  model: string | null
  /** its question on a new chat ("What's broken?"); null = its starter's, or the generic one (agentOpener) */
  ask: string | null
  /** what its new chat offers to fill the box with, `|`-separated in the file; null = its starter's (agentOpener) */
  starters: string[] | null
  /** built-in tools it may use; null = every one a chat has */
  tools: string[] | null
  /** the only skills it loads; null = every skill */
  skills: string[] | null
  /** the send kinds in its lane (SEND_KINDS, or any a file names); null = its starter's (agentSends) */
  sends: string[] | null
  prompt: string
  path: string
  /** Workspace, Personal, a project's name */
  scope: string
}

/**
 * Claude Code's agent colours as faces: light key tops from the persona
 * swatches. Orange has none: it means "needs you" and nothing else, so an
 * orange agent wears the persona's colour.
 */
export const AGENT_FACE: Readonly<Record<string, string | null>> = {
  red: '#f7a1c4',
  pink: '#f9b8dc',
  blue: '#a9cdfc',
  cyan: '#6fd6c8',
  green: '#7fe0b4',
  yellow: '#f5d77a',
  purple: '#cbbffa',
  orange: null,
}

/** The colour Junior offers when it makes an agent, in order: never orange. */
export const CHAT_COLORS = ['blue', 'green', 'red', 'yellow', 'cyan', 'pink', 'purple'] as const

/** A face colour from an agent file's `color`: a named colour or `#rrggbb`; null = the persona's. */
export function agentFace(color: string | undefined | null): string | null {
  const c = (color ?? '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(c)) return c
  return AGENT_FACE[c] ?? null
}

/** The built-in tools an agent's `tools` line can take away. Everything else a chat has stays. */
export const AGENT_GATED_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebSearch', 'WebFetch']

const list = (v: string | undefined): string[] | null => {
  const xs = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return xs.length ? [...new Set(xs)] : null
}

const starterList = (v: string | undefined): string[] | null => {
  const xs = (v ?? '')
    .split('|')
    .map((s) => s.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 3)
  return xs.length ? xs : null
}

/**
 * The kinds of send a lane can name. A file may name others (a connector's
 * own, `pagerduty-ack`): they read as written.
 */
export const SEND_KINDS = ['push', 'pr', 'merge', 'github-review', 'github-comment', 'github-reply', 'slack-reply', 'slack-post', 'slack-dm', 'ticket', 'email'] as const

const SEND_LABEL: Readonly<Record<string, string>> = {
  push: 'a push',
  pr: 'a PR',
  merge: 'a merge',
  'github-review': 'a GitHub review',
  'github-comment': 'a GitHub comment',
  'github-reply': 'a reply on a GitHub thread',
  'slack-reply': 'a Slack reply',
  'slack-post': 'a Slack post',
  'slack-dm': 'a Slack DM',
  ticket: 'a ticket change',
  email: 'an email',
}

/** `sends: none` (or empty) is an empty lane; no line at all is null. */
const sendList = (v: string | undefined): string[] | null => {
  if (v === undefined) return null
  const xs = v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'none')
  return [...new Set(xs)]
}

const isOn = (v: string | undefined) => /^(true|yes|on)$/i.test((v ?? '').trim())

/** "code-reviewer" → "Code reviewer". */
export const labelOf = (slug: string): string => {
  const s = slug.replace(/[-_]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : slug
}

/** An agent file as a chat agent, or null when it isn't one (no `chat: true`). */
export function chatAgentFrom(text: string, at: { name: string; slug: string; path: string; scope: string }): ChatAgent | null {
  const f = readFields(text)
  if (!isOn(f.chat)) return null
  const model = (f.model ?? '').trim()
  return {
    name: at.name,
    slug: at.slug,
    label: (f.label ?? '').trim().slice(0, 40) || labelOf(f.name || at.slug),
    description: (f.description ?? '').trim(),
    colour: agentFace(f.color),
    ask: (f.ask ?? '').trim().slice(0, 80) || null,
    starters: starterList(f.starters),
    model: model && model !== 'inherit' ? model : null,
    tools: list(f.tools),
    skills: list(f.skills),
    sends: sendList(f.sends),
    prompt: bodyOf(text).trim(),
    path: at.path,
    scope: at.scope,
  }
}

/** What an agent's new chat says and offers: its question under the greeting, and starters that fill the box. */
export type AgentOpener = { ask: string; starters: string[] }

/** The seeded starters' openers (server/chat-agents.ts), so files written before `ask` and `starters` still get one. */
const OPENERS: Readonly<Record<string, AgentOpener>> = {
  babysitter: { ask: 'Which PR needs watching?', starters: ['Check CI on my open PRs', 'Fix the merge conflicts on my branch'] },
  debugger: { ask: "What's broken?", starters: ['Reproduce the failing test', 'Find out why CI is red on my branch'] },
  explainer: { ask: 'What do you want to understand?', starters: ['Explain how this repo is laid out', 'Walk me through how a request is handled'] },
  reviewer: { ask: 'What should I review?', starters: ['Review my uncommitted changes', 'First pass on my latest PR'] },
  writer: { ask: 'What are we writing?', starters: ['Draft a PR description for my branch', "Write a status update from today's commits"] },
}

/** The file's `ask` and `starters` win, then its starter's, then a plain question and none. */
export function agentOpener(a: Pick<ChatAgent, 'slug' | 'ask' | 'starters'>): AgentOpener {
  const seeded = OPENERS[a.slug]
  return { ask: a.ask ?? seeded?.ask ?? 'What can I help with?', starters: a.starters ?? seeded?.starters ?? [] }
}

/**
 * The starters' lanes, so files written before `sends` still get one. Merge is
 * in none: it goes out only when the user asks. Junior itself (no agent) may
 * propose any kind.
 */
const LANES: Readonly<Record<string, readonly string[]>> = {
  babysitter: ['push', 'github-reply'],
  debugger: [],
  explainer: [],
  reviewer: ['github-review', 'github-comment'],
  writer: ['slack-reply', 'slack-post', 'github-comment'],
}

/** The send kinds in an agent's lane: its file's `sends`, then its starter's, then none. */
export function agentSends(a: Pick<ChatAgent, 'slug' | 'sends'>): string[] {
  return a.sends ?? [...(LANES[a.slug] ?? [])]
}

/** How the agent is named everywhere: Junior first, the role after. */
export const agentTitle = (juniorName: string, label: string | null | undefined): string => (label ? `${juniorName} · ${label}` : juniorName)

/**
 * Tools to take away: the gated built-ins its `tools` line leaves out. Never
 * adds one. Bash stays even when left out: it is how a send the user asks for
 * goes out (`gh`, `git push`), and such an agent's shell runs sends only
 * (shellSendOnly).
 */
export function agentDisallowed(a: Pick<ChatAgent, 'tools'>): string[] {
  if (!a.tools) return []
  const keep = new Set(a.tools)
  return AGENT_GATED_TOOLS.filter((t) => t !== 'Bash' && !keep.has(t))
}

/** An agent whose `tools` line leaves Bash out keeps a shell for sends only: every command must be one (core/actions/policy.ts sendOnlyShell). */
export const shellSendOnly = (a: Pick<ChatAgent, 'tools'> | null | undefined): boolean => !!a?.tools && !a.tools.includes('Bash')

/**
 * The lane and the ask, as the agent reads them: what it may propose on its
 * own, and that a send the user asks for is made, not refused, and waits on
 * a card either way.
 */
export function sendsAppend(a: Pick<ChatAgent, 'slug' | 'sends'>, juniorName: string): string {
  const lane = agentSends(a)
  const named = lane.map((k) => SEND_LABEL[k] ?? k)
  return [
    `\n### Sends`,
    lane.length
      ? `In your lane: ${named.join(', ')}. Propose one of these on your own only when your job calls for it.`
      : `Nothing is in your lane: never propose a send on your own.`,
    `Outside your lane, make a send only when the user asks for it in this chat. Never unprompted.`,
    `When the user asks you to send, post, reply, push or merge, make the call yourself: the Slack connector, or gh and git in the shell. Don't refuse it, and don't hand it to another agent or back to ${juniorName}. It waits on a card for the user's OK, word for word.`,
    `A Slack message you write goes out in the user's voice: short sentences, common words, no preamble.`,
  ].join('\n')
}

/**
 * The owner's part of a scan job's run prompt (mode: scan, `agent:` set): who
 * the run is, and the agent's own instructions. The run's fence and headless
 * rule come after it, so they still win; the agent's tools and skills don't
 * widen the job's grants.
 */
export function agentRunAppend(a: ChatAgent, juniorName: string): string {
  const title = agentTitle(juniorName, a.label)
  const lines = [
    `\n\n## You are ${title}`,
    `This job is ${title}'s: ${juniorName}, working as the user's ${a.label.toLowerCase()}. Same name first, same rules.`,
    a.description ? `What this agent is for: ${a.description}` : '',
    a.prompt ? `\n${a.prompt}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * The agent's part of the system prompt. It sits after Junior's identity and
 * before the persona and its rules, so the rules still come last and win.
 */
export function agentAppend(a: ChatAgent, juniorName: string): string {
  const title = agentTitle(juniorName, a.label)
  const lines = [
    `\n\n## You are ${title}`,
    `In this chat you are ${title}: ${juniorName}, working as the user's ${a.label.toLowerCase()}. Same name first, same rules. Sign as ${title} when you name yourself.`,
    a.description ? `What this agent is for: ${a.description}` : '',
    a.skills ? `Your skills here: ${a.skills.join(', ')}.` : '',
    a.tools ? `Your built-in tools here: ${a.tools.join(', ')}. Others are switched off for this chat${shellSendOnly(a) ? ', except a shell that runs sends only' : ''}.` : '',
    `If the user wants work outside this agent's job, say which agent fits better, or plain ${juniorName}. Never switch on your own. A send the user asks for is not that: make it.`,
    a.prompt ? `\n${a.prompt}` : '',
    sendsAppend(a, juniorName),
  ]
  return lines.filter(Boolean).join('\n')
}
