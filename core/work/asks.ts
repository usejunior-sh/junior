/**
 * Asks: what an item asks of you, in one word. Six, hardcoded: the inbox
 * reads by ask ("3 replies · 2 reviews"), not by where an item came from.
 *
 * Scanner kinds map to an ask and keep their own BASE weight and group
 * (score.ts); a job hit carries the ask its run picked (`ask`) and takes
 * the ask's weight and group, so a job that finds a real reply ranks with
 * replies instead of sinking into FYI. An `ask` that is no longer one
 * falls back to Read. `meaning` is the line the job prompt hands the model.
 */
import type { Group, ItemKind, WorkItem } from './types.js'

export type Ask = 'review' | 'reply' | 'decide' | 'do' | 'follow-up' | 'read'

/** When an ask is due by default, counted from when the item arrived. */
export type DueDefault = 'today' | 'next-workday' | 'this-week' | 'later'

export interface AskDef {
  name: string
  /** the header's count noun, one and many: "1 reply", "3 replies" */
  noun: [string, string]
  /** fed to the job prompt: how the model picks this ask */
  meaning: string
  group: Group
  /** BASE weight for a job hit with this ask */
  weight: number
  due: DueDefault
}

export const ASKS: Record<Ask, AskDef> = {
  review: {
    name: 'Review',
    noun: ['review', 'reviews'],
    meaning: 'someone asked you to review their work (a PR, a doc, a design)',
    group: 'blocking',
    weight: 90,
    due: 'today',
  },
  reply: {
    name: 'Reply',
    noun: ['reply', 'replies'],
    meaning: 'someone asked you a question or is waiting on your answer',
    group: 'blocking',
    weight: 85,
    due: 'today',
  },
  decide: {
    name: 'Decide',
    noun: ['decision', 'decisions'],
    meaning: 'a choice is waiting on you: approve, pick an option, say yes or no',
    group: 'blocking',
    weight: 80,
    due: 'today',
  },
  do: {
    name: 'Do',
    noun: ['to-do', 'to-dos'],
    meaning: 'a task is yours to do: assigned to you, or you said you would',
    group: 'cycle',
    weight: 50,
    due: 'this-week',
  },
  'follow-up': {
    name: 'Follow up',
    noun: ['follow-up', 'follow-ups'],
    meaning: 'you are waiting on someone else and may need to nudge them',
    group: 'blocked-stale',
    weight: 40,
    due: 'this-week',
  },
  read: {
    name: 'Read',
    noun: ['to read', 'to read'],
    meaning: 'worth knowing, nothing is asked of you',
    group: 'fyi',
    weight: 25,
    due: 'later',
  },
}

/** Display order: the header counts and the ask picker read this way. */
export const ASK_ORDER: Ask[] = ['review', 'reply', 'decide', 'do', 'follow-up', 'read']

export const KIND_TO_ASK: Record<ItemKind, Ask> = {
  'review-requested': 'review',
  'reply-needed': 'reply',
  'slack-reply-pending': 'reply',
  manual: 'do',
  promise: 'do',
  'ticket-assigned': 'do',
  'own-pr-conflicting': 'do',
  'own-pr-approved': 'do',
  'own-pr-stale': 'follow-up',
  'own-pr-open': 'follow-up',
  // a job hit without an ask (filed before asks, or by an external scanner)
  'job-hit': 'read',
  digest: 'read',
  mention: 'read',
  'slack-mention': 'read',
  fyi: 'read',
}

export function isAsk(v: unknown): v is Ask {
  return typeof v === 'string' && Object.hasOwn(ASKS, v)
}

/** The ask an item is filed under: a job hit's ask, else its kind's. */
export function askOf(item: Pick<WorkItem, 'kind' | 'ask'>): Ask {
  if (item.kind === 'job-hit') return isAsk(item.ask) ? item.ask : 'read'
  return KIND_TO_ASK[item.kind] ?? 'read'
}

/** "3 replies" */
export function countOf(ask: Ask, n: number): string {
  const [one, many] = ASKS[ask].noun
  return `${n} ${n === 1 ? one : many}`
}

/** The job prompt's list of asks, one per line. */
export function askGuide(): string {
  return ASK_ORDER.map((l) => `  - ${l}: ${ASKS[l].meaning}`).join('\n')
}
