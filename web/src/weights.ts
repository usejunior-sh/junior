/**
 * Score weights on the client (core/work/weights.ts, /api/score-weights): the
 * list behind Junior's notebook and the reason chip's corrections. One shared
 * copy: loaded when something that shows it mounts, refreshed after our own
 * set or clear and on `inbox_changed` (a set or clear elsewhere sends one).
 */
import { useEffect, useState } from 'react'
import type { ScoreWeightsResponse, ScoreWeightView } from '../../shared/protocol.js'
import { store } from './store.js'

type State = { weights: ScoreWeightView[] | null; error: string | null }

let state: State = { weights: null, error: null }
const subs = new Set<(s: State) => void>()
let offInbox: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | undefined

const emit = (next: State) => {
  state = next
  for (const fn of subs) fn(state)
}

async function load(): Promise<void> {
  try {
    const body = (await (await fetch('/api/score-weights')).json()) as ScoreWeightsResponse
    if (body.ok) emit({ weights: body.weights, error: null })
    else emit({ ...state, error: body.error })
  } catch (err) {
    // offline: keep the last list, say why only when there's none
    if (!state.weights) emit({ ...state, error: String(err) })
  }
}

/** Every live weight, newest first; null until the first load. `error` when the load failed. */
export function useWeights(): State {
  const [s, setS] = useState<State>(state)
  useEffect(() => {
    subs.add(setS)
    if (!offInbox)
      offInbox = store.onInboxChanged(() => {
        clearTimeout(timer)
        timer = setTimeout(() => void load(), 300)
      })
    void load()
    return () => {
      subs.delete(setS)
      if (!subs.size && offInbox) {
        offInbox()
        offInbox = null
        clearTimeout(timer)
      }
    }
  }, [])
  return s
}

export type WeightAnswer = { ok: true; weight?: ScoreWeightView } | { ok: false; error: string }

async function post(path: string, body: unknown): Promise<WeightAnswer> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const b = (await res.json()) as ScoreWeightsResponse
    if (!b.ok) return { ok: false, error: b.error }
    emit({ weights: b.weights, error: null })
    return { ok: true, ...(b.weight ? { weight: b.weight } : {}) }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** Set (or renew) a weight. The answer's `weight.label` is the signed line to say: "+20 you said @priya matters". */
export const setWeight = (w: { key: string; delta: number; reason?: string }) => post('/api/score-weights', w)
export const clearWeight = (key: string) => post('/api/score-weights/clear', { key })
