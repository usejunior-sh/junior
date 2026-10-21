/**
 * Card specs (artifact 6cc4c9e2, plan 31bfb899): how a held send reads on its
 * card. A spec names a tool (a glob over the full tool name), picks one of the
 * built-in layouts and puts the call's args in fixed slots. It never writes
 * what the card says: every arg shows, in "All fields" when no slot takes it,
 * and what runs is the args you approved, never the spec.
 *
 * Built-ins ship in ./builtin.ts; a workspace's `cards/<id>.json` for the same
 * tool wins. A tool no spec names gets the generic layout, placed from the
 * args themselves: the SDK reports MCP tools' names, not their input schemas.
 *
 * Pure and browser-safe: the server places the card, the web reads the values.
 */
import { type ActionKind, isActionKind } from '../actions/types.js'

export type CardLayout = 'message' | 'email' | 'ticket' | 'generic'
export const CARD_LAYOUTS: readonly CardLayout[] = ['message', 'email', 'ticket', 'generic']

/**
 * How one field edits. line: one line of text · text / markdown: a text box ·
 * list: a list of words, comma-separated · number · boolean · json: an object or a list, as JSON · a list: one of a
 * fixed set of options (a switch), strings or numbers as the tool takes them.
 */
export type FieldEdit = 'line' | 'text' | 'markdown' | 'list' | 'number' | 'boolean' | 'json' | ReadonlyArray<string | number>

export type CardSpec = {
  /** the file's name without `.json`, or the built-in's id: "slack.send_message" */
  id: string
  /** a glob over the full tool name, `*` only: "mcp__*Slack__slack_send_message" */
  tool: string
  layout: CardLayout
  /** what the send is, for Junior's log and the quick ✓; the sort's guess when absent */
  kind?: ActionKind
  /** the main button: "Send", "Create" */
  verb?: string
  /** where it goes, in words: "Slack" */
  name?: string
  /** the head's title, `{arg}` filled from the args as one line: "Reply in {channel_id}" */
  title?: string
  /** where it goes: shown above the body, never as the body */
  target?: string[]
  /** short facts in a row: priority, labels, assignee */
  chips?: string[]
  /** the one line that leads the body: an email's subject, a ticket's title */
  subject?: string
  /** what a person will read */
  body?: string
  /** how fields edit, where the value's own type isn't enough (an enum, markdown) */
  edit?: Record<string, FieldEdit>
  /** words for arg names: { "channel_id": "channel" } */
  labels?: Record<string, string>
  /** set by whoever loaded it, never in a file */
  source?: 'builtin' | 'workspace'
}

const SPEC_KEYS = ['tool', 'layout', 'kind', 'verb', 'name', 'title', 'target', 'chips', 'subject', 'body', 'edit', 'labels'] as const
const EDIT_WORDS = ['line', 'text', 'markdown', 'list', 'number', 'boolean', 'json'] as const

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0)

/** A spec file's id: what a file may be called. */
export const isSpecId = (id: string): boolean => /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)

/**
 * A spec from a file's JSON, strictly: an unknown key is an error, so a typo
 * never silently does nothing. An arg may sit in one slot only.
 */
export function parseCardSpec(id: string, raw: unknown): { ok: true; spec: CardSpec } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error: `${id}: ${error}` })
  if (!isSpecId(id)) return bad('the file name may hold letters, digits, dots, dashes and underscores only')
  if (!isObj(raw)) return bad('a card spec is a JSON object')
  for (const k of Object.keys(raw)) if (!(SPEC_KEYS as readonly string[]).includes(k)) return bad(`unknown key "${k}" (keys: ${SPEC_KEYS.join(', ')})`)
  const { tool, layout, kind, verb, name, title, target, chips, subject, body, edit, labels } = raw
  if (typeof tool !== 'string' || !tool.trim()) return bad('"tool" is required: a tool name, `*` matches anything')
  if (typeof layout !== 'string' || !CARD_LAYOUTS.includes(layout as CardLayout)) return bad(`"layout" is one of ${CARD_LAYOUTS.join(', ')}`)
  if (kind !== undefined && !isActionKind(kind)) return bad(`"kind" is not a kind of send: ${String(kind)}`)
  for (const [k, v] of Object.entries({ verb, name, title, subject, body })) {
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) return bad(`"${k}" is a non-empty string`)
  }
  for (const [k, v] of Object.entries({ target, chips })) {
    if (v !== undefined && !isStrList(v)) return bad(`"${k}" is a list of arg names`)
  }
  const placed = [...((target as string[] | undefined) ?? []), ...((chips as string[] | undefined) ?? []), ...[subject, body].filter((x): x is string => typeof x === 'string')]
  const twice = placed.find((k, i) => placed.indexOf(k) !== i)
  if (twice) return bad(`"${twice}" sits in two slots; an arg goes in one`)
  let edits: Record<string, FieldEdit> | undefined
  if (edit !== undefined) {
    if (!isObj(edit)) return bad('"edit" maps arg names to how they edit')
    edits = {}
    for (const [k, v] of Object.entries(edit)) {
      if (typeof v === 'string' && (EDIT_WORDS as readonly string[]).includes(v)) edits[k] = v as FieldEdit
      else if (Array.isArray(v) && v.length > 0 && v.every((o) => typeof o === 'string' || typeof o === 'number')) edits[k] = v as Array<string | number>
      else return bad(`"edit.${k}" is one of ${EDIT_WORDS.join(', ')}, or a list of options`)
    }
  }
  if (labels !== undefined && !(isObj(labels) && Object.values(labels).every((v) => typeof v === 'string' && v.trim()))) return bad('"labels" maps arg names to words')
  const spec: CardSpec = { id, tool: tool.trim(), layout: layout as CardLayout }
  if (kind !== undefined) spec.kind = kind as ActionKind
  if (verb !== undefined) spec.verb = (verb as string).trim()
  if (name !== undefined) spec.name = (name as string).trim()
  if (title !== undefined) spec.title = title as string
  if (target !== undefined) spec.target = target as string[]
  if (chips !== undefined) spec.chips = chips as string[]
  if (subject !== undefined) spec.subject = subject as string
  if (body !== undefined) spec.body = body as string
  if (edits) spec.edit = edits
  if (labels !== undefined) spec.labels = labels as Record<string, string>
  return { ok: true, spec }
}

/**
 * Does a spec's glob name this tool? `*` matches any run of characters,
 * nothing else is special, and case doesn't count: one spec covers the
 * claude.ai connector (`claude_ai_Linear`) and a local `linear` server.
 */
export function toolMatches(glob: string, tool: string): boolean {
  const re = new RegExp('^' + glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
  return re.test(tool)
}

/** The first spec that names the tool. Pass the workspace's specs before the built-ins, so a file wins. */
export function specFor(tool: string, specs: readonly CardSpec[]): CardSpec | null {
  return specs.find((s) => toolMatches(s.tool, tool)) ?? null
}

/**
 * Where a card's args go, without their values: the server works it out, the
 * web reads each value from the args it already has. Every arg key is in
 * exactly one of target, chips, subject, body or rest.
 */
export type CardPlan = {
  /** the spec's id; null = no spec named the tool, so the generic layout */
  spec: string | null
  source: 'builtin' | 'workspace' | null
  layout: CardLayout
  /** where it goes, in words: "Slack", "Linear" */
  name: string
  /** the main button */
  verb: string
  /** the head's title, filled from the args; null = the action's own title stands */
  title: string | null
  kind: ActionKind | null
  target: string[]
  chips: string[]
  subject: string | null
  body: string | null
  /** every arg no slot took, in the args' order: "All fields" */
  rest: string[]
  /** how each arg edits, one entry per arg */
  edit: Record<string, FieldEdit>
  /** the words for each arg's name */
  labels: Record<string, string>
}

/** Where the generic layout looks, best first: the same words the old payload view read. */
const TARGET_KEYS = ['to', 'cc', 'channel', 'channel_id', 'channel_name', 'recipient', 'recipients', 'repo', 'team', 'project', 'projectKey', 'issue', 'issueId', 'issueIdOrKey', 'pr', 'thread_ts']
const SUBJECT_KEYS = ['subject', 'title', 'summary', 'name']
const BODY_KEYS = ['text', 'body', 'message', 'markdown', 'content', 'comment', 'commentBody', 'description']

const hasValue = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())

/** A list of plain words (labels, assignees): edits as one comma-separated line. */
const isWordList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && !x.includes(','))

/** A fixed set of options, not a word. */
export const isOptions = (e: FieldEdit): e is ReadonlyArray<string | number> => Array.isArray(e)

/** How a value edits when no spec says: by its own type. */
export function inferEdit(v: unknown): FieldEdit {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'string') return v.includes('\n') || v.length > 80 ? 'text' : 'line'
  if (v === null || v === undefined) return 'line'
  if (isWordList(v)) return 'list'
  return 'json'
}

/** A value as the card shows it: text as is, a list of words joined, anything else as JSON. */
export function fieldText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return ''
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join(', ')
  return JSON.stringify(v, null, 2)
}

/** What an edit box starts with: JSON for a json field, so it parses back; the card's text otherwise. */
export function editText(v: unknown, e: FieldEdit): string {
  return e === 'json' ? JSON.stringify(v ?? null, null, 2) : fieldText(v)
}

/** One line of a value, for a title or a chip. */
const oneLine = (v: unknown, max = 80): string => {
  const s = fieldText(v).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** "{channel_id}" filled from the args, one line; a missing arg leaves nothing, and dangling " · " go. */
export function fillTitle(template: string, args: Record<string, unknown>): string {
  const filled = template.replace(/\{([^{}]+)\}/g, (_, k: string) => oneLine(args[k.trim()]))
  return filled
    .split(' · ')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "mcp__claude_ai_Slack__slack_send_message" → "Slack"; "mcp__linear__create_issue" → "linear". */
export function serverName(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const rest = tool.slice('mcp__'.length)
  const cut = rest.lastIndexOf('__')
  const server = cut > 0 ? rest.slice(0, cut) : rest
  return server.replace(/^claude_ai_/, '').replace(/_/g, ' ').trim() || tool
}

/** "mcp__claude_ai_Slack__slack_send_message" → "slack_send_message". */
export function toolShortName(tool: string): string {
  const cut = tool.lastIndexOf('__')
  return cut >= 0 ? tool.slice(cut + 2) : tool
}

/**
 * Place a call's args on its card. With a spec: its slots, keeping only args
 * the call has. Without: the generic layout picks a target, a subject and a
 * body by name. Either way every arg lands somewhere.
 */
export function planCard(tool: string, args: Record<string, unknown>, specs: readonly CardSpec[]): CardPlan {
  const spec = specFor(tool, specs)
  const keys = Object.keys(args)
  const present = (k: string) => keys.includes(k) && hasValue(args[k])
  const taken = new Set<string>()
  const take = (list: readonly string[] | undefined): string[] => {
    const out: string[] = []
    for (const k of list ?? []) if (present(k) && !taken.has(k)) (taken.add(k), out.push(k))
    return out
  }
  const takeOne = (list: readonly string[] | undefined): string | null => take(list).slice(0, 1)[0] ?? null
  const firstOf = (list: readonly string[]) => list.filter((k) => present(k)).slice(0, 1)

  const target = take(spec ? spec.target : TARGET_KEYS.filter((k) => present(k)).slice(0, 3))
  const chips = take(spec?.chips)
  // A spec's subject or body the call doesn't carry falls back to the generic pick, so the text
  // a person reads never hides under "All fields" because a connector named its arg differently.
  const byName = (list: readonly string[]) => firstOf(list.filter((k) => typeof args[k] === 'string' && !taken.has(k)))
  const subject = takeOne(spec?.subject && present(spec.subject) ? [spec.subject] : spec && !spec.subject ? [] : byName(SUBJECT_KEYS))
  const body = takeOne(spec?.body && present(spec.body) ? [spec.body] : spec && !spec.body ? [] : byName(BODY_KEYS))
  const rest = keys.filter((k) => !taken.has(k))

  const edit: Record<string, FieldEdit> = {}
  for (const k of keys) {
    const want = spec?.edit?.[k]
    // A spec's word may refine a string, never turn a number or a list into text.
    edit[k] = want && editFits(want, args[k]) ? want : inferEdit(args[k])
  }
  const labels: Record<string, string> = {}
  for (const k of keys) labels[k] = spec?.labels?.[k] ?? k

  const title = spec?.title ? fillTitle(spec.title, args) || null : null
  return {
    spec: spec?.id ?? null,
    source: spec ? (spec.source ?? 'builtin') : null,
    layout: spec?.layout ?? 'generic',
    name: spec?.name ?? serverName(tool),
    verb: spec?.verb ?? 'Approve',
    title,
    kind: spec?.kind ?? null,
    target,
    chips,
    subject,
    body,
    rest,
    edit,
    labels,
  }
}

/** May this edit apply to this value? Text words only on strings (or nothing yet); options on a value of their type. */
function editFits(e: FieldEdit, v: unknown): boolean {
  if (isOptions(e)) return v === undefined || v === null || e.some((o) => typeof o === typeof v)
  if (e === 'line' || e === 'text' || e === 'markdown') return v === undefined || v === null || typeof v === 'string'
  if (e === 'list') return v === undefined || v === null || isWordList(v)
  if (e === 'number') return typeof v === 'number'
  if (e === 'boolean') return typeof v === 'boolean'
  return typeof v === 'object'
}

/**
 * Your edits back into args, each in its own type: a number stays a number, a
 * list stays a list. Edits come as the text the boxes hold; an arg you didn't
 * touch is left exactly as it was.
 */
export function applyEdits(
  args: Record<string, unknown>,
  edit: Readonly<Record<string, FieldEdit>>,
  edits: Readonly<Record<string, string>>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const next: Record<string, unknown> = { ...args }
  for (const [k, text] of Object.entries(edits)) {
    if (!(k in args)) return { ok: false, error: `"${k}" is not an arg of this call` }
    const e = edit[k] ?? inferEdit(args[k])
    if (text === editText(args[k], e)) continue
    if (isOptions(e)) {
      const o = e.find((x) => String(x) === text)
      if (o === undefined) return { ok: false, error: `"${k}" is one of ${e.join(', ')}` }
      next[k] = o
    } else if (e === 'number') {
      const n = Number(text.trim())
      if (!text.trim() || !Number.isFinite(n)) return { ok: false, error: `"${k}" is a number` }
      next[k] = n
    } else if (e === 'boolean') {
      if (text !== 'true' && text !== 'false') return { ok: false, error: `"${k}" is true or false` }
      next[k] = text === 'true'
    } else if (e === 'list') {
      next[k] = text.split(',').map((x) => x.trim()).filter(Boolean)
    } else if (e === 'json') {
      try {
        next[k] = JSON.parse(text) as unknown
      } catch {
        return { ok: false, error: `"${k}" isn't valid JSON` }
      }
    } else next[k] = text
  }
  return { ok: true, args: next }
}
