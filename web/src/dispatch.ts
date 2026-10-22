/**
 * The opening message a dispatched work item puts in front of Claude. Shared
 * by the inbox's Dispatch button and the draft composer's starters, so an
 * item reads the same however it reaches a session.
 */
import type { ScoredItem } from '../../shared/protocol.js'

export function dispatchPrompt(item: ScoredItem): string {
  const lines =
    item.source === 'manual'
      ? [
          'Work item from the junior inbox — a to-do you added:',
          item.title,
          ...(item.url ? [item.url] : []),
          ...(item.why ? [`Note: ${item.why}`] : []),
        ]
      : [
          `Work item from the junior inbox — ${item.kind}:`,
          item.title,
          item.url,
          `Why it ranked: ${item.rankWhy}`,
          '',
          'Use `gh` to pull the full context (diff, comments, CI) and get started.',
        ]
  return lines.join('\n')
}

/** The session title a dispatched item gets. */
export const dispatchTitle = (item: ScoredItem) => item.title.slice(0, 80)
