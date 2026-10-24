/**
 * The friction capture (⌘⇧., components/FrictionCapture.tsx): what it records
 * about where you were. Pure, so tests can read it.
 *
 * A note is a manual item labelled `friction`. Its description says where it
 * was noted, and the store copies that into the row's muted reason, so it is
 * one line.
 */

/** The longest note: Quick capture's (desktop/src/capture.ts). */
export const FRICTION_MAX = 500

const PAGE_NAMES: Record<string, string> = {
  home: 'Junior',
  junior: 'Junior',
  inbox: 'Inbox',
  item: 'Item',
  session: 'Chat',
  draft: 'Chat',
  terminal: 'Terminals',
  terminals: 'Terminals',
  jobs: 'Jobs',
  job: 'Jobs',
  'job-form': 'Jobs',
  artifacts: 'Artifacts',
  artifact: 'Artifacts',
  run: 'Run',
  changes: 'Changes',
  change: 'Changes',
  goals: 'Goals',
  goal: 'Goals',
  settings: 'Settings',
}

/** A route's page as a short name, or null for a page this list doesn't know. */
export function pageName(page: string): string | null {
  return Object.hasOwn(PAGE_NAMES, page) ? PAGE_NAMES[page]! : null
}

export type FrictionWhere = {
  /** `route.page` */
  page: string
  /** `location.hash`, raw */
  hash: string
  /** the item in focus, if any */
  selected?: string | null
}

const hashOf = (h: string) => (h && h !== '#' ? h : '#/')

/** The footer's context line: `on Inbox · selected github:acme/api#412`. */
export function frictionContext(w: FrictionWhere): { place: string; selected: string | null } {
  const name = pageName(w.page)
  return { place: `on ${name ?? hashOf(w.hash)}`, selected: w.selected || null }
}

/** The item's description: `Noted on Inbox (#/inbox) · selected github:acme/api#412`. */
export function frictionDescription(w: FrictionWhere): string {
  const name = pageName(w.page)
  const where = name ? `Noted on ${name} (${hashOf(w.hash)})` : `Noted at ${hashOf(w.hash)}`
  return w.selected ? `${where} · selected ${w.selected}` : where
}

/** The line as filed: pasted newlines become spaces, trimmed, capped. Empty = nothing to file. */
export function frictionTitle(line: string): string {
  return line.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, FRICTION_MAX)
}

/**
 * A long item id, cut from the middle so its end (the PR number, the thread)
 * stays readable: `github:acme/very-long-repo…/api#412`.
 */
export function shortId(id: string, max = 44): string {
  if (id.length <= max) return id
  const tail = Math.ceil((max - 1) * 0.4)
  return `${id.slice(0, max - 1 - tail)}…${id.slice(-tail)}`
}

/** The footer's error line: the op's reason when it gave one, else Junior didn't answer. */
export function frictionError(reason: string | null | undefined): string {
  const r = reason?.trim()
  if (!r) return "Couldn't note it. Junior isn't answering."
  const said = r[0]!.toUpperCase() + r.slice(1)
  return `Couldn't note it. ${/[.!?]$/.test(said) ? said : `${said}.`}`
}
