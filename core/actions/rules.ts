/**
 * The actions file: `<workspace>/actions.md`: which Bash commands count as
 * leaving this machine, and the per-tool overrides the Actions page writes.
 * One file, so the whole claim "this is what counts" is readable at once.
 *
 * The frontmatter is the same small YAML subset team recipes use, read
 * strictly: an unknown key or kind, or a pattern that doesn't parse, is an
 * error. A bad file never crashes anything: the defaults stand in and the
 * page says why.
 */
import { parseYaml, YamlError, type YamlValue } from '../teams/recipe.js'
import { parsePattern, type BashPattern } from './bash.js'
import { isActionKind, type ActionKind } from './types.js'

export type ActionRules = {
  /** outbound Bash patterns, in file order, each with the kind it records */
  bash: Array<{ kind: ActionKind; pattern: BashPattern }>
  /** always an action: a tool's full name, `mcp__<server>__*`, or `Bash(<pattern>)` */
  action: string[]
  /** never an action: same forms */
  notAction: string[]
}

export const ACTIONS_FILE_KEYS = ['bash', 'action', 'not_action'] as const

/** What junior seeds. Edits are the user's from then on (server/actions-file.ts). */
export const DEFAULT_ACTIONS_FILE = `---
# Bash commands that leave this machine, by the kind of action they record.
# A command counts when one of its parts (split on && || ; |) starts with
# one of these. \`a|b\` = either word; a flag after the words must appear
# somewhere in the command (\`-X|--method POST\` = -X POST or --method=post),
# and a \`!\` flag must not (\`!--dry-run\`).
bash:
  pr:
    - gh pr create
  comment:
    - gh pr comment|review
    - gh issue comment
  merge:
    - gh pr merge
  update:
    - gh pr close|reopen|edit|ready
    - gh issue close|reopen|edit
  ticket:
    - gh issue create
  push:
    - git push !--dry-run|-n
  release:
    - gh release create
    - npm|pnpm|yarn|bun publish
    - cargo publish
    - vercel deploy
    - vercel --prod
    - fly|flyctl deploy
    - netlify deploy
    - wrangler deploy|publish
    - firebase deploy
  other:
    - gh api -X|--method POST|PATCH|PUT|DELETE
    # Fields make gh api POST unless a method says otherwise.
    - gh api -f|-F|--field|--raw-field|--input !-X|--method GET|HEAD
# Overrides — the Actions page's "Not an action" / "This is an action" land
# here. A tool's full name, every tool of a server (mcp__<server>__*), or
# Bash(<pattern>) for a command.
action: []
not_action:
  # Browsers and editors on this machine — driving them doesn't leave it.
  - "mcp__chrome-devtools__*"
  - "mcp__playwright__*"
  - "mcp__claude-in-chrome__*"
  - "mcp__ide__*"
---

Every outbound action a session takes is recorded on the Actions page — an
effect that leaves this machine: a PR, a comment, a ticket, a message, a push.
Connector (MCP) tools are sorted by their own annotations, then by the verbs
in their names; Bash is sorted by the list above. Built-in file tools never
count.
`

export type ParsedActionsFile = { rules: ActionRules; errors: string[] }

function splitFile(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return m ? m[1] : null
}

const isMap = (v: YamlValue): v is { [key: string]: YamlValue } => typeof v === 'object' && !Array.isArray(v)

function stringList(key: string, v: YamlValue | undefined, errors: string[]): string[] {
  if (v === undefined || v === '') return []
  if (!Array.isArray(v)) {
    errors.push(`${key}: expected a list`)
    return []
  }
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim()) errors.push(`${key}: every entry is a non-empty string`)
    else out.push(x.trim())
  }
  return out
}

/** A `Bash(<pattern>)` override entry, parsed; null when it isn't one. */
export function bashOverride(entry: string): BashPattern | string | null {
  const m = /^Bash\((.*)\)$/.exec(entry.trim())
  return m ? parsePattern(m[1]) : null
}

function checkOverrides(key: string, list: string[], errors: string[]): void {
  for (const e of list) {
    const b = bashOverride(e)
    if (typeof b === 'string') errors.push(`${key}: ${e}: ${b}`)
    else if (!b && !/^mcp__[^\s]+$/.test(e)) errors.push(`${key}: "${e}" is not a tool name (mcp__…) or Bash(…)`)
  }
}

/** The file → rules. With errors, `rules` is still usable: the parts that parsed. */
export function parseActionsFile(text: string): ParsedActionsFile {
  const errors: string[] = []
  const empty: ActionRules = { bash: [], action: [], notAction: [] }
  const yaml = splitFile(text)
  if (yaml === null) return { rules: empty, errors: ['no frontmatter: the file starts with a --- line'] }
  let doc: YamlValue
  try {
    doc = parseYaml(yaml, 2)
  } catch (err) {
    return { rules: empty, errors: [err instanceof YamlError ? err.message : String(err)] }
  }
  if (!isMap(doc)) return { rules: empty, errors: ['the frontmatter is a map of keys'] }
  for (const k of Object.keys(doc)) {
    if (!(ACTIONS_FILE_KEYS as readonly string[]).includes(k)) errors.push(`unknown key "${k}" (expected ${ACTIONS_FILE_KEYS.join(', ')})`)
  }
  const bash: ActionRules['bash'] = []
  const raw = doc.bash
  if (raw !== undefined && raw !== '') {
    if (!isMap(raw)) errors.push('bash: a map of kind → patterns')
    else {
      for (const [kind, list] of Object.entries(raw)) {
        if (!isActionKind(kind)) {
          errors.push(`bash: unknown kind "${kind}"`)
          continue
        }
        for (const line of stringList(`bash.${kind}`, list, errors)) {
          const p = parsePattern(line)
          if (typeof p === 'string') errors.push(`bash.${kind}: ${line}: ${p}`)
          else bash.push({ kind, pattern: p })
        }
      }
    }
  }
  const action = stringList('action', doc.action, errors)
  const notAction = stringList('not_action', doc.not_action, errors)
  checkOverrides('action', action, errors)
  checkOverrides('not_action', notAction, errors)
  return { rules: { bash, action, notAction }, errors }
}

/** The shipped defaults, parsed (they always parse. A test holds them to it). */
export const DEFAULT_RULES: ActionRules = parseActionsFile(DEFAULT_ACTIONS_FILE).rules

/**
 * Add or remove one entry of the `action` / `not_action` list, editing the
 * file's text in place: comments, order and every other line stay the user's.
 */
export function withOverride(text: string, key: 'action' | 'not_action', entry: string, add: boolean): string {
  const open = /^---\r?\n/.exec(text)
  const close = open ? /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(open[0].length)) : null
  if (!open || !close) return text
  const start = open[0].length
  const end = start + close.index
  const lines = text.slice(start, end).split('\n')
  const quoted = `"${entry.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const at = lines.findIndex((l) => new RegExp(`^${key}:(\\s|$)`).test(l))
  const same = (v: YamlValue) => typeof v === 'string' && v.trim() === entry

  if (at === -1) {
    if (!add) return text
    lines.push(`${key}:`, `  - ${quoted}`)
  } else {
    const inline = lines[at].slice(key.length + 1).replace(/\s+#.*$/, '').trim()
    if (inline) {
      // `key: [a, b]` → a block list we can edit line by line.
      let items: YamlValue = []
      try {
        items = parseYaml(`x: ${inline}`)
        items = isMap(items) ? (items.x ?? []) : []
      } catch {
        items = []
      }
      const list = (Array.isArray(items) ? items : []).filter((v): v is string => typeof v === 'string')
      const next = add ? (list.some(same) ? list : [...list, entry]) : list.filter((v) => !same(v))
      lines.splice(at, 1, next.length ? `${key}:` : `${key}: []`, ...next.map((v) => `  - "${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`))
    } else {
      // The block under the key: indented lines up to the next top-level key.
      let last = at
      const hits: number[] = []
      for (let i = at + 1; i < lines.length; i++) {
        const l = lines[i]
        if (l.trim() && !/^\s/.test(l)) break
        const m = /^\s+-\s+(.*)$/.exec(l)
        if (m) {
          last = i
          try {
            const v = parseYaml(`x: ${m[1]}`)
            if (isMap(v) && same(v.x ?? '')) hits.push(i)
          } catch {}
        }
      }
      if (add) {
        if (!hits.length) lines.splice(last + 1, 0, `  - ${quoted}`)
      } else {
        for (const i of hits.reverse()) lines.splice(i, 1)
        // The last entry gone: say so, rather than leave a key with nothing under it.
        let left = false
        for (let i = at + 1; i < lines.length && !(lines[i].trim() && !/^\s/.test(lines[i])); i++) {
          if (/^\s+-\s/.test(lines[i])) left = true
        }
        if (!left) lines[at] = `${key}: []`
      }
    }
  }
  return text.slice(0, start) + lines.join('\n') + text.slice(end)
}
