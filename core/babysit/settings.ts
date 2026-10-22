/**
 * Babysitting's settings, per workspace (Settings → Automations): the model per
 * kind of task, and the money it may spend. First-pass reviews of PRs that ask
 * for yours (core/review) share the runner, so they live here too. Each watch
 * has its own switch (Settings → Automations, `watchesOn` in server/settings-ops.ts),
 * and either way Junior works only the PRs you hand it (core/work/handoff.ts). Stored
 * in config under `babysit.settings`; anything missing or invalid reads as the
 * default.
 */

export type BabysitSettings = {
  models: {
    /** CI and bot-comment fixes */
    fix: string
    /** rebases and re-checks */
    rebase: string
    /** first-pass reviews */
    review: string
  }
  budget: {
    /** one task's session stops past this */
    perTaskUsd: number
    /** past this, the queue pauses until tomorrow or until you raise it */
    perDayUsd: number
    /** one first-pass review stops past this */
    perReviewUsd: number
  }
  /** tasks running at once, across PRs */
  maxRunning: number
}

export const BABYSIT_SETTINGS_KEY = 'babysit.settings'

export const DEFAULT_BABYSIT: BabysitSettings = {
  models: { fix: 'opus', rebase: 'sonnet', review: 'sonnet' },
  budget: { perTaskUsd: 3, perDayUsd: 20, perReviewUsd: 1 },
  maxRunning: 2,
}

import { isItemStep, ITEM_STEP_RUN } from '../playbooks/item.js'

const MODEL_RE = /^[\w.\-[\]]{1,80}$/

type J = Record<string, unknown>
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const model = (v: unknown, d: string) => (typeof v === 'string' && MODEL_RE.test(v) ? v : d)
const usd = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1000 ? v : d)

/** Stored or posted settings → valid settings, defaults where anything is off. */
export function babysitSettingsFrom(raw: unknown): BabysitSettings {
  const r = obj(raw)
  const m = obj(r.models)
  const b = obj(r.budget)
  const d = DEFAULT_BABYSIT
  const running = typeof r.maxRunning === 'number' && Number.isInteger(r.maxRunning) && r.maxRunning >= 1 && r.maxRunning <= 4 ? r.maxRunning : d.maxRunning
  return {
    models: { fix: model(m.fix, d.models.fix), rebase: model(m.rebase, d.models.rebase), review: model(m.review, d.models.review) },
    budget: { perTaskUsd: usd(b.perTaskUsd, d.budget.perTaskUsd), perDayUsd: usd(b.perDayUsd, d.budget.perDayUsd), perReviewUsd: usd(b.perReviewUsd, d.budget.perReviewUsd) },
    maxRunning: running,
  }
}

/** The model a task's step runs on. */
export function modelFor(step: string | undefined, s: BabysitSettings): string {
  if (isItemStep(step)) return ITEM_STEP_RUN[step!]!.model
  return step === 'rebase' ? s.models.rebase : step === 'review' ? s.models.review : s.models.fix
}

/** One task's cap, in USD. */
export function capFor(step: string | undefined, s: BabysitSettings): number {
  if (isItemStep(step)) return ITEM_STEP_RUN[step!]!.capUsd
  return step === 'review' ? s.budget.perReviewUsd : s.budget.perTaskUsd
}

