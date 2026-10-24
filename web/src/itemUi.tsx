/**
 * Shared vocabulary for rendering a work item: the glyph for its source, the
 * short label for its kind, priority names, group headings, relative time.
 * The Queue panel, the inbox cards and the item page all read from here so an
 * item looks like itself everywhere.
 */
import {
  BookOpen,
  CalendarDays,
  CircleAlert,
  GitPullRequest,
  Globe,
  Hash,
  ListTodo,
  Plug,
  Radar,
  Ticket,
  type LucideProps,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { Group, ScoredItem } from '../../shared/protocol.js'
import { ASKS, isAsk } from '../../core/work/asks.js'
import { glyphOf, type ItemGlyph } from './itemRef.js'

export { ASKS, ASK_ORDER, countOf, type Ask } from '../../core/work/asks.js'

/** A label's display name; an unknown one reads as Read, as it ranks. */
export function askName(label: string | undefined): string {
  return isAsk(label) ? ASKS[label].name : ASKS.read.name
}

export const KIND_LABEL: Record<string, string> = {
  'review-requested': 'review requested',
  'reply-needed': 'changes requested',
  'own-pr-approved': 'approved · merge',
  'own-pr-conflicting': 'conflicts',
  'own-pr-stale': 'stale PR',
  'own-pr-open': 'your PR',
  mention: 'mention',
  'slack-reply-pending': 'reply pending',
  'slack-mention': 'mentioned',
  'ticket-assigned': 'ticket',
  'job-hit': 'job match',
  digest: 'digest',
  manual: 'to-do',
  promise: 'promise',
  fyi: 'fyi',
}

/** Brief types (server/briefs.ts BRIEF_TYPES): playbooks picked by what the brief is, for any kind. */
export const BRIEF_TYPE_LABEL: Record<string, string> = {
  plan: 'Plan',
  overview: 'Overview',
  'pr-summary': 'PR summary',
}

export const playbookLabel = (name: string): string => BRIEF_TYPE_LABEL[name] ?? KIND_LABEL[name] ?? name

export const PRIORITY_LABEL: Record<number, string> = { 0: 'none', 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' }
export const PRIORITY_VALUES = [0, 1, 2, 3, 4]

/** Page headings, with the one-line reason the group exists. */
export const GROUP_TITLE: Record<Group, string> = {
  blocking: 'Blocking · people are waiting on you',
  'blocked-stale': 'Your work · gone quiet',
  cycle: 'Your cycle',
  fyi: 'FYI',
}

/**
 * The Lucide glyph for each glyph key. A full Record, so a new icon key in
 * shared/sources.ts is a compile error here until it gets a glyph. `dot`, the
 * neutral source, draws the connector glyph: a literal dot is too small to see
 * and reads as a status.
 */
const GLYPH: Record<ItemGlyph, ComponentType<LucideProps>> = {
  pr: GitPullRequest,
  hash: Hash,
  ticket: Ticket,
  globe: Globe,
  radar: Radar,
  todo: ListTodo,
  dot: Plug,
  alert: CircleAlert,
  book: BookOpen,
  calendar: CalendarDays,
}

/** The row's glyph; the rule is glyphOf in itemRef.ts. */
export function kindIcon(item: Pick<ScoredItem, 'source' | 'kind' | 'ciFailing'>): ComponentType<LucideProps> {
  return GLYPH[glyphOf(item)]
}

/** The dot beside a row/card: red for failing CI, yellow for urgent/high, else none. */
export function itemTone(item: ScoredItem): 'red' | 'yellow' | null {
  if (item.ciFailing || item.kind === 'own-pr-conflicting') return 'red'
  if ((item.priority ?? 0) === 1 || (item.priority ?? 0) === 2) return 'yellow'
  return null
}

/**
 * The inbox row's gutter bar carries priority and nothing else. One channel,
 * read down the page, never also printed as a pill. Trouble with the *item*
 * (failing CI, conflicts) colours the kind glyph instead, so the two signals
 * never compete for the same 3px.
 */
export function priorityClass(item: Pick<ScoredItem, 'priority'>): string {
  const p = item.priority ?? 0
  return p > 0 ? `p${p}` : ''
}

export function relTime(input: number | string | undefined | null): string {
  if (input == null) return '—'
  const ms = typeof input === 'string' ? Date.parse(input) : input
  if (!Number.isFinite(ms)) return '—'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * The ledger's age cell: always one compact token so the column stays a
 * column. `relTime` widens to a locale date past two weeks ("28 Aug"), which
 * overflows a narrow cell and makes the column read ragged; the exact
 * timestamp lives in the cell's tooltip instead.
 */
export function shortAge(input: number | string | undefined | null): string {
  if (input == null) return ''
  const ms = typeof input === 'string' ? Date.parse(input) : input
  if (!Number.isFinite(ms)) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`
  if (s < 86400 * 365) return `${Math.round(s / 604800)}w`
  return `${Math.round(s / 31536000)}y`
}

/** "3h ago" / "just now": relTime with the suffix handled. */
export function ago(input: number | string | undefined | null): string {
  const r = relTime(input)
  return r === 'just now' || r === '—' ? r : `${r} ago`
}

