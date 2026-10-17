/**
 * The brief's facts, gathered from what triage already holds: the ranked open
 * inbox (with each item's stage and turn), the job runs that ended, and how
 * many sends went out. Deterministic; time is an argument. Pure and
 * browser-safe: the server only collects the inputs.
 */
import type { Blocking, BriefFacts, Finished } from './brief.js'
import { shortRef } from './today.js'

/** What the facts read of an open, ranked item. */
export type FactItem = {
  id: string
  title: string
  source: string
  kind: string
  repo: string
  author: string
  url: string
  refs?: string[]
  peopleWaiting: number
  createdAt: string
  ingestedAt?: number
  label?: string
  jobId?: string
  flow?: { stage: string; turn: string; since: number }
}

/** A job run that ended, reduced. */
export type FactRun = { jobId: string; ok: boolean; endedAt: number; filed: number }

const SOURCE_LABEL: Record<string, string> = { github: 'GitHub', slack: 'Slack', linear: 'Linear', web: 'the web' }
const ASKS = new Set(['review', 'reply', 'decide'])

export function briefFacts(input: {
  since: number
  away: boolean
  items: readonly FactItem[]
  runs: readonly FactRun[]
  jobTitles: ReadonlyMap<string, string>
  sent: number
}): BriefFacts {
  const { since, items } = input
  // Finished: an item whose session or team ended in the window and now waits on your review.
  const finished: Finished[] = items
    .filter((i) => i.flow?.stage === 'review' && i.flow.turn === 'me' && i.flow.since >= since && i.kind !== 'own-pr-open')
    .sort((a, b) => (a.flow?.since ?? 0) - (b.flow?.since ?? 0))
    .map((i) => ({ kind: 'item', itemId: i.id, title: i.title }))

  const perJob = new Map<string, { runs: number; filed: number }>()
  for (const r of input.runs) {
    if (!r.ok || r.endedAt < since) continue
    const j = perJob.get(r.jobId) ?? { runs: 0, filed: 0 }
    j.runs++
    j.filed += r.filed
    perJob.set(r.jobId, j)
  }
  for (const [jobId, j] of perJob) {
    const title = input.jobTitles.get(jobId)
    if (title) finished.push({ kind: 'job', jobId, title, runs: j.runs, filed: j.filed })
  }

  // Came in: what arrived in the window, by where it came from. Your own to-dos didn't "come in".
  const bySource = new Map<string, number>()
  for (const i of items) {
    if (i.source === 'manual' || (i.ingestedAt ?? Date.parse(i.createdAt)) < since) continue
    const label = i.source === 'job' && i.jobId && input.jobTitles.has(i.jobId) ? `the ${input.jobTitles.get(i.jobId)} job` : SOURCE_LABEL[i.source] ?? i.source
    bySource.set(label, (bySource.get(label) ?? 0) + 1)
  }
  const arrived = [...bySource].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  // Blocking: a person, not a to-do, waits on you.
  const blocking: Blocking[] = items
    .filter((i) => i.source !== 'manual' && (i.flow?.turn ?? 'me') === 'me' && (ASKS.has(i.label ?? '') || i.peopleWaiting > 0))
    .map((i) => ({
      itemId: i.id,
      who: i.author || 'Someone',
      ask: (ASKS.has(i.label ?? '') ? i.label : 'reply') as Blocking['ask'],
      where: shortRef(i),
      since: Date.parse(i.createdAt) || 0,
    }))
    .sort((a, b) => a.since - b.since)

  return { since, away: input.away, finished, sent: input.sent, arrived, blocking }
}
