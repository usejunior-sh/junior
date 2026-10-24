/**
 * How a job files what it finds (M4): why each item is here (reason), what
 * it may be (labels), and the three tiers, so a Sentry or Linear job works
 * like a built-in and the rules (core/rules) can act on what it files.
 *
 *   reason: found                  one reason for every row, or a list the run picks from
 *   labels: [bug, improvement]     the labels the run may pick per row; omitted = any
 *   start_alone: [...]             what Junior may start on alone (plain words)
 *   only_show: [...]               what is filed for you to see, nothing started
 *   ignore: [...]                  what is never filed
 *
 * The tiers are plain-English lists, read by the run; the run tags each row
 * "start" or "show", and code holds "show" rows back from starting alone.
 *
 * Pure and browser-safe.
 */
import { isItemLabel, isReason, ITEM_LABELS, type ItemLabel, type Reason } from '../work/fields.js'

export type JobFiling = {
  /** the reasons a row may carry; the first is the default */
  reasons: Reason[]
  /** the labels a row may carry; empty = any */
  labels: ItemLabel[]
  tiers?: { start: string[]; show: string[]; ignore: string[] }
}

export const DEFAULT_FILING: JobFiling = { reasons: ['found'], labels: [] }

/** The labels a job may file under: all but `friction`, which only you file (the ⌘⇧. capture). */
export const JOB_LABELS: readonly ItemLabel[] = ITEM_LABELS.filter((l) => l !== 'friction')
const isJobLabel = (v: unknown): v is ItemLabel => isItemLabel(v) && JOB_LABELS.includes(v)

/** Reasons a job may file under: the ones a scanner can't (your PRs and review requests are GitHub's). */
export const JOB_REASONS: readonly Reason[] = ['asked', 'assigned', 'mentioned', 'found']

export const FILING_KEYS = ['reason', 'labels', 'start_alone', 'only_show', 'ignore'] as const

type Raw = string | string[] | undefined
const list = (v: Raw): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((s) => s.trim()).filter(Boolean)

/** The filing keys of a job file's frontmatter → the filing, plus what is wrong with it. */
export function filingFrom(d: Partial<Record<(typeof FILING_KEYS)[number], Raw>>, errors: string[]): JobFiling | undefined {
  const reasons: Reason[] = []
  for (const r of list(d.reason)) {
    if (!isReason(r) || !JOB_REASONS.includes(r)) errors.push(`reason: "${r}" is not one of ${JOB_REASONS.join(', ')}`)
    else if (!reasons.includes(r)) reasons.push(r)
  }
  const labels: ItemLabel[] = []
  for (const l of list(d.labels)) {
    if (l === 'friction') errors.push(`labels: friction is yours to file, not a job's`)
    else if (!isItemLabel(l)) errors.push(`labels: "${l}" is not one of ${JOB_LABELS.join(', ')}`)
    else if (!labels.includes(l)) labels.push(l)
  }
  const start = list(d.start_alone)
  const show = list(d.only_show)
  const ignore = list(d.ignore)
  const tiers = start.length || show.length || ignore.length ? { start, show, ignore } : undefined
  if (!reasons.length && !labels.length && !tiers) return undefined
  return { reasons: reasons.length ? reasons : ['found'], labels, ...(tiers ? { tiers } : {}) }
}

/** The filing → frontmatter keys, only what differs from the default. */
export function filingKeys(f: JobFiling | undefined): Record<string, string | string[]> {
  if (!f) return {}
  const out: Record<string, string | string[]> = {}
  if (f.reasons.length > 1) out.reason = f.reasons
  else if (f.reasons[0] && f.reasons[0] !== 'found') out.reason = f.reasons[0]
  if (f.labels.length) out.labels = f.labels
  if (f.tiers?.start.length) out.start_alone = f.tiers.start
  if (f.tiers?.show.length) out.only_show = f.tiers.show
  if (f.tiers?.ignore.length) out.ignore = f.tiers.ignore
  return out
}

/** Stored JSON → filing; anything off reads as none. */
export function filingFromJson(raw: string | null | undefined): JobFiling | undefined {
  if (!raw) return undefined
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const t = (o.tiers ?? null) as Record<string, unknown> | null
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const reasons = strs(o.reasons).filter(isReason)
    return {
      reasons: reasons.length ? reasons : ['found'],
      labels: strs(o.labels).filter(isJobLabel),
      ...(t ? { tiers: { start: strs(t.start), show: strs(t.show), ignore: strs(t.ignore) } } : {}),
    }
  } catch {
    return undefined
  }
}

/** The labels a row may pick from. */
export function labelsOf(f: JobFiling | undefined): readonly ItemLabel[] {
  const mine = f?.labels.filter(isJobLabel) ?? []
  return mine.length ? mine : JOB_LABELS
}

const REASON_HELP: Record<Reason, string> = {
  asked: 'asked: someone asks the user something and waits on their answer',
  assigned: 'assigned: the work is the user\'s to do (a ticket or task on them)',
  mentioned: 'mentioned: the user is named or tagged, nothing is asked of them',
  found: 'found: it matched the instructions, nobody is waiting on the user',
  'your-pr': '',
  'review-requested': '',
  'you-added': '',
}

const LABEL_HELP: Record<ItemLabel, string> = {
  bug: 'bug: something is broken or erroring',
  improvement: 'improvement: something works and could work better',
  question: 'question: someone wants an answer or an explanation',
  feature: 'feature: something new to build',
  idea: 'idea: a thought worth keeping, no work asked yet',
  // never offered to a run (JOB_LABELS leaves it out); here for the Record
  friction: '',
}

/** What the run prompt adds for a job's filing: the reason, label and tier to give each row. */
export function filingPrompt(f: JobFiling | undefined): string {
  const lines: string[] = []
  const reasons = f?.reasons ?? DEFAULT_FILING.reasons
  if (reasons.length > 1) lines.push(`- reason: why it is here, pick exactly one:\n${reasons.map((r) => `  - ${REASON_HELP[r]}`).join('\n')}`)
  lines.push(`- label: what it is, pick exactly one:\n${labelsOf(f).map((l) => `  - ${LABEL_HELP[l]}`).join('\n')}`)
  if (f?.tiers) {
    const t = f.tiers
    lines.push(
      `- tier: "start" when it is something Junior may start working on alone, "show" when it is only for the user to see. Decide by these lists:${t.start.length ? `\n  start: ${t.start.join('; ')}` : ''}${t.show.length ? `\n  show: ${t.show.join('; ')}` : ''}\n  Anything in neither list is "show".`,
    )
    if (t.ignore.length) lines.push(`Never file anything matching: ${t.ignore.join('; ')}.`)
  }
  return lines.join('\n')
}
