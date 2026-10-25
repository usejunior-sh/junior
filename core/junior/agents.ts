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
 *   ---
 *   <the prompt>
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
  /** built-in tools it may use; null = every one a chat has */
  tools: string[] | null
  /** the only skills it loads; null = every skill */
  skills: string[] | null
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
    model: model && model !== 'inherit' ? model : null,
    tools: list(f.tools),
    skills: list(f.skills),
    prompt: bodyOf(text).trim(),
    path: at.path,
    scope: at.scope,
  }
}

/** How the agent is named everywhere: Junior first, the role after. */
export const agentTitle = (juniorName: string, label: string | null | undefined): string => (label ? `${juniorName} · ${label}` : juniorName)

/** Tools to take away: the gated built-ins its `tools` line leaves out. Never adds one. */
export function agentDisallowed(a: Pick<ChatAgent, 'tools'>): string[] {
  if (!a.tools) return []
  const keep = new Set(a.tools)
  return AGENT_GATED_TOOLS.filter((t) => !keep.has(t))
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
    a.tools ? `Your built-in tools here: ${a.tools.join(', ')}. Others are switched off for this chat.` : '',
    `If the user wants something outside this agent's job, say which agent fits better, or plain ${juniorName}. Never switch on your own.`,
    a.prompt ? `\n${a.prompt}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}
