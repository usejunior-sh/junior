/**
 * How learnings read on screen (core/junior/learnings.ts): the chat's
 * "Learned: …" footer and the Learned group in Junior's notebook. Pure, no
 * React, time is an argument, so test/learnings-ui.test.ts can pin it down.
 */
import { dropsTooMuch, LOSS_MIN_CHARS, type Learning, type LearningScope } from '../../core/junior/learnings.js'

/** A receipt as a label: where it opens, if anywhere. `hash` is an in-app route, `href` a web page. */
export type SourceView = { label: string; mono: boolean; title: string; href?: string; hash?: string }

/**
 * A source ref → what the user reads. `pr:acme/web#3235` → "PR #3235" (opens
 * GitHub), `slack:…` → "a Slack thread", `session:<id>` → "a chat",
 * `item:<id>` → "an item", `path:line` → the path in mono. Anything else: the
 * raw ref, mono. The full ref is always the title.
 */
export function sourceLabel(ref: string): SourceView {
  const r = ref.trim()
  const pr = /^(?:pr|github):([\w.-]+\/[\w.-]+)#(\d+)$/i.exec(r)
  if (pr) return { label: `PR #${pr[2]}`, mono: false, title: r, href: `https://github.com/${pr[1]}/pull/${pr[2]}` }
  const issue = /^issue:([\w.-]+\/[\w.-]+)#(\d+)$/i.exec(r)
  if (issue) return { label: `issue #${issue[2]}`, mono: false, title: r, href: `https://github.com/${issue[1]}/issues/${issue[2]}` }
  if (/^https?:\/\//i.test(r)) return { label: hostOf(r), mono: false, title: r, href: r }
  const scheme = /^([a-z][a-z0-9+-]*):(.*)$/i.exec(r)
  if (scheme) {
    const kind = scheme[1]!.toLowerCase()
    const rest = scheme[2]!.trim()
    if (kind === 'slack' || kind === 'thread') return { label: 'a Slack thread', mono: false, title: r }
    if (kind === 'linear') return { label: 'a Linear issue', mono: false, title: r }
    if (kind === 'session' && rest) return { label: 'a chat', mono: false, title: r, hash: `/${rest}` }
    if (kind === 'item' && rest) return { label: 'an item', mono: false, title: r, hash: `/item/${encodeURIComponent(rest)}` }
    if (kind === 'manual' && rest) return { label: 'an item', mono: false, title: r, hash: `/item/${encodeURIComponent(r)}` }
    if (kind === 'file' && rest) return { label: rest, mono: true, title: r }
  }
  return { label: r, mono: true, title: r }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** The receipt to name: the newest (sources are appended, the oldest drop first). */
export const latestSource = (l: Learning): string | null => l.sources.at(-1)?.ref ?? null

/** "everywhere", or the repo it holds in. */
export const scopeText = (scope: LearningScope): string => (scope === 'global' ? 'everywhere' : scope.slice('repo:'.length))

/** How long ago, short: "just now", "5m", "3h", "yesterday", "4d", "3w", "2mo". Feeds "used … ago". */
export function agoText(ms: number): string {
  const m = Math.max(0, ms) / 60_000
  if (m < 1) return 'just now'
  if (m < 60) return `${Math.round(m)}m ago`
  const h = m / 60
  if (h < 24) return `${Math.round(h)}h ago`
  const d = h / 24
  if (d < 2) return 'yesterday'
  if (d < 14) return `${Math.floor(d)}d ago`
  if (d < 60) return `${Math.floor(d / 7)}w ago`
  return `${Math.floor(d / 30)}mo ago`
}

export const usedText = (l: Learning, now: number): string => (l.lastUsedAt ? `used ${agoText(now - l.lastUsedAt)}` : 'not used yet')

/** When it entered the status it's in: what "newest first" sorts on. */
const enteredAt = (l: Learning): number =>
  (l.status === 'kept' ? l.keptAt : l.status === 'stale' ? l.staleAt : l.status === 'proposed' ? l.proposedAt : undefined) ?? l.createdAt

const RANK: Record<Learning['status'], number> = { proposed: 0, stale: 1, kept: 2, candidate: 3 }

/** The notebook's order: proposed, then stale, then kept; newest first in each. Candidates never show. */
export function notebookOrder(list: readonly Learning[]): Learning[] {
  return list
    .filter((l) => l.status !== 'candidate')
    .sort((a, b) => RANK[a.status] - RANK[b.status] || enteredAt(b) - enteredAt(a) || a.id.localeCompare(b.id))
}

/** What the chat's footer line shows for a proposal it made. */
export type FooterState = 'proposed' | 'kept' | 'stale' | 'undone'

/**
 * The footer's state, read from the notebook's list by id. Until a list loaded
 * after the proposal was made arrives, the proposal itself stands in (a list
 * from before it can't know it, so its absence there means nothing). Gone from
 * a list that should know it: forgotten (or expired), so undone.
 */
export function footerState(proposal: Learning, list: readonly Learning[] | null, loadedAt: number): { state: FooterState; learning: Learning } {
  const found = list?.find((l) => l.id === proposal.id)
  if (found) {
    const state: FooterState = found.status === 'kept' ? 'kept' : found.status === 'stale' ? 'stale' : 'proposed'
    return { state, learning: found }
  }
  const since = proposal.proposedAt ?? proposal.createdAt
  if (!list || loadedAt < since) return { state: 'proposed', learning: proposal }
  return { state: 'undone', learning: proposal }
}

/** Would this edit cut more than half? The server refuses it without `confirm`; ask first. */
export const editCutsTooMuch = (before: string, after: string): boolean => dropsTooMuch(before.trim().length, after.trim().length, LOSS_MIN_CHARS)
