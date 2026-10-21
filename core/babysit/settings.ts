/**
 * Babysitting's settings, per workspace (Settings → Babysit): on or off, the
 * model per kind of task, and the money it may spend. Stored in config under
 * `babysit.settings`; anything missing or invalid reads as the default.
 */

export type BabysitSettings = {
  enabled: boolean
  models: {
    /** CI and bot-comment fixes */
    fix: string
    /** rebases and re-checks */
    rebase: string
  }
  budget: {
    /** one task's session stops past this */
    perTaskUsd: number
    /** past this, the queue pauses until tomorrow or until you raise it */
    perDayUsd: number
  }
  /** tasks running at once, across PRs */
  maxRunning: number
}

export const BABYSIT_SETTINGS_KEY = 'babysit.settings'

export const DEFAULT_BABYSIT: BabysitSettings = {
  enabled: false,
  models: { fix: 'opus', rebase: 'sonnet' },
  budget: { perTaskUsd: 3, perDayUsd: 20 },
  maxRunning: 2,
}

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
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    models: { fix: model(m.fix, d.models.fix), rebase: model(m.rebase, d.models.rebase) },
    budget: { perTaskUsd: usd(b.perTaskUsd, d.budget.perTaskUsd), perDayUsd: usd(b.perDayUsd, d.budget.perDayUsd) },
    maxRunning: running,
  }
}

/** The model a task's step runs on. */
export function modelFor(step: string | undefined, s: BabysitSettings): string {
  return step === 'rebase' ? s.models.rebase : s.models.fix
}
