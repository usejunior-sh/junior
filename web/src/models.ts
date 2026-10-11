/**
 * The model catalog, as the server probed it from Claude Code itself, plus
 * what the user did to it: models hidden from the pickers and ids typed in by
 * hand (both per workspace, in /api/settings).
 *
 * One store per page load, shared by every picker: the list is a property of
 * the machine, not of a composer. A failed probe is never remembered — it
 * retries on a backoff and on demand, and meanwhile the last good list (kept
 * in localStorage) stands in, so a flaky probe cannot empty the picker.
 */
import { useSyncExternalStore } from 'react'
import type { EffortLevel, ModelOption, ModelsResponse, SettingsResponse, WorkspaceSettings } from '../../shared/protocol.js'

export type ModelsStatus = 'loading' | 'ready' | 'error'

type State = {
  catalog: ModelOption[]
  hidden: string[]
  custom: string[]
  status: ModelsStatus
  error?: string
}

const LAST_GOOD_KEY = 'triage.models.lastGood'
const RETRY_MS = [3_000, 10_000, 30_000]

function readLastGood(): ModelOption[] {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_GOOD_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? (v as ModelOption[]) : []
  } catch {
    return []
  }
}

let state: State = { catalog: readLastGood(), hidden: [], custom: [], status: 'loading' }
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null
let retries = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined

function set(next: Partial<State>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

async function fetchCatalog(refresh: boolean): Promise<ModelOption[]> {
  const r = await fetch(refresh ? '/api/models?refresh=1' : '/api/models')
  const b = (await r.json()) as ModelsResponse
  if (!b.ok) throw new Error(b.error)
  if (b.models.length === 0) throw new Error('Claude Code reported no models')
  return b.models
}

async function fetchPrefs(): Promise<Pick<State, 'hidden' | 'custom'> | null> {
  try {
    const b = (await (await fetch('/api/settings')).json()) as SettingsResponse
    return b.ok ? { hidden: b.settings.hiddenModels, custom: b.settings.customModels } : null
  } catch {
    return null
  }
}

/** Ask the server again. `refresh` also makes it re-probe Claude Code instead of answering from its cache. */
export function reloadModels(refresh = false): Promise<void> {
  if (inFlight) return inFlight
  clearTimeout(retryTimer)
  if (state.catalog.length === 0) set({ status: 'loading' })
  inFlight = (async () => {
    const [catalog, prefs] = await Promise.all([fetchCatalog(refresh).catch((e: unknown) => e as Error), fetchPrefs()])
    if (Array.isArray(catalog)) {
      retries = 0
      try {
        localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(catalog))
      } catch {
        /* storage full or blocked — the list still works this load */
      }
      set({ catalog, ...(prefs ?? {}), status: 'ready', error: undefined })
    } else {
      set({ ...(prefs ?? {}), status: 'error', error: String(catalog.message ?? catalog) })
      if (retries < RETRY_MS.length) retryTimer = setTimeout(() => void reloadModels(), RETRY_MS[retries++])
    }
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Save the user's hide-list and custom ids; the pickers follow immediately. */
export async function saveModelPrefs(patch: Partial<Pick<WorkspaceSettings, 'hiddenModels' | 'customModels'>>): Promise<string | null> {
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const b = (await res.json()) as SettingsResponse
    if (!b.ok) return b.error
    set({ hidden: b.settings.hiddenModels, custom: b.settings.customModels })
    return null
  } catch (e) {
    return String(e)
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  if (listeners.size === 1 && state.status === 'loading') void reloadModels()
  return () => listeners.delete(fn)
}
const snapshot = () => state

export function useModelStore(): State {
  return useSyncExternalStore(subscribe, snapshot)
}

/** A model typed by hand, shaped like a probed one. */
const customOption = (id: string): ModelOption => ({ id, name: id, description: 'Custom model id', efforts: [] })

/** The catalog plus custom ids the catalog doesn't already know. */
function withCustom(catalog: ModelOption[], custom: string[]): ModelOption[] {
  const extra = custom.filter((id) => !findModel(catalog, id)).map(customOption)
  return extra.length ? [...catalog, ...extra] : catalog
}

const merged = (() => {
  let last: { catalog: ModelOption[]; custom: string[]; out: ModelOption[] } | null = null
  return (s: State): ModelOption[] => {
    if (last && last.catalog === s.catalog && last.custom === s.custom) return last.out
    const out = withCustom(s.catalog, s.custom)
    last = { catalog: s.catalog, custom: s.custom, out }
    return out
  }
})()

/** Every model there is — hidden ones included — for looking a session's model up by id. */
export function useModels(): ModelOption[] {
  return merged(useModelStore())
}

/**
 * What a picker offers: everything not hidden. The model already in use stays
 * in the list even when hidden, so a picker never contradicts its own session.
 */
export function usePickableModels(current?: string): ModelOption[] {
  const s = useModelStore()
  const all = merged(s)
  const hidden = new Set(s.hidden)
  const keep = findModel(all, current)
  return all.filter((m) => !hidden.has(m.id) || m === keep)
}

/**
 * The row a model string belongs to. An exact id wins over an alias that
 * merely resolves to it, so an explicit pick of `sonnet` highlights Sonnet
 * rather than the Default row that happens to point at the same wire model.
 */
export function findModel(models: ModelOption[], id: string | undefined): ModelOption | undefined {
  if (!id) return undefined
  return models.find((m) => m.id === id) ?? models.find((m) => m.resolvedModel === id)
}

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** A stored effort string is only usable if it is still a level we know. */
export const isEffort = (v: unknown): v is EffortLevel => typeof v === 'string' && v in EFFORT_LABEL
