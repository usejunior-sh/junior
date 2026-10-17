/**
 * Skill and agent files (SKILL.md, agents/<name>.md) as text: a YAML-ish
 * frontmatter block, then the prompt. Other tools write these by hand, so the
 * reader is lenient, block scalars (`description: >`), quoted strings, lists,
 * and the writer is surgical: setting one field rewrites only that key's lines,
 * so keys triage doesn't know (allowed-tools, metadata, hooks…) and the
 * author's formatting survive an edit from the settings form.
 *
 * Shared by the server (listing) and the web (the editor). Dependency-free.
 */

type Split = { head: string[]; body: string; nl: string } | null

/** The frontmatter lines between the `---` fences, and everything after; null when there's no block. */
function split(text: string): Split {
  const nl = text.startsWith('---\r\n') ? '\r\n' : '\n'
  if (!text.startsWith('---' + nl)) return null
  const lines = text.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { head: lines.slice(1, i), body: lines.slice(i + 1).join(nl), nl }
  }
  return null
}

const KEY_RE = /^([A-Za-z_][\w-]*)\s*:(.*)$/

const unquote = (v: string): string => {
  const t = v.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

/** Where key `i`'s value ends: the next line that isn't indented (or blank inside the block). */
function blockEnd(head: string[], i: number): number {
  let j = i + 1
  while (j < head.length && (head[j].trim() === '' || /^\s/.test(head[j]))) j++
  // trailing blank lines belong to no one
  while (j > i + 1 && head[j - 1].trim() === '') j--
  return j
}

/** Every top-level key as a plain string, lists joined with ", ", block scalars folded or kept. */
export function readFields(text: string): Record<string, string> {
  const s = split(text)
  if (!s) return {}
  const out: Record<string, string> = {}
  for (let i = 0; i < s.head.length; i++) {
    const m = KEY_RE.exec(s.head[i])
    if (!m) continue
    const end = blockEnd(s.head, i)
    const rest = m[2].trim()
    const more = s.head.slice(i + 1, end)
    if (/^[|>][-+]?$/.test(rest)) {
      const lines = more.map((l) => l.replace(/^\s+/, ''))
      out[m[1]] = (rest.startsWith('|') ? lines.join('\n') : lines.join(' ').replace(/\s+/g, ' ')).trim()
    } else if (rest === '' && more.length && more.every((l) => /^\s+-\s/.test(l) || !l.trim())) {
      out[m[1]] = more.filter((l) => l.trim()).map((l) => unquote(l.replace(/^\s+-\s/, ''))).join(', ')
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      out[m[1]] = rest.slice(1, -1).split(',').map(unquote).filter(Boolean).join(', ')
    } else if (rest === '' && more.length) {
      // a nested map (metadata:), not a value the form edits
      out[m[1]] = ''
    } else {
      // a plain scalar may run on over indented lines
      out[m[1]] = [unquote(rest), ...more.map((l) => l.trim())].filter(Boolean).join(' ')
    }
    i = end - 1
  }
  return out
}

/** The prompt: everything after the frontmatter (or the whole file when there is none). */
export function bodyOf(text: string): string {
  return split(text)?.body.replace(/^\r?\n/, '') ?? text
}

const NEEDS_QUOTES = /^$|^[\s"'[\]{}#&*!|>%@`,?-]|: | #|\s$|^(true|false|null|yes|no|~)$/i
const yamlScalar = (v: string): string => (NEEDS_QUOTES.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v)

/**
 * Set (or with null/'' remove) one top-level key, leaving every other line as
 * written. A multi-line value goes in as a `|` block; a new key goes last.
 */
export function setField(text: string, key: string, value: string | null): string {
  const s = split(text) ?? { head: [], body: text, nl: '\n' }
  const head = [...s.head]
  const v = value?.replace(/\r\n/g, '\n').trim() ?? ''
  const lines = !v ? [] : v.includes('\n') ? [`${key}: |`, ...v.split('\n').map((l) => (l ? `  ${l}` : ''))] : [`${key}: ${yamlScalar(v)}`]
  const at = head.findIndex((l) => KEY_RE.exec(l)?.[1] === key)
  if (at >= 0) head.splice(at, blockEnd(head, at) - at, ...lines)
  else if (lines.length) {
    let end = head.length
    while (end > 0 && head[end - 1].trim() === '') end--
    head.splice(end, 0, ...lines)
  }
  return ['---', ...head, '---', s.body].join(s.nl)
}

/** Replace the prompt, keeping the frontmatter exactly as it is. */
export function setBody(text: string, body: string): string {
  const s = split(text)
  if (!s) return body
  // keep the blank line after the fence if the file had one
  const gap = /^\r?\n/.test(s.body) ? s.nl : ''
  return ['---', ...s.head, '---', gap + body].join(s.nl)
}

/** A file name from a label: lowercase words joined by dashes. */
export const slugName = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
