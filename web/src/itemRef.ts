/**
 * How a work item's home reads on a row, which glyph it draws, and what a
 * hand-off starts on it. Pure, built on shared/sources.ts; refOf and
 * playbookOf are re-exported from refs.ts, glyphOf feeds itemUi's kindIcon.
 * Kept free of the client stores and React so the node tests can load it.
 */
import type { ScoredItem } from '../../shared/protocol.js'
import { sourceOf, type SourceIcon } from '../../shared/sources.js'

/**
 * "acme/web#3312" for a GitHub PR, "Sentry · acme-web" for a source Junior
 * doesn't know by name, else the item's home. The label goes first so an
 * ellipsis cuts the place, never the name.
 */
export function refOf(i: Pick<ScoredItem, 'id' | 'source' | 'repo'>): string {
  const d = sourceOf(i.source)
  if (d.id === 'github') {
    const m = /#(\d+)$/.exec(i.id)
    if (m) return `${i.repo}#${m[1]}`
  }
  if (!d.known && i.source) return i.repo ? `${d.label} · ${i.repo}` : d.label
  return i.repo
}

/** The playbook a hand-off starts: the suggestion's, else a reply where the source has a reply route, a fix for a bug, else a look into it. */
export function playbookOf(i: Pick<ScoredItem, 'suggestion' | 'reason' | 'source' | 'label'>): string {
  return i.suggestion?.playbook ?? (i.reason === 'asked' && sourceOf(i.source).canReply ? 'answer' : i.label === 'bug' ? 'debug-fix' : 'investigate')
}

/** Which glyph a row draws: a source's own icon key, or one of the kind glyphs. */
export type ItemGlyph = SourceIcon | 'alert' | 'book' | 'calendar'

/**
 * Trouble first, then where the item lives. A source Junior doesn't know by
 * name beats the job-hit Radar: every such item came from a job, so the Radar
 * says nothing there, and the glyph should say where the item lives.
 */
export function glyphOf(item: Pick<ScoredItem, 'source' | 'kind' | 'ciFailing'>): ItemGlyph {
  if (item.ciFailing) return 'alert'
  const src = sourceOf(item.source)
  if (!src.known) return src.icon
  if (item.kind === 'job-hit') return 'radar'
  if (item.kind === 'digest') return 'book'
  if (item.kind === 'ticket-assigned') return 'ticket'
  if (src.id === 'manual') return item.kind === 'manual' ? 'todo' : 'calendar'
  return src.icon
}
