/**
 * What a new session starts with, when nothing on the draft says otherwise:
 * model, effort, fast mode. A per-browser preference, the
 * draft composer writes the last pick here, the Sessions settings tab edits
 * it directly, so it lives in localStorage, not the session store.
 */
import type { EffortLevel } from '../../shared/protocol.js'
import { isEffort } from './models.js'

const MODEL_KEY = 'junior.newSession.model'
const EFFORT_KEY = 'junior.newSession.effort'
// Fast mode is stored as an explicit '1'. Anything else is off, so a stale
// or garbled value can never quietly start billing at premium rates.
const FAST_MODE_KEY = 'junior.newSession.fastMode'

export type SessionDefaults = {
  model?: string
  effort?: EffortLevel
  fastMode: boolean
}

const read = (key: string): string | undefined => localStorage.getItem(key) ?? undefined

function write(key: string, value: string | undefined) {
  if (value) localStorage.setItem(key, value)
  else localStorage.removeItem(key)
}

export function readSessionDefaults(): SessionDefaults {
  const effort = read(EFFORT_KEY)
  return {
    model: read(MODEL_KEY),
    effort: isEffort(effort) ? effort : undefined,
    fastMode: read(FAST_MODE_KEY) === '1',
  }
}

/** Persist the keys present in `patch`; `undefined` clears one. */
export function writeSessionDefaults(patch: Partial<SessionDefaults>) {
  if ('model' in patch) write(MODEL_KEY, patch.model)
  if ('effort' in patch) write(EFFORT_KEY, patch.effort)
  if ('fastMode' in patch) write(FAST_MODE_KEY, patch.fastMode ? '1' : undefined)
}
