/**
 * The pure parts of the Artifacts tab and the artifact page: which rows a
 * filter keeps, the `#/artifacts?session=` link, the version dropdown's label,
 * and how two versions are compared. No React and no fetches, so a node test
 * covers them (test/artifact-view.test.ts).
 */
import type { ArtifactFormat, ArtifactVersion, ArtifactWithLinks } from '../../shared/protocol.js'
import { diffLines, collapseContext, type ParsedDiff } from './diff.js'

/** The Artifacts tab's filter chips. `images` is png, jpg, gif, webp and svg; `other` is txt and json. */
export type FormatChip = 'all' | 'md' | 'html' | 'csv' | 'pdf' | 'images' | 'other'
export const FORMAT_CHIPS: readonly { id: FormatChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'md', label: 'md' },
  { id: 'html', label: 'html' },
  { id: 'csv', label: 'csv' },
  { id: 'pdf', label: 'pdf' },
  { id: 'images', label: 'images' },
  { id: 'other', label: 'other' },
]

export const chipOf = (f: ArtifactFormat): Exclude<FormatChip, 'all'> => {
  switch (f) {
    case 'md':
    case 'html':
    case 'csv':
    case 'pdf':
      return f
    case 'png':
    case 'jpg':
    case 'gif':
    case 'webp':
    case 'svg':
      return 'images'
    default:
      return 'other'
  }
}

export type AuthorFilter = 'all' | 'human' | 'model'

export type ArtifactFilter = {
  chip: FormatChip
  author: AuthorFilter
  /** a session id, or '' for every session */
  session: string
  showFinished: boolean
}

/** The session an artifact was published from: its earliest `output` link. */
export function originSession(a: Pick<ArtifactWithLinks, 'links'>): string | undefined {
  let best: { at: number; id: string } | undefined
  for (const l of a.links) {
    if (l.role !== 'output' || l.toKind !== 'session') continue
    if (!best || l.createdAt < best.at) best = { at: l.createdAt, id: l.toId }
  }
  return best?.id
}

const hasOutputTo = (a: Pick<ArtifactWithLinks, 'links'>, session: string) =>
  a.links.some((l) => l.role === 'output' && l.toKind === 'session' && l.toId === session)

/** Whether a row passes every filter but the format chip (the chips count with the rest applied). */
function passesExceptChip(a: ArtifactWithLinks, f: ArtifactFilter): boolean {
  if (f.author !== 'all' && a.author !== f.author) return false
  if (!f.showFinished && a.hidden) return false
  if (f.session && !hasOutputTo(a, f.session)) return false
  return true
}

export function filterArtifacts(rows: readonly ArtifactWithLinks[], f: ArtifactFilter): ArtifactWithLinks[] {
  return rows.filter((a) => passesExceptChip(a, f) && (f.chip === 'all' || chipOf(a.format) === f.chip))
}

/** How many rows each chip would show right now. */
export function chipCounts(rows: readonly ArtifactWithLinks[], f: ArtifactFilter): Record<FormatChip, number> {
  const out: Record<FormatChip, number> = { all: 0, md: 0, html: 0, csv: 0, pdf: 0, images: 0, other: 0 }
  for (const a of rows) {
    if (!passesExceptChip(a, f)) continue
    out.all++
    out[chipOf(a.format)]++
  }
  return out
}

/** Sessions that published at least one of these rows, the most recently active first. */
export function outputSessions(rows: readonly ArtifactWithLinks[]): string[] {
  const last = new Map<string, number>()
  for (const a of rows) {
    for (const l of a.links) {
      if (l.role !== 'output' || l.toKind !== 'session') continue
      last.set(l.toId, Math.max(last.get(l.toId) ?? 0, a.updated))
    }
  }
  return [...last.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
}

// The session filter lives in the hash so the view can be linked: `#/artifacts?session=<id>`.

/** The `session` of an artifacts hash (with or without the leading `#`), or ''. */
export function sessionFromHash(hash: string): string {
  const h = hash.replace(/^#/, '')
  if (h !== '/artifacts' && !h.startsWith('/artifacts?')) return ''
  return new URLSearchParams(h.slice(h.indexOf('?') + 1 || h.length)).get('session') ?? ''
}

/** The route (no `#`) that shows the Artifacts tab, narrowed to one session when given. */
export const artifactsRoute = (session: string): string =>
  session ? `/artifacts?${new URLSearchParams({ session })}` : '/artifacts'

/** `just now`, `2 min ago`, `3 h ago`, `4 d ago`, then a date. For the version dropdown. */
export function agoLong(ms: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - ms) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`
  if (mins < 30 * 1440) return `${Math.round(mins / 1440)} d ago`
  return new Date(ms).toLocaleDateString()
}

/**
 * One line of the dropdown: `v3 · 2 min ago · from <session>`. A version whose
 * commit names no session (a human edit) has no "from"; a session that no
 * longer exists reads "from a deleted session".
 */
export function versionLine(v: ArtifactVersion, sessionTitle: (id: string) => string | null, now: number = Date.now()): string {
  const parts = [`v${v.version}`, agoLong(v.at, now)]
  if (v.sessionId) parts.push(`from ${sessionTitle(v.sessionId) ?? 'a deleted session'}`)
  return parts.join(' · ')
}

/** The version just before `v` in a newest-first list, if the list has one. */
export function previousVersion(versions: readonly ArtifactVersion[], v: number): ArtifactVersion | undefined {
  let best: ArtifactVersion | undefined
  for (const x of versions) if (x.version < v && (!best || x.version > best.version)) best = x
  return best
}

/**
 * How two versions are compared: a text diff for formats you can read as
 * lines, an old/new swap for the ones you have to look at.
 */
export function compareMode(format: ArtifactFormat): 'text' | 'visual' {
  return format === 'md' || format === 'csv' || format === 'txt' || format === 'json' ? 'text' : 'visual'
}

/** The line diff of two texts with long unchanged runs folded away. `changed` is false when they are the same. */
export function textChanges(before: string, after: string): { diff: ParsedDiff; changed: boolean } {
  const d = diffLines(before, after)
  return { diff: { ...d, rows: collapseContext(d.rows) }, changed: d.additions + d.deletions > 0 }
}

/** JSON as an indented block; text that does not parse is shown as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** `~/…` for a path under a home folder. */
export const tilde = (p: string): string => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
