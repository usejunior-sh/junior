/**
 * How a tool call is sorted: an action (an effect that leaves this machine)
 * or not, and why. The table from the spec:
 *
 *   MCP connectors   1. the server's tool annotations → 2. verbs in the tool's
 *                    name (a write verb wins) → 3. unknown = an action
 *   Bash             split into simple commands; a part matching the outbound
 *                    list in the actions file is an action, and so is one
 *                    whose command only the shell knows (`$G push`, `xargs
 *                    git`: unknown = an action); nothing else is
 *   built-ins        never (Write, Edit… are local; Changes shows them)
 *
 * The actions file's overrides come first for both. Junior's own in-process
 * servers are local by construction, but only the ones the caller names in
 * `own` (core/actions/own.ts): a server's name proves nothing. Pure and
 * browser-safe.
 */
import { describePart, matchPart, parsePattern, pushTarget, splitCommand, unknownCommand, type BashPattern, type CommandPart } from './bash.js'
import { bashOverride, parseActionsFile, withOverride, type ActionRules } from './rules.js'
import type { ActionKind, ActionWhy } from './types.js'
import { NO_OWN_SERVERS, serverOf } from './own.js'

export { serverOf }

// Verb tokens that mark a connector call's intent. Written as word sets and
// matched against the tokens of a tool's leaf name, so both `slack_read_channel`
// (snake) and `getJiraIssue` (camel) classify the same way. The permission
// prompt's effect (server/index.ts classifyEffect) reads the same sets.
export const READ_VERBS = new Set([
  'read', 'search', 'list', 'get', 'fetch', 'lookup', 'view', 'query', 'describe', 'find', 'count', 'show', 'history', 'info',
])
export const WRITE_VERBS = new Set([
  'send', 'post', 'create', 'update', 'edit', 'delete', 'remove', 'add', 'schedule', 'transition', 'resolve',
  'comment', 'upsert', 'write', 'set', 'assign', 'merge', 'close', 'reopen', 'archive', 'move', 'upload',
  'publish', 'reply', 'draft', 'star', 'pin', 'react', 'approve', 'complete', 'cancel',
])

/** Lowercased word tokens of a tool's leaf name (splits camelCase and snake_case). */
export const wordsOf = (leaf: string): string[] => (leaf.match(/[A-Za-z][a-z]*/g) ?? []).map((w) => w.toLowerCase())

/** `mcp__<server>__<leaf>` → the leaf. */
export const leafOf = (toolName: string): string => toolName.slice(toolName.lastIndexOf('__') + 2)



/** What an MCP server says about one of its tools (absent = it didn't say). */
export type ToolHints = { readOnly?: boolean; destructive?: boolean; openWorld?: boolean }

export type SortedAction = {
  kind: ActionKind
  why: ActionWhy
  whyDetail: string | null
  summary: string
  /** git push: the branch the command names; '' = the current one, known from the result */
  pushBranch?: string
}

/** Does a tool name match an override entry (`mcp__x__y` or `mcp__x__*`)? */
export function toolMatches(entry: string, toolName: string): boolean {
  if (entry === toolName) return true
  return entry.endsWith('*') && toolName.startsWith(entry.slice(0, -1))
}

/**
 * What the overrides say about a connector tool: its own name beats a
 * `mcp__server__*` entry, so one tool of a server set aside can be counted
 * again. `on` = always an action, `off` = never, null = sort it.
 */
export function toolOverride(rules: ActionRules, toolName: string): { verdict: 'on' | 'off'; entry: string } | null {
  if (rules.action.includes(toolName)) return { verdict: 'on', entry: toolName }
  if (rules.notAction.includes(toolName)) return { verdict: 'off', entry: toolName }
  const off = rules.notAction.find((e) => toolMatches(e, toolName))
  if (off) return { verdict: 'off', entry: off }
  const on = rules.action.find((e) => toolMatches(e, toolName))
  return on ? { verdict: 'on', entry: on } : null
}

const humanize = (leaf: string): string => {
  const w = wordsOf(leaf)
  const s = w.join(' ')
  return s ? s[0].toUpperCase() + s.slice(1) : leaf
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one
}

/** The input field that best names what a connector call made. */
const NAMING_KEYS = ['title', 'summary', 'subject', 'name', 'text', 'message', 'body', 'content', 'comment', 'query']

/** One line for a connector call: its verb phrase and what it named. */
export function describeTool(toolName: string, input: Record<string, unknown>): string {
  const what = humanize(leafOf(toolName))
  for (const k of NAMING_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return clip(`${what}: ${v}`, 140)
  }
  return what
}

/** What kind of action a connector call is, from the words in its name and its server. */
export function kindOfTool(toolName: string): ActionKind {
  const leaf = wordsOf(leafOf(toolName))
  const all = new Set([...leaf, ...wordsOf(serverOf(toolName))])
  const has = (...w: string[]) => w.some((x) => all.has(x))
  const leafHas = (...w: string[]) => w.some((x) => leaf.includes(x))
  if (leafHas('comment', 'reply', 'review', 'react')) return 'comment'
  if (leafHas('merge')) return 'merge'
  if (has('gmail', 'email', 'mail', 'outlook')) return 'email'
  if (leafHas('pull', 'pr') && leafHas('create', 'open')) return 'pr'
  // `save` isn't a write verb (the prompt's effect reads that list), but Linear's
  // save_issue files one all the same.
  if (leafHas('issue', 'ticket', 'task', 'bug') && leafHas('create', 'add', 'file', 'save')) return 'ticket'
  if (has('slack', 'teams', 'discord', 'chat') && leafHas('send', 'post', 'schedule', 'message')) return 'message'
  if (leafHas('message') && leafHas('send', 'post', 'schedule')) return 'message'
  if (leafHas('post', 'tweet', 'publish', 'thread')) return 'post'
  if (leafHas('update', 'edit', 'set', 'transition', 'close', 'reopen', 'move', 'assign', 'archive', 'resolve', 'complete', 'delete', 'remove')) return 'update'
  return 'other'
}

/** The order a Bash call that does several outbound things is recorded by, the headline wins. */
const KIND_RANK: ActionKind[] = ['pr', 'ticket', 'comment', 'merge', 'release', 'post', 'message', 'email', 'update', 'push', 'other']

function sortBash(command: string, rules: ActionRules): SortedAction | null {
  const parts = splitCommand(command)
  const skip = rules.notAction.map(bashOverride).filter((p): p is BashPattern => !!p && typeof p !== 'string')
  const forced = rules.action.map(bashOverride).filter((p): p is BashPattern => !!p && typeof p !== 'string')
  // `pattern: null`: no pattern matched, but only the shell knows what the part runs.
  const hits: Array<{ kind: ActionKind; pattern: BashPattern | null; part: CommandPart; why: ActionWhy }> = []
  for (const part of parts) {
    if (skip.some((p) => matchPart(part, p) >= 0)) continue
    const own = forced.find((p) => matchPart(part, p) >= 0)
    if (own) {
      hits.push({ kind: rules.bash.find((b) => matchPart(part, b.pattern) >= 0)?.kind ?? 'other', pattern: own, part, why: 'override' })
      continue
    }
    const b = rules.bash.find((x) => matchPart(part, x.pattern) >= 0)
    if (b) hits.push({ kind: b.kind, pattern: b.pattern, part, why: 'bash pattern' })
    else if (unknownCommand(part)) hits.push({ kind: 'other', pattern: null, part, why: 'unknown' })
  }
  if (!hits.length) return null
  const lead = [...hits].sort((a, b) => KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind))[0]
  const patterns = [...new Set(hits.flatMap((h) => (h.pattern ? [h.pattern.text] : [])))]
  return {
    kind: lead.kind,
    why: lead.why,
    whyDetail: patterns.length ? patterns.join(', ') : null,
    summary: lead.pattern ? describePart(lead.part, lead.pattern) : clip(lead.part.join(' '), 140),
    ...(lead.kind === 'push' ? { pushBranch: pushTarget(lead.part) ?? '' } : {}),
  }
}

/**
 * Sort one tool call. Null = not an action (a read, a local write, or a
 * command nothing in the list matches); otherwise what it is and why.
 */
export function sortCall(
  toolName: string,
  input: Record<string, unknown>,
  /** own: the session's in-process servers (ownServersOf); omitted = none, so every MCP call is sorted */
  ctx: { rules: ActionRules; hints?: ToolHints; own?: ReadonlySet<string> },
): SortedAction | null {
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return cmd.trim() ? sortBash(cmd, ctx.rules) : null
  }
  // Every other built-in touches this machine at most.
  if (!toolName.startsWith('mcp__')) return null
  if ((ctx.own ?? NO_OWN_SERVERS).has(serverOf(toolName))) return null

  const summary = describeTool(toolName, input)
  const kind = kindOfTool(toolName)
  const set = toolOverride(ctx.rules, toolName)
  if (set?.verdict === 'off') return null
  if (set) return { kind, why: 'override', whyDetail: set.entry, summary }

  // 1. The server's own word, when it gave one.
  const h = ctx.hints
  if (h?.readOnly === true) return null
  if (h?.openWorld === false) return null
  if (h?.destructive === true) return { kind, why: 'annotation', whyDetail: 'destructive', summary }
  if (h?.readOnly === false) return { kind, why: 'annotation', whyDetail: 'not read-only', summary }

  // 2. The verbs in its name: a write verb wins over a read verb.
  const words = wordsOf(leafOf(toolName))
  const write = words.find((w) => WRITE_VERBS.has(w))
  if (write) return { kind, why: 'name verb', whyDetail: write, summary }
  if (words.some((w) => READ_VERBS.has(w))) return null

  // 3. Can't tell: count it; a wrong "yes" is one click to fix, a wrong "no" is invisible.
  return { kind, why: 'unknown', whyDetail: null, summary }
}

/**
 * A call the sort couldn't judge (it threw): counted as an action, as an
 * unknown tool is. The hold fails closed; a wrong "yes" is one click to fix.
 */
export function unsortedAction(toolName: string, input: Record<string, unknown>): SortedAction {
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return { kind: 'other', why: 'unknown', whyDetail: null, summary: clip(cmd.trim() || 'a shell command', 140) }
  }
  return { kind: toolName.startsWith('mcp__') ? kindOfTool(toolName) : 'other', why: 'unknown', whyDetail: null, summary: describeTool(toolName, input) }
}

/** The patterns a Bash record counted by, as written in its why ("git push, gh pr create"). */
export function bashPatternsOf(whyDetail: string | null): string[] {
  return (whyDetail ?? '')
    .split(', ')
    .map((t) => {
      const p = parsePattern(t)
      return typeof p === 'string' ? '' : p.text
    })
    .filter(Boolean)
}

/** The patterns of the file's `not_action` `Bash(…)` entries, as normalised text. */
export function bashOffPatterns(rules: ActionRules): Set<string> {
  return new Set(
    rules.notAction
      .map(bashOverride)
      .filter((p): p is BashPattern => !!p && typeof p !== 'string')
      .map((p) => p.text),
  )
}

/**
 * Has the actions file since said this record is not an action? Such records
 * stay stored, "This is an action" brings them back, but leave the list.
 * Never re-sorted from stored args (those can be clipped): a Bash record is
 * set aside when every pattern it counted by has a `not_action` `Bash(…)`
 * entry; a connector by its name alone.
 */
export function overriddenOff(rec: { tool: string; whyDetail: string | null }, rules: ActionRules): boolean {
  if (rec.tool === 'Bash') {
    const pats = bashPatternsOf(rec.whyDetail)
    const off = bashOffPatterns(rules)
    return pats.length > 0 && pats.every((p) => off.has(p))
  }
  return toolOverride(rules, rec.tool)?.verdict === 'off'
}

/** What a row's override writes: a connector's name, or `Bash(<p>)` for each pattern a command counted by. */
export function overrideEntries(rec: { tool: string; whyDetail: string | null }): string[] {
  return rec.tool === 'Bash' ? bashPatternsOf(rec.whyDetail).map((p) => `Bash(${p})`) : [rec.tool]
}

/**
 * A row's "Not an action" / "This is an action", applied to the actions
 * file's text. Worked from what the record stored, its tool, or for Bash the
 * patterns it counted by, never by re-sorting its (possibly clipped) args.
 * Not an action: its entries join `not_action` and leave `action`.
 * This is an action: the `not_action` entries that hide it go, a server-wide
 * `mcp__x__*` stays, outranked by the tool's own name in `action`, and a
 * connector that sorting alone still wouldn't count joins `action`.
 */
export function withRowOverride(
  text: string,
  rec: { tool: string; whyDetail: string | null; args: Record<string, unknown> },
  verdict: 'action' | 'not_action',
  hints?: ToolHints,
): string {
  const bash = rec.tool === 'Bash'
  const entries = overrideEntries(rec)
  if (verdict === 'not_action') {
    for (const e of entries) text = withOverride(withOverride(text, 'action', e, false), 'not_action', e, true)
    return text
  }
  const pats = new Set(bashPatternsOf(rec.whyDetail))
  for (const e of parseActionsFile(text).rules.notAction) {
    const p = bashOverride(e)
    const hides = bash ? !!p && typeof p !== 'string' && pats.has(p.text) : e === rec.tool
    if (hides) text = withOverride(text, 'not_action', e, false)
  }
  if (!bash && !sortCall(rec.tool, rec.args, { rules: parseActionsFile(text).rules, hints })) text = withOverride(text, 'action', rec.tool, true)
  return text
}
