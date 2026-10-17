/**
 * The page as the agent reads it: Chrome's accessibility tree, folded into
 * indented text where every element worth acting on carries a `uid`. The uid
 * is Chrome's backendDOMNodeId, so it stays valid across snapshots for as long
 * as the element is on the page. No uid table to keep in step. The idea (not
 * the code) is chrome-devtools-mcp's.
 *
 * Pure: takes the raw `Accessibility.getFullAXTree` nodes.
 */

type AXValue = { type?: string; value?: unknown }
export type AXNode = {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  description?: AXValue
  properties?: { name: string; value: AXValue }[]
  parentId?: string
  childIds?: string[]
  backendDOMNodeId?: number
}

/** Roles that are only structure: their children are lifted, they get no line. */
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'LineBreak', 'InlineTextBox', 'group', 'Section', 'div', 'LabelText', 'paragraph'])
/** Roles worth a uid: the things an agent clicks, types into, or points at. */
const TEXT_ROLES = new Set(['StaticText', 'text'])
/** States worth printing, in this order. */
const STATES = ['focused', 'disabled', 'checked', 'pressed', 'selected', 'expanded', 'required', 'invalid', 'readonly'] as const

const MAX_TEXT = 100

const str = (v: AXValue | undefined): string => (v && v.value != null ? String(v.value) : '')
const clip = (s: string, n = MAX_TEXT) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function statesOf(n: AXNode): string[] {
  const out: string[] = []
  const props = new Map((n.properties ?? []).map((p) => [p.name, p.value?.value]))
  for (const s of STATES) {
    const v = props.get(s)
    if (v === undefined || v === false || v === 'false') continue
    if (s === 'checked' && v === 'mixed') out.push('mixed')
    else if (s === 'expanded') out.push(v ? 'expanded' : 'collapsed')
    else out.push(s)
  }
  const level = props.get('level')
  if (typeof level === 'number') out.unshift(`h${level}`)
  const url = props.get('url')
  // a link's target; the page's own URL is already in the snapshot's header
  if (typeof url === 'string' && url && !url.startsWith('javascript:') && str(n.role) !== 'RootWebArea') out.push(`→ ${clip(url, 80)}`)
  return out
}

export type Snapshot = { text: string; nodes: number; truncated: number }

/**
 * Fold the tree into text. `rootUid` scopes it to one element's subtree;
 * `maxNodes` caps the lines, with a closing note on how many were left out.
 */
export function formatSnapshot(all: AXNode[], opts: { rootUid?: number; maxNodes?: number } = {}): Snapshot {
  const maxNodes = opts.maxNodes ?? 400
  const byId = new Map(all.map((n) => [n.nodeId, n]))
  let root: AXNode | undefined
  if (opts.rootUid != null) root = all.find((n) => n.backendDOMNodeId === opts.rootUid)
  else root = all.find((n) => !n.parentId) ?? all[0]
  if (!root) return { text: opts.rootUid != null ? `uid=${opts.rootUid} is not on the page — take a fresh snapshot.` : '(empty page)', nodes: 0, truncated: 0 }

  const lines: string[] = []
  let truncated = 0

  const walk = (n: AXNode, depth: number, parentName: string) => {
    const role = str(n.role)
    const name = clip(str(n.name))
    const kids = (n.childIds ?? []).map((id) => byId.get(id)).filter((c): c is AXNode => !!c)
    const lift = n.ignored || (TRANSPARENT.has(role) && !name) || role === ''
    if (lift) {
      for (const k of kids) walk(k, depth, parentName)
      return
    }
    if (TEXT_ROLES.has(role)) {
      // Text that only repeats its parent's accessible name is noise.
      if (name && name !== parentName) {
        if (lines.length >= maxNodes) truncated += 1
        else lines.push(`${'  '.repeat(depth)}"${name}"`)
      }
      return
    }
    if (lines.length >= maxNodes) {
      truncated += 1
    } else {
      const parts = [n.backendDOMNodeId != null ? `uid=${n.backendDOMNodeId}` : '', role === 'RootWebArea' ? 'page' : role]
      if (name) parts.push(`"${name}"`)
      const value = clip(str(n.value), 80)
      if (value && value !== name) parts.push(`value="${value}"`)
      const states = statesOf(n)
      if (states.length) parts.push(`[${states.join(', ')}]`)
      lines.push(`${'  '.repeat(depth)}${parts.filter(Boolean).join(' ')}`)
    }
    for (const k of kids) walk(k, depth + 1, name)
  }
  walk(root, 0, '')

  if (truncated) lines.push(`… ${truncated} more nodes — pass a uid to snapshot just that part of the page.`)
  return { text: lines.join('\n'), nodes: lines.length, truncated }
}

/** Every uid that appears in a snapshot's text, what an agent may act on. */
export const uidsIn = (text: string): number[] => [...text.matchAll(/uid=(\d+)/g)].map((m) => Number(m[1]))
